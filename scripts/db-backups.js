const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const BACKUP_DIR = path.join(__dirname, "../backups");
const DAYS_TO_KEEP = 14;
let DATABASE_URL = process.env.DATABASE_URL;
let DATABASE_BACKUP_URL = process.env.DATABASE_BACKUP_URL;

function trimMongoURI(uri) {
  try {
    const urlObj = new URL(uri);
    urlObj.pathname = "";
    urlObj.search = "";
    return urlObj.toString();
  } catch (error) {
    console.error("[Database backup] Invalid MongoDB URI:", uri);
    process.exit(1);
  }
}

DATABASE_URL = trimMongoURI(DATABASE_URL);
DATABASE_BACKUP_URL = trimMongoURI(DATABASE_BACKUP_URL);

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR);
}

const currentDate = new Date();
const backupFileName = `backup-${currentDate.toISOString().split("T")[0]}.gz`;
const backupFilePath = path.join(BACKUP_DIR, backupFileName);

exec(
  `mongodump --uri="${DATABASE_URL}" --archive="${backupFilePath}" --gzip`,
  (err, stdout, stderr) => {
    if (err) {
      console.error("[Database backup] Error creating backup:", err);
      console.error("[Database backup] stderr:", stderr);
      return;
    }

    console.log(`[Database backup] Backup created: ${backupFilePath}`);

    fs.readdir(BACKUP_DIR, (readErr, files) => {
      if (readErr) {
        console.error(
          "[Database backup] Error reading backup directory:",
          readErr
        );
        return;
      }

      const backups = files
        .map((file) => ({
          name: file,
          time: fs.statSync(path.join(BACKUP_DIR, file)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);

      backups.slice(DAYS_TO_KEEP).forEach((file) => {
        const filePath = path.join(BACKUP_DIR, file.name);
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) {
            console.error(
              `[Database backup] Error deleting old backup ${file.name}:`,
              unlinkErr
            );
          } else {
            console.log(`[Database backup] Deleted old backup: ${file.name}`);
          }
        });
      });
    });

    exec(
      `mongorestore --uri="${DATABASE_BACKUP_URL}" --archive="${backupFilePath}" --gzip --drop`,
      (restoreErr, stderr) => {
        if (restoreErr) {
          console.error(
            "[Database backup] Error pushing backup to Atlas:",
            restoreErr
          );
          console.error("[Database backup] stderr:", stderr);
        } else {
          console.log("[Database backup] Backup successfully pushed to Atlas.");
        }
      }
    );
  }
);
