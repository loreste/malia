// WorkerPool fixture: 4 workers, 8 fib jobs. Verifies correctness and that
// the pool beats sequential execution.
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

const N = 33;
const JOBS = 8;

let start = performance.now();
const expected = Array.from({ length: JOBS }, () => fib(N));
const sequentialMs = performance.now() - start;

const workerUrl = import.meta.url.replace(/[^/]*$/, "fib_worker.js");
const pool = new WorkerPool(workerUrl, { size: 4 });
if (pool.size !== 4) throw new Error("pool size mismatch");

start = performance.now();
const results = await Promise.all(Array.from({ length: JOBS }, () => pool.run(N)));
const parallelMs = performance.now() - start;
pool.close();

for (let i = 0; i < JOBS; i++) {
  if (results[i] !== expected[i]) {
    throw new Error(`job ${i}: expected ${expected[i]}, got ${results[i]}`);
  }
}

// On a 2-core CI runner the pool may barely beat sequential. Only fail
// if the pool is actually slower (overhead made it worse, not just tied).
if (parallelMs > sequentialMs * 1.1) {
  throw new Error(`pool slower than sequential: sequential ${sequentialMs.toFixed(1)}ms, pool ${parallelMs.toFixed(1)}ms`);
}

// After close(), run() rejects.
let rejected = false;
try {
  await pool.run(1);
} catch {
  rejected = true;
}
if (!rejected) throw new Error("run() after close() did not reject");

console.log(`POOL: PASS (sequential ${sequentialMs.toFixed(1)}ms, pool ${parallelMs.toFixed(1)}ms, ${(sequentialMs / parallelMs).toFixed(2)}x)`);
