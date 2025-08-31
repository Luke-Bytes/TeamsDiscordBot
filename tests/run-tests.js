// Build and run tests using esbuild
const esbuild = require("esbuild");
const path = require("path");

async function buildAndRun() {
  const entry = path.resolve(__dirname, "run.ts");
  const outfile = path.resolve(__dirname, "../dist/tests/run.js");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node18",
    sourcemap: false,
    format: "cjs",
    logLevel: "info",
    tsconfig: path.resolve(process.cwd(), "tsconfig.json"),
  });
  require(outfile);
}

buildAndRun().catch((e) => {
  console.error(e);
  process.exit(1);
});
