/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from "path";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { spawn } from "child_process";
import * as readline from "readline";
import { MongoClient } from "mongodb";

dotenv.config({ path: path.join(__dirname, "../.env") });

type Args = { file: string; sourceDb: string; yes: boolean; help: boolean };
type LastGame = {
  _id: unknown;
  when: Date | string | null;
  seasonNumber: number | null;
  seasonName: string | null;
  winner: string | null;
  participants: number | null;
} | null;
type Stats = {
  dbName: string;
  totals: { games: number; seasons: number };
  counts: Record<string, number>;
  lastGame: LastGame;
};

function parseArgs(argv: string[]): Args {
  const o: Args = { file: "", sourceDb: "", yes: false, help: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a.startsWith("--sourceDb=")) o.sourceDb = a.split("=")[1];
    else if (!o.file && !a.startsWith("--")) o.file = a;
  }
  return o;
}

const ARGS = parseArgs(process.argv.slice(2));
const BACKUP_DIR = path.join(__dirname, "../backups");
const BACKUP_FILE = ARGS.file;
const SOURCE_DB_OVERRIDE = ARGS.sourceDb || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

if (ARGS.help) {
  printHelp();
  process.exit(0);
}
if (!DATABASE_URL) exitWith("Missing DATABASE_URL in .env");

const DB_NAME = getDbNameFromUri(DATABASE_URL);
if (!BACKUP_FILE) {
  printHelp("Missing <path/to/backup.gz>.");
  process.exit(1);
}
if (!fs.existsSync(BACKUP_FILE)) {
  printHelp(`File not found: ${BACKUP_FILE}`);
  process.exit(1);
}

const SOURCE_DB = SOURCE_DB_OVERRIDE || DB_NAME;
const CLUSTER_URI = trimMongoURI(DATABASE_URL);
const PREVIEW_DB = `${DB_NAME}_preview_${Date.now()}`;
const PRE_APPLY_FILE = path.join(
  BACKUP_DIR,
  `pre-apply-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.gz`
);

(async () => {
  ensureDir(BACKUP_DIR);
  await restoreToTemp(BACKUP_FILE, SOURCE_DB, PREVIEW_DB);

  const client = new MongoClient(DATABASE_URL);
  await client.connect();

  const currentStats = await gatherStats(client, DB_NAME);
  const previewStats = await gatherStats(client, PREVIEW_DB);

  printStats({
    currentStats,
    previewStats,
    file: path.basename(BACKUP_FILE),
    db: DB_NAME,
  });

  const confirmed =
    ARGS.yes ||
    (await promptYesNo(
      `\nApply backup "${path.basename(BACKUP_FILE)}" to overwrite "${DB_NAME}"? [y/N] `
    ));
  if (!confirmed) {
    await dropDb(client, PREVIEW_DB);
    await client.close();
    console.log("Aborted. Preview DB dropped.");
    process.exit(0);
  }

  await dumpCurrent(PRE_APPLY_FILE, DB_NAME);
  await restoreToTarget(BACKUP_FILE, SOURCE_DB, DB_NAME);
  await dropDb(client, PREVIEW_DB);
  await client.close();

  console.log(`Done.\nPre-apply backup saved: ${PRE_APPLY_FILE}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function run(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
  return new Promise<{ out: string; err: string }>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) =>
      code === 0
        ? resolve({ out, err })
        : reject(new Error(`${cmd} ${args.join(" ")}\n${err}`))
    );
  });
}

async function restoreToTemp(
  archivePath: string,
  sourceDb: string,
  previewDb: string
) {
  await run("mongorestore", [
    `--uri=${CLUSTER_URI}`,
    `--archive=${archivePath}`,
    "--gzip",
    `--nsInclude=${sourceDb}.*`,
    `--nsFrom=${sourceDb}.*`,
    `--nsTo=${previewDb}.*`,
    "--drop",
  ]);
}

async function restoreToTarget(
  archivePath: string,
  sourceDb: string,
  targetDb: string
) {
  await run("mongorestore", [
    `--uri=${CLUSTER_URI}`,
    `--archive=${archivePath}`,
    "--gzip",
    `--nsInclude=${sourceDb}.*`,
    `--nsFrom=${sourceDb}.*`,
    `--nsTo=${targetDb}.*`,
    "--drop",
  ]);
}

async function dumpCurrent(outFile: string, dbName: string) {
  await run("mongodump", [
    `--uri=${CLUSTER_URI}`,
    `--db=${dbName}`,
    `--archive=${outFile}`,
    "--gzip",
  ]);
}

async function gatherStats(
  client: MongoClient,
  dbName: string
): Promise<Stats> {
  const db = client.db(dbName);
  const collections = [
    "Game",
    "Season",
    "Player",
    "PlayerStats",
    "GameParticipation",
    "EloHistory",
    "PlayerPunishment",
  ];
  const counts: Record<string, number> = {};
  for (const c of collections)
    counts[c] = await db
      .collection(c)
      .countDocuments()
      .catch(() => 0);

  const lastGameDoc = (await db
    .collection("Game")
    .find({}, {
      projection: {
        _id: 1,
        endTime: 1,
        startTime: 1,
        winner: 1,
        seasonId: 1,
        participantsIGNs: 1,
      },
    } as any)
    .sort({ endTime: -1, startTime: -1, _id: -1 })
    .limit(1)
    .toArray()
    .then((a) => a[0] || null)
    .catch(() => null)) as any;

  let seasonInfo: any = null;
  if (lastGameDoc?.seasonId) {
    seasonInfo = await db
      .collection("Season")
      .findOne({ _id: lastGameDoc.seasonId }, {
        projection: { number: 1, name: 1 },
      } as any)
      .catch(() => null);
  }

  const lastGame: LastGame = lastGameDoc
    ? {
        _id: lastGameDoc._id,
        when: lastGameDoc.endTime || lastGameDoc.startTime || null,
        seasonNumber: seasonInfo?.number ?? null,
        seasonName: seasonInfo?.name ?? null,
        winner: lastGameDoc.winner ?? null,
        participants: Array.isArray(lastGameDoc.participantsIGNs)
          ? lastGameDoc.participantsIGNs.length
          : null,
      }
    : null;

  return {
    dbName,
    totals: { games: counts.Game || 0, seasons: counts.Season || 0 },
    counts,
    lastGame,
  };
}

function printStats({
  currentStats,
  previewStats,
  file,
  db,
}: {
  currentStats: Stats;
  previewStats: Stats;
  file: string;
  db: string;
}) {
  const iso = (d?: Date | string | null) =>
    d ? new Date(d).toISOString().replace(".000Z", "Z") : "n/a";
  const lg = (g: LastGame) =>
    g
      ? {
          _id: g._id,
          when: iso(g.when),
          season: g.seasonNumber ?? g.seasonName ?? "n/a",
          winner: g.winner ?? "n/a",
          participants: g.participants ?? "n/a",
        }
      : "none";
  const summarizeCounts = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");

  console.log(`\nFile: ${file}`);
  console.log(`Target DB: ${db}\n`);
  console.log("=== CURRENT DB ===");
  console.log(
    `games: ${currentStats.totals.games}, seasons: ${currentStats.totals.seasons}`
  );
  console.log("last game:", lg(currentStats.lastGame));
  console.log("collections:", summarizeCounts(currentStats.counts));
  console.log("\n=== BACKUP PREVIEW ===");
  console.log(
    `games: ${previewStats.totals.games}, seasons: ${previewStats.totals.seasons}`
  );
  console.log("last game:", lg(previewStats.lastGame));
  console.log("collections:", summarizeCounts(previewStats.counts));
}

function promptYesNo(q: string) {
  return new Promise<boolean>((res) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(q, (ans) => {
      rl.close();
      res(/^y(es)?$/i.test((ans || "").trim()));
    });
  });
}

function printHelp(err?: string) {
  if (err) console.error(err);
  console.log(
    `
Usage:
  ts-node apply-backup.ts <path/to/backup.gz> [--sourceDb=<dbInArchive>] [--yes|-y] [--help|-h]

Examples:
  ts-node apply-backup.ts ./backups/backup-2025-08-08.gz
  ts-node apply-backup.ts ./backups/backup-2025-08-08.gz --sourceDb=AnniBot -y

What it does:
  • Creates a safety dump of current DB into ./backups/
  • Restores the .gz into a temporary preview DB to show stats
  • Shows totals and last game info, then asks for confirmation (skip with --yes)

Environment:
  DATABASE_URL must include the target DB name (current).
  Detected target DB from DATABASE_URL: ${process.env.DATABASE_URL ? getDbNameFromUri(process.env.DATABASE_URL) : "(unknown)"}

Notes:
  • If your archive was created from DB "AnniBot", you can omit --sourceDb (default is target DB).
  • Use --sourceDb when the archive DB name differs from the target.
`.trim()
  );
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function exitWith(msg: string) {
  console.error(msg);
  process.exit(1);
}
function trimMongoURI(uri: string) {
  const u = new URL(uri);
  u.pathname = "";
  u.search = "";
  return u.toString();
}
function getDbNameFromUri(uri: string): string {
  let name = "";
  try {
    const u = new URL(uri);
    name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  } catch {
    const m = uri.match(/\/([^/?]+)(?:\?|$)/);
    if (m && m[1]) name = decodeURIComponent(m[1]);
  }
  if (!name)
    exitWith("DATABASE_URL must include a database name, e.g. .../AnniBot");
  return name;
}

async function dropDb(client: MongoClient, dbName: string) {
  try {
    await client.db(dbName).dropDatabase();
  } catch {
    // ignore if already gone / no permissions
  }
}
