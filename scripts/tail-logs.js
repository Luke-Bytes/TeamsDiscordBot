const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const logsDir = path.join(__dirname, "..", "logs");

const today = new Date();
const year = today.getFullYear();
const month = String(today.getMonth() + 1).padStart(2, "0");
const day = String(today.getDate()).padStart(2, "0");

const logFileName = `teams_bot-${year}-${month}-${day}.log`;
const logFilePath = path.join(logsDir, logFileName);

if (fs.existsSync(logFilePath)) {
  const tailCommand = `tail -n 150 -f ${logFilePath}`;
  console.log(`Running: ${tailCommand}`);
  const tailProcess = exec(tailCommand);

  tailProcess.stdout.pipe(process.stdout);
  tailProcess.stderr.pipe(process.stderr);
} else {
  console.error(
    `Log file for today (${logFileName}) does not exist in ${logsDir}`
  );
  process.exit(1);
}
