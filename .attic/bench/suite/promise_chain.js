// Microtask/promise throughput: 100k sequential awaits + 100k parallel.
// Shared jse/node.
let t = performance.now();
let x = 0;
for (let i = 0; i < 100_000; i++) {
  x = await Promise.resolve(x + 1);
}
const chainMs = performance.now() - t;

t = performance.now();
const results = await Promise.all(Array.from({ length: 100_000 }, (_, i) => Promise.resolve(i)));
const allMs = performance.now() - t;

if (x !== 100_000 || results[99_999] !== 99_999) throw new Error("mismatch");
console.log(`RESULT n=100000 ms=${(chainMs + allMs).toFixed(1)} (chain ${chainMs.toFixed(1)}, all ${allMs.toFixed(1)})`);
