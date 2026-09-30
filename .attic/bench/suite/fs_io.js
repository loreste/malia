// fs: write + read a 100MB file. Runs on both jse and node.
import { writeFileSync, readFileSync } from "node:fs";

const size = 100 * 1024 * 1024;
const buf = Buffer.alloc(size, 120); // 'x'
const path = (process.env.TMPDIR ?? "/tmp") + "/jse_bench_fs.bin";

let t = performance.now();
writeFileSync(path, buf);
const writeMs = performance.now() - t;
t = performance.now();
const back = readFileSync(path);
const readMs = performance.now() - t;
if (back.length !== size) throw new Error("size mismatch");
console.log(`RESULT bytes=${size} ms=${(writeMs + readMs).toFixed(1)} (write ${writeMs.toFixed(1)}, read ${readMs.toFixed(1)})`);
