// Measures: SHA-256 hashing throughput
import crypto from "node:crypto";

const data = Buffer.alloc(4096, "x");
const iterations = 50000;

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  crypto.createHash("sha256").update(data).digest();
}
const elapsed = performance.now() - start;
console.log(`sha256: ${iterations} iterations in ${elapsed.toFixed(1)}ms (${(iterations / elapsed * 1000).toFixed(0)} ops/s)`);
