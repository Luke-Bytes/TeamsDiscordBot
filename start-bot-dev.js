import { spawn } from "child_process";

const nodeOptions =
  "--experimental-specifier-resolution=node --loader ts-node/esm";

const nodemon = spawn(
  "nodemon",
  ["--watch", "src", "--ext", "ts", "--exec", "ts-node", "src/BotManager.ts"],
  {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    stdio: "inherit",
    shell: true,
  }
);

nodemon.on("close", (code) => {
  console.log(`nodemon process exited with code ${code}`);
});
