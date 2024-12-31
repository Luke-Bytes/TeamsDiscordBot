require("dotenv").config();
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const BACKUP_DIR = path.join(__dirname, "../backups");
const DAYS_TO_KEEP = 10;
let DATABASE_URL = process.env.DATABASE_URL;
let DATABASE_BACKUP_URL = process.env.DATABASE_BACKUP_URL;

function trimMongoURI(uri) {
  try {
    const urlObj = new URL(uri);
    urlObj.pathname = "";
    urlObj.search = "";
    return urlObj.toString();
  } catch (error) {
    console.error("Invalid MongoDB URI:", uri);
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
      console.error("Error creating backup:", err);
      console.error("stderr:", stderr);
      return;
    }

    console.log(`Backup created: ${backupFilePath}`);

    fs.readdir(BACKUP_DIR, (readErr, files) => {
      if (readErr) {
        console.error("Error reading backup directory:", readErr);
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
            console.error(`Error deleting old backup ${file.name}:`, unlinkErr);
          } else {
            console.log(`Deleted old backup: ${file.name}`);
          }
        });
      });
    });

    exec(
      `mongorestore --uri="${DATABASE_BACKUP_URL}" --archive="${backupFilePath}" --gzip --drop`,
      (restoreErr, stderr) => {
        if (restoreErr) {
          console.error("Error pushing backup to Atlas:", restoreErr);
          console.error("stderr:", stderr);
        } else {
          console.log("Backup successfully pushed to Atlas.");
        }
      }
    );
  }
);
