const { spawn } = require("child_process");
const path = require("path");

const entry = process.env.BOT_ENTRY || path.join(__dirname, "../dist/main.js");

function run() {
  const args = [];
  if (entry.endsWith(".ts")) args.push("-r", "ts-node/register");
  args.push(entry);

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });

  child.on("exit", (code, signal) => {
    if (code === 51) {
      console.log("[dev-runner] Restart requested. Relaunching...");
      run();
    } else {
      console.log(`[dev-runner] Child exited (code=${code} signal=${signal}).`);
      process.exit(code ?? 0);
    }
  });
}

run();
