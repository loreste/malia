// Array ops: map/filter/reduce over 1M elements. Shared jse/node.
const n = 1_000_000;
const arr = new Array(n);
for (let i = 0; i < n; i++) arr[i] = i;

const t = performance.now();
const mapped = arr.map((x) => x * 3 + 1);
const filtered = mapped.filter((x) => x % 7 !== 0);
let sum = 0;
for (let i = 0; i < filtered.length; i++) sum += filtered[i];
const reduced = arr.reduce((a, b) => a + b, 0);
const ms = performance.now() - t;
if (reduced !== 499999500000 || filtered.length === 0 || sum <= 0) throw new Error("mismatch");
console.log(`RESULT n=${n} ms=${ms.toFixed(1)}`);
