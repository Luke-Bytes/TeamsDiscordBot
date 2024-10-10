import replace from "replace-in-file";

const options = {
  files: "dist/**/*.js",
  from: [
    /from\s+['"](\.\/[^'"]+)(?<!\.js)['"]/g, // Match './' without .js etc
    /from\s+['"](\.\.\/[^'"]+)(?<!\.js)['"]/g,
    /from\s+['"](\.\.\/\.\.\/[^'"]+)(?<!\.js)['"]/g,
    /from\s+['"](\.\.\/\.\.\/\.\.\/[^'"]+)(?<!\.js)['"]/g,
  ],
  to: [
    'from "$1.js"', // Add .js to './' etc
    'from "$1.js"',
    'from "$1.js"',
    'from "$1.js"',
  ],
};

async function replaceImports() {
  try {
    const results = await replace(options);
    console.log("Replacement results:", results);
  } catch (error) {
    console.error("Error occurred:", error);
  }
}

replaceImports();
