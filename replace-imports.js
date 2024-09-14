import replace from 'replace-in-file';  // ES module import

const options = {
  files: 'dist/**/*.js',
  from: [
    /from\s+['"](\.\/[^'"]+)(?<!\.js)['"]/g,      // Match './' without .js
    /from\s+['"](\.\.\/[^'"]+)(?<!\.js)['"]/g,    // Match '../' without .js
    /from\s+['"](\.\.\/\.\.\/[^'"]+)(?<!\.js)['"]/g,  // Match '../../' without .js
    /from\s+['"](\.\.\/\.\.\/\.\.\/[^'"]+)(?<!\.js)['"]/g  // Match '../../../' without .js
  ],
  to: [
    'from "$1.js"',  // Add .js to './'
    'from "$1.js"',  // Add .js to '../'
    'from "$1.js"',  // Add .js to '../../'
    'from "$1.js"'   // Add .js to '../../../'
  ]
};

async function replaceImports() {
  try {
    const results = await replace(options);
    console.log('Replacement results:', results);
  } catch (error) {
    console.error('Error occurred:', error);
  }
}

replaceImports();
