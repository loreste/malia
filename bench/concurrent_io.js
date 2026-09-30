// Measures: concurrent async I/O (parallel file reads + fetches)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpDir = path.join(os.tmpdir(), `bench-cio-${process.pid}`);
fs.mkdirSync(tmpDir, { recursive: true });

// Create 100 test files
const FILE_COUNT = 100;
const FILE_SIZE = 8192;
for (let i = 0; i < FILE_COUNT; i++) {
  fs.writeFileSync(path.join(tmpDir, `file_${i}.txt`), "x".repeat(FILE_SIZE));
}

// 1. Concurrent file reads (fs.promises)
const ROUNDS = 20;
const start1 = performance.now();
for (let r = 0; r < ROUNDS; r++) {
  await Promise.all(
    Array.from({ length: FILE_COUNT }, (_, i) =>
      fs.promises.readFile(path.join(tmpDir, `file_${i}.txt`))
    )
  );
}
const elapsed1 = performance.now() - start1;
const totalReads = ROUNDS * FILE_COUNT;
console.log(`fs.promises.readFile: ${totalReads} concurrent reads in ${elapsed1.toFixed(1)}ms (${(totalReads / elapsed1 * 1000).toFixed(0)} ops/s)`);

// 2. Concurrent HTTP requests
const body = JSON.stringify({ ok: true });
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const TOTAL_REQUESTS = 5000;
const CONCURRENCY = 100;
let done = 0;

const start2 = performance.now();
async function worker() {
  while (done < TOTAL_REQUESTS) {
    done++;
    const res = await fetch(url);
    await res.arrayBuffer();
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const elapsed2 = performance.now() - start2;
server.close();
console.log(`fetch: ${TOTAL_REQUESTS} concurrent requests (${CONCURRENCY} workers) in ${elapsed2.toFixed(1)}ms (${(TOTAL_REQUESTS / elapsed2 * 1000).toFixed(0)} req/s)`);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
