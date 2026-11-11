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
    // The real-process integration suite builds a separate worker at runtime.
    // esbuild itself must stay external because its JS API resolves a native binary.
    external: ["sharp", "esbuild"],
    logLevel: "info",
    tsconfig: path.resolve(process.cwd(), "tsconfig.json"),
    // Allow isolated worktrees to reuse an explicitly supplied dependency tree.
    nodePaths: process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? [],
  });
  require(outfile);
}

buildAndRun().catch((e) => {
  console.error(e);
  process.exit(1);
});
