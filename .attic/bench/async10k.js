// Async benchmark: 10k concurrent sleep(50) tasks.
const N = 10_000;
const start = performance.now();
await Promise.all(
  Array.from({ length: N }, () => sleep(50)),
);
const ms = performance.now() - start;
console.log(`${N} concurrent sleep(50) tasks in ${ms.toFixed(1)}ms`);
