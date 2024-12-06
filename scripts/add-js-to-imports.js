import fs from "fs";
import path from "path";

function log(message) {
  console.log(message);
}

const importRegex = /(import\s.*?from\s+['"])(\.\/|\.\.\/|\/|[^/@][^:]*?)(['"])/g;

function processFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  let changesMade = false;

  const updatedContent = content.replace(importRegex, (match, p1, p2, p3) => {
    if (!p2.endsWith(".js")) {
      changesMade = true;
      return `${p1}${p2}.js${p3}`;
    }
    return match;
  });

  if (changesMade) {
    fs.writeFileSync(filePath, updatedContent, "utf-8");
    log(`Updated imports in: ${filePath}`);
  }
}

function processDirectory(directory) {
  const files = fs.readdirSync(directory);

  for (const file of files) {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDirectory(fullPath);
    } else if (file.endsWith(".ts")) {
      processFile(fullPath);
    }
  }
}

const srcDirectory = path.resolve("./src");
log(`Checking directory: ${srcDirectory}`);
processDirectory(srcDirectory);
log("Import updates complete!");
