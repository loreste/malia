// Parallel fib across 4 OS-thread workers (each with its own V8 isolate).
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

const JOBS = [36, 36, 36, 36];

// Single-threaded baseline.
let start = performance.now();
const baseline = JOBS.map(fib);
const singleMs = performance.now() - start;
console.log(`single-thread: ${baseline.join(", ")} in ${singleMs.toFixed(1)}ms`);

// Parallel with workers.
start = performance.now();
const workerUrl = import.meta.url.replace(/[^/]*$/, "fib_worker.js");
const workers = JOBS.map(() => new Worker(workerUrl));
const results = await Promise.all(
  workers.map((w, i) => {
    w.postMessage(JOBS[i]);
    return w.receive();
  }),
);
const parallelMs = performance.now() - start;
for (const w of workers) w.terminate();

console.log(`4 workers:     ${results.map((r) => r.data).join(", ")} in ${parallelMs.toFixed(1)}ms`);
console.log(`speedup: ${(singleMs / parallelMs).toFixed(2)}x`);
