// 10k concurrent 50ms sleeps (jse variant).
const t = performance.now();
await Promise.all(Array.from({ length: 10_000 }, () => sleep(50)));
const ms = performance.now() - t;
console.log(`RESULT tasks=10000 ms=${ms.toFixed(1)}`);
