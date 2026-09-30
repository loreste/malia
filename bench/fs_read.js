// Measures: synchronous file read throughput
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpFile = path.join(os.tmpdir(), `bench-fs-${process.pid}.txt`);
fs.writeFileSync(tmpFile, "x".repeat(4096));

const iterations = 50000;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  fs.readFileSync(tmpFile);
}
const elapsed = performance.now() - start;
fs.unlinkSync(tmpFile);
console.log(`fs.readFileSync: ${iterations} iterations in ${elapsed.toFixed(1)}ms (${(iterations / elapsed * 1000).toFixed(0)} ops/s)`);
