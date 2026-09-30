// Worker pool: 4 workers, 8x fib(35) jobs (node variant, worker_threads).
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const taskPath = fileURLToPath(new URL("pool_task.node.mjs", import.meta.url));
const SIZE = 4;
const workers = Array.from({ length: SIZE }, () => new Worker(taskPath));

function run(worker, arg) {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.postMessage(arg);
  });
}

// Simplest fair dispatch: queue jobs onto idle workers.
const queue = Array.from({ length: 8 }, () => 35);
const results = [];
const t = performance.now();
await Promise.all(
  workers.map(async (worker) => {
    while (queue.length > 0) {
      results.push(await run(worker, queue.shift()));
    }
  }),
);
const ms = performance.now() - t;
for (const worker of workers) await worker.terminate();
if (results[0] !== 9227465 || results.some((r) => r !== results[0])) throw new Error("bad result");
console.log(`RESULT jobs=8 ms=${ms.toFixed(1)}`);
