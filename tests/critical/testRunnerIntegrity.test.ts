import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";

// Separate processes are necessary: the real runner exits after the suite.
function runFixture(source: string) {
  const bundle = buildSync({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    write: false,
    bundle: true,
    platform: "node",
    format: "cjs",
  }).outputFiles[0].text;
  const child = spawnSync(process.execPath, ["-e", bundle], {
    encoding: "utf8",
    timeout: 2000,
  });
  assert(!child.error, "Fixture process must complete");
  return { status: child.status, output: child.stdout + child.stderr };
}

test("test runner fails empty suites and detects swallowed assertions and offline fetches", () => {
  const prefix = 'import { test, runAll } from "./tests/framework/test"; ';
  const empty = runFixture(prefix + "void runAll();");
  assertEqual(empty.status, 1, "Empty suite fails");
  assert(empty.output.includes("No tests registered"), "Empty suite is identified");

  const failed = runFixture(prefix +
    'import { assert } from "./tests/framework/assert"; ' +
    'import "./tests/framework/offlineEnvironment"; ' +
    'test("caught assertion", () => { try { assert(false, "sentinel"); } catch {} }); ' +
    'test("caught fetch", async () => { try { await fetch("https://invalid.example"); } catch {} }); ' +
    'test("ordinary success", () => {}); void runAll();');
  assertEqual(failed.status, 1, "Swallowed failures must fail the process");
  assert(failed.output.includes("✗ caught assertion") && failed.output.includes("✗ caught fetch"), "Both failures attributed to their tests");
  assert(failed.output.includes("Finished: 1/3 passed."), "Failure count is truthful");

  const passed = runFixture(prefix + 'test("valid", () => {}); void runAll();');
  assertEqual(passed.status, 0, "Valid suite succeeds");
  assert(passed.output.includes("Finished: 1/1 passed."), "Success count is truthful");
});
