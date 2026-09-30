// Measures: Worker thread spawn + message roundtrip throughput
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import os from "node:os";

if (!isMainThread) {
  parentPort.on("message", (msg) => {
    // CPU work: sum to simulate real compute
    let sum = 0;
    for (let i = 0; i < msg.n; i++) sum += i;
    parentPort.postMessage({ sum });
  });
} else {
  const cpus = os.cpus().length;
  const TASKS = 200;
  const N_PER_TASK = 100000;
  const workerCount = Math.min(cpus, 8);

  // Spawn workers
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(new Worker(new URL(import.meta.url)));
  }

  // Wait for workers to be ready
  await new Promise(r => setTimeout(r, 100));

  let completed = 0;
  let nextTask = 0;

  const start = performance.now();
  await new Promise((resolve) => {
    function dispatch(w) {
      if (nextTask >= TASKS) return;
      const task = nextTask++;
      w.postMessage({ n: N_PER_TASK });
      w.once("message", () => {
        completed++;
        if (completed >= TASKS) {
          resolve();
        } else {
          dispatch(w);
        }
      });
    }
    for (const w of workers) dispatch(w);
  });
  const elapsed = performance.now() - start;

  for (const w of workers) w.terminate();
  console.log(`workers: ${TASKS} tasks across ${workerCount} workers in ${elapsed.toFixed(1)}ms (${(TASKS / elapsed * 1000).toFixed(0)} tasks/s)`);
}
