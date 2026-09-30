// WorkerPool: fixed-size worker pool with idle-first dispatch.
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

const JOBS = Array.from({ length: 8 }, () => 34);

let start = performance.now();
const expected = JOBS.map(fib);
const singleMs = performance.now() - start;
console.log(`single-thread: 8 jobs in ${singleMs.toFixed(1)}ms`);

const workerUrl = import.meta.url.replace(/[^/]*$/, "fib_worker.js");
const pool = new WorkerPool(workerUrl, { size: 4 });
console.log(`pool size: ${pool.size}`);

start = performance.now();
const results = await pool.map(JOBS);
const poolMs = performance.now() - start;
pool.close();

const ok = results.every((r, i) => r === expected[i]);
console.log(`pool of 4:     8 jobs in ${poolMs.toFixed(1)}ms (${(singleMs / poolMs).toFixed(2)}x) ${ok ? "✓" : "MISMATCH"}`);
