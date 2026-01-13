const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { exec } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const util = require("util");

const execAsync = util.promisify(exec);
const BACKUP_DIR = path.join(__dirname, "../backups");
const TEMP_DIR = path.join(BACKUP_DIR, "temp-db");
const DAYS_TO_KEEP = 14;
let DATABASE_URL = process.env.DATABASE_URL;
let DATABASE_BACKUP_URL = process.env.DATABASE_BACKUP_URL;

function moveFileSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err?.code === "EXDEV") {
      const tmpDest = `${dest}.tmp-${process.pid}-${Date.now()}`;
      fs.copyFileSync(src, tmpDest);
      fs.renameSync(tmpDest, dest);
      fs.unlinkSync(src);
      return;
    }
    throw err;
  }
}

function trimMongoURI(uri) {
  try {
    const urlObj = new URL(uri);
    const dbName = urlObj.pathname.replace(/^\/+/, "");
    if (dbName && !urlObj.searchParams.has("authSource")) {
      urlObj.searchParams.set("authSource", dbName);
    }
    // Keep trailing slash so query params remain valid (e.g., ?replicaSet=...).
    urlObj.pathname = "/";
    return urlObj.toString();
  } catch (error) {
    console.error("[Database backup] Invalid MongoDB URI:", uri);
    process.exit(1);
  }
}

function getLatestBackupPath() {
  if (!fs.existsSync(BACKUP_DIR)) {
    return null;
  }

  const files = fs.readdirSync(BACKUP_DIR).filter((file) => {
    const fullPath = path.join(BACKUP_DIR, file);
    return (
      file.endsWith(".gz") &&
      fs.existsSync(fullPath) &&
      fs.statSync(fullPath).isFile()
    );
  });
  if (!files.length) {
    return null;
  }

  const latest = files
    .map((file) => ({
      name: file,
      time: fs.statSync(path.join(BACKUP_DIR, file)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time)[0];

  return latest ? path.join(BACKUP_DIR, latest.name) : null;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

async function runCommand(command, successMessage) {
  try {
    const { stderr } = await execAsync(command);
    if (stderr) {
      console.warn("[Database backup] stderr:", stderr);
    }
    if (successMessage) {
      console.log(successMessage);
    }
  } catch (error) {
    console.error("[Database backup] Command failed:", command);
    console.error("[Database backup] Error:", error);
    if (error.stderr) {
      console.error("[Database backup] stderr:", error.stderr);
    }
    process.exit(1);
  }
}

async function pruneOldBackups() {
  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((file) => {
      const fullPath = path.join(BACKUP_DIR, file);
      return (
        file.endsWith(".gz") &&
        fs.existsSync(fullPath) &&
        fs.statSync(fullPath).isFile()
      );
    })
    .map((file) => ({
      name: file,
      time: fs.statSync(path.join(BACKUP_DIR, file)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  backups.slice(DAYS_TO_KEEP).forEach((file) => {
    const filePath = path.join(BACKUP_DIR, file.name);
    try {
      fs.unlinkSync(filePath);
      console.log(`[Database backup] Deleted old backup: ${file.name}`);
    } catch (error) {
      console.error(
        `[Database backup] Error deleting old backup ${file.name}:`,
        error
      );
    }
  });
}

function cleanTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    return;
  }

  fs.readdirSync(TEMP_DIR).forEach((file) => {
    const fullPath = path.join(TEMP_DIR, file);
    if (file.endsWith(".gz") && fs.statSync(fullPath).isFile()) {
      try {
        fs.unlinkSync(fullPath);
      } catch (error) {
        console.error(
          `[Database backup] Error cleaning temp file ${fullPath}:`,
          error
        );
      }
    }
  });
}

async function main() {
  DATABASE_URL = trimMongoURI(DATABASE_URL);
  DATABASE_BACKUP_URL = trimMongoURI(DATABASE_BACKUP_URL);

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const currentDate = new Date();
  const backupFileName = `backup-${currentDate.toISOString().split("T")[0]}.gz`;
  const finalBackupPath = path.join(BACKUP_DIR, backupFileName);
  const tempBackupPath = path.join(
    TEMP_DIR,
    `temp-backup-${currentDate.getTime()}.gz`
  );

  cleanTempDir();

  const latestBackupPath = getLatestBackupPath();

  await runCommand(
    `mongodump --uri="${DATABASE_URL}" --archive="${tempBackupPath}" --gzip`,
    `[Database backup] Backup created (temp): ${tempBackupPath}`
  );

  let backupForRestore = tempBackupPath;
  let createdNewBackup = true;

  if (latestBackupPath) {
    const [latestHash, tempHash] = await Promise.all([
      hashFile(latestBackupPath),
      hashFile(tempBackupPath),
    ]);

    if (latestHash === tempHash) {
      createdNewBackup = false;
      backupForRestore = latestBackupPath;
      fs.unlinkSync(tempBackupPath);
      console.log(
        `[Database backup] No data changes detected; reusing latest backup: ${latestBackupPath}`
      );
    }
  }

  if (createdNewBackup) {
    moveFileSync(tempBackupPath, finalBackupPath);
    backupForRestore = finalBackupPath;
    console.log(`[Database backup] Backup saved: ${finalBackupPath}`);
    await pruneOldBackups();
  } else if (!latestBackupPath) {
    console.error("[Database backup] No existing backup to reuse.");
    process.exit(1);
  }

  await runCommand(
    `mongorestore --uri="${DATABASE_BACKUP_URL}" --archive="${backupForRestore}" --gzip --drop`,
    "[Database backup] Backup successfully pushed to Atlas."
  );

  cleanTempDir();
}

main().catch((error) => {
  console.error("[Database backup] Unexpected error:", error);
  process.exit(1);
});
