// 10k concurrent 50ms sleeps (node variant).
const t = performance.now();
await Promise.all(
  Array.from({ length: 10_000 }, () => new Promise((resolve) => setTimeout(resolve, 50))),
);
const ms = performance.now() - t;
console.log(`RESULT tasks=10000 ms=${ms.toFixed(1)}`);
