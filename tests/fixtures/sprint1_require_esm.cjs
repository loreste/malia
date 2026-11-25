// Test: require(esm) — CJS file requiring an ESM module.
const path = require("node:path");
const mod = require(path.join(__dirname, "sprint1_esm_mod.mjs"));

if (mod.type !== "esm-module") {
  console.error("FAIL: default export not found, got:", mod);
  process.exit(1);
}
// Named exports should also be available via the exports object
// (the default export takes over module.exports, named exports
// are properties if the module uses both)
console.log("PASS: require(esm) works, default:", JSON.stringify(mod));
