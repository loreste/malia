// Worker pool: 4 workers, 8x fib(35) jobs (jse variant).
const workerUrl = import.meta.url.replace(/[^/]*$/, "pool_task.jse.js");
const pool = new WorkerPool(workerUrl, { size: 4 });
const t = performance.now();
const results = await Promise.all(Array.from({ length: 8 }, () => pool.run(35)));
const ms = performance.now() - t;
pool.close();
if (results[0] !== 9227465 || results.some((r) => r !== results[0])) throw new Error("bad result");
console.log(`RESULT jobs=8 ms=${ms.toFixed(1)}`);
