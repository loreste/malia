// Test: fs.globSync and fs.glob (async).
import fs from "node:fs";

// globSync
const results = fs.globSync("*.js", { cwd: import.meta.dirname });
if (!Array.isArray(results) || results.length === 0) {
  console.error("FAIL: globSync returned empty or non-array");
  process.exit(1);
}
// Should find this file itself
const thisFile = results.find(f => f.endsWith("sprint1_glob.js"));
if (!thisFile) {
  console.error("FAIL: globSync didn't find sprint1_glob.js in", results.slice(0, 5));
  process.exit(1);
}
console.log("PASS: globSync found " + results.length + " .js files");

// async glob
const asyncResults = await fs.promises.glob("*.js", { cwd: import.meta.dirname });
if (!Array.isArray(asyncResults) || asyncResults.length === 0) {
  console.error("FAIL: async glob returned empty");
  process.exit(1);
}
console.log("PASS: async glob found " + asyncResults.length + " .js files");
