// Node equivalent of bench/async10k.js (setTimeout instead of sleep).
const N = 10_000;
const start = performance.now();
await Promise.all(
  Array.from({ length: N }, () => new Promise((r) => setTimeout(r, 50))),
);
const ms = performance.now() - start;
console.log(`${N} concurrent sleep(50) tasks in ${ms.toFixed(1)}ms`);
