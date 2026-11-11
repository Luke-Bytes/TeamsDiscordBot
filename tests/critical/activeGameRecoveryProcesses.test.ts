/**
 * Process-real integration tests for the active-game snapshot lifecycle.
 * All spawned workers use disposable directories and invalid credentials.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";

const worker = path.resolve(
  process.cwd(),
  "tests/integration/activeGameRecoveryWorker.ts"
);
const compiledWorker = path.resolve(
  process.cwd(),
  "dist/tests/activeGameRecoveryWorker.js"
);
let workerBuild: Promise<void> | undefined;
function prepareWorker(): Promise<void> {
  if (!workerBuild) {
    workerBuild = build({
      entryPoints: [worker],
      outfile: compiledWorker,
      bundle: true,
      platform: "node",
      target: "node18",
      format: "cjs",
      external: ["sharp"],
      // Reuse an explicitly configured dependency tree for isolated worktrees.
      nodePaths: process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? [],
      logLevel: "silent",
    }).then(() => {});
  }
  return workerBuild;
}
const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  BOT_TOKEN: "invalid-local-recovery-test-token",
  APP_ID: "invalid-local-test-app",
  DATABASE_URL: "mongodb://127.0.0.1:1/synthetic-recovery-test",
  DATABASE_BACKUP_URL: "mongodb://127.0.0.1:1/synthetic-recovery-test",
};
delete childEnvironment.PM2_HOME;
delete childEnvironment.pm_id;
delete childEnvironment.NODE_OPTIONS;

async function isolated(testCase: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "teams-recovery-process-")
  );
  try {
    await testCase(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runWorker(
  mode: string,
  directory: string,
  killWhenReady = false
) {
  await prepareWorker();
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [compiledWorker, mode, directory], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let terminated = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (
        killWhenReady &&
        !terminated &&
        output.includes("WORKER: WRITE_INTERRUPTION_READY")
      ) {
        terminated = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`Test worker timed out mode=${mode}: ${output.slice(-1200)}`)
      );
    }, 3500);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

function expectWorker(
  result: Awaited<ReturnType<typeof runWorker>>,
  code: number,
  marker: string
) {
  assertEqual(
    result.code,
    code,
    `unexpected worker exit: ${result.output.slice(-1500)}`
  );
  assert(
    result.output.includes(marker),
    `missing ${marker}: ${result.output.slice(-1500)}`
  );
}

let completeRestartDirectory: string | undefined;
test("Real child process: preserving /restart exits 51 and publishes pending snapshot", async () => {
  completeRestartDirectory = await fs.mkdtemp(
    path.join(tmpdir(), "teams-recovery-complete-")
  );
  expectWorker(
    await runWorker("save-exit", completeRestartDirectory),
    51,
    "WORKER: PRESERVED_RESTART_PROCESS_EXIT"
  );
  assert(
    (
      await fs.readFile(
        path.join(completeRestartDirectory, "pending.json"),
        "utf8"
      )
    ).includes('"schemaVersion":1'),
    "snapshot not durably published"
  );
});

test("Real child process: a new Node process restores the game and runs normal commands", async () => {
  const directory = completeRestartDirectory;
  if (!directory) throw new Error("original restart scenario did not run");
  expectWorker(
    await runWorker("restore", directory),
    0,
    "WORKER: RESTORED_GAME_AND_COMMANDS"
  );
});

test("Real child process: a third Node process never replays a consumed snapshot", async () => {
  const directory = completeRestartDirectory;
  if (!directory) throw new Error("original restart scenario did not run");
  try {
    expectWorker(
      await runWorker("second-boot", directory),
      0,
      "WORKER: NO_DUPLICATE_REPLAY"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    completeRestartDirectory = undefined;
  }
});

test("Real child processes: concurrent preserves cannot both publish or restart", async () => {
  await isolated(async (dir) => {
    const [first, second] = await Promise.all([
      runWorker("save-exit", dir),
      runWorker("save-exit", dir),
    ]);
    const results = [first, second];
    assertEqual(
      results.filter((r) => r.code === 51).length,
      1,
      "both processes tried to restart with competing snapshots"
    );
    assertEqual(
      results.filter((r) => r.code === 1).length,
      1,
      "conflicting process was not refused"
    );
    assert(
      results.some((r) =>
        r.output.includes("WORKER: PRESERVED_RESTART_REFUSED")
      ),
      "loser did not report the conflicting pending snapshot"
    );
    const refused = results.find((r) => r.code === 1)!;
    assert(
      refused.output.includes("Unconsumed pending snapshot already exists") ||
        refused.output.includes("EEXIST"),
      `loser failed for an unexpected reason: ${refused.output.slice(-1500)}`
    );
    const pending = JSON.parse(
      await fs.readFile(path.join(dir, "pending.json"), "utf8")
    );
    assertEqual(
      pending.game.schemaVersion,
      undefined,
      "snapshot schema unexpectedly nested"
    );
    assertEqual(
      pending.schemaVersion,
      1,
      "pending file is not valid schema v1"
    );
    assertEqual(
      [
        ...pending.game.teams.RED,
        ...pending.game.teams.BLUE,
        ...pending.game.teams.UNDECIDED,
      ].length,
      20,
      "winner published incomplete roster"
    );
  });
});

test("Real child process: atomic hard-link snapshot works on the repository Windows/WSL mount", async () => {
  const runtime = path.resolve(process.cwd(), ".runtime");
  const directory = path.join(runtime, `local-recovery-test-${randomUUID()}`);
  try {
    expectWorker(
      await runWorker("filesystem-smoke", directory),
      0,
      "WORKER: MOUNTED_FILESYSTEM_ATOMIC_LINKS_OK"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Real child process: file write failure refuses restart and keeps all players", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("io-failure", dir),
      0,
      "WORKER: FAILED_SAVE_NO_EXIT"
    );
  });
});

test("Real child process: SIGKILL during incomplete file write leaves forensic temp and blocks startup", async () => {
  await isolated(async (dir) => {
    const killed = await runWorker("partial-write-kill", dir, true);
    assertEqual(killed.signal, "SIGKILL", "worker was not actually killed");
    expectWorker(
      await runWorker("orphan-startup", dir),
      0,
      "WORKER: UNSAFE_STARTUP_BLOCKED"
    );
    assert(
      (await fs.readdir(dir)).some((file) => file.startsWith(".writing-")),
      "temporary evidence missing"
    );
  });
});

test("Real child process: killed after publishing pending but before temporary cleanup still recovers", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("linked-crash", dir),
      73,
      "WORKER: PUBLISHED_PENDING_BEFORE_CLEANUP"
    );
    expectWorker(
      await runWorker("restore", dir),
      0,
      "WORKER: RESTORED_GAME_AND_COMMANDS"
    );
    expectWorker(
      await runWorker("second-boot", dir),
      0,
      "WORKER: NO_DUPLICATE_REPLAY"
    );
  });
});

test("Real child process: interrupted consumed-archive publication recovers once", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("save-exit", dir),
      51,
      "WORKER: PRESERVED_RESTART_PROCESS_EXIT"
    );
    expectWorker(
      await runWorker("archived-crash", dir),
      74,
      "WORKER: PUBLISHED_ARCHIVE_BEFORE_UNLINK"
    );
    expectWorker(
      await runWorker("restore", dir),
      0,
      "WORKER: RESTORED_GAME_AND_COMMANDS"
    );
    expectWorker(
      await runWorker("second-boot", dir),
      0,
      "WORKER: NO_DUPLICATE_REPLAY"
    );
  });
});

test("Real child process: checksum corruption blocks recovery without deleting snapshot", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("save-exit", dir),
      51,
      "WORKER: PRESERVED_RESTART_PROCESS_EXIT"
    );
    const file = path.join(dir, "pending.json");
    const original = await fs.readFile(file, "utf8");
    const corrupted = original.replace("local-test-host", "altered-test-host");
    assert(corrupted !== original, "fixture not modified");
    await fs.writeFile(file, corrupted);
    expectWorker(
      await runWorker("corrupt-startup", dir),
      0,
      "WORKER: UNSAFE_STARTUP_BLOCKED"
    );
    assertEqual(
      await fs.readFile(file, "utf8"),
      corrupted,
      "forensic snapshot changed"
    );
  });
});

test("Real child process: incompatible update blocks recovery and retains pending snapshot", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("save-exit", dir),
      51,
      "WORKER: PRESERVED_RESTART_PROCESS_EXIT"
    );
    const file = path.join(dir, "pending.json");
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    saved.schemaVersion = 999;
    await fs.writeFile(file, JSON.stringify(saved));
    expectWorker(
      await runWorker("corrupt-startup", dir),
      0,
      "WORKER: UNSAFE_STARTUP_BLOCKED"
    );
    assertEqual(
      JSON.parse(await fs.readFile(file, "utf8")).schemaVersion,
      999,
      "incompatible file discarded"
    );
  });
});

test("Real child process: completed-match recovery gate blocks active snapshot", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("match-gate", dir),
      0,
      "WORKER: COMPLETED_MATCH_GATE_RETAINED"
    );
  });
});

test("Real child process: unexpected worker failures report diagnostics to the parent", async () => {
  await isolated(async (dir) => {
    expectWorker(
      await runWorker("invalid-test-mode", dir),
      1,
      "WORKER FAILURE: Error: unknown integration mode invalid-test-mode"
    );
  });
});
