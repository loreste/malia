// Map/Set churn: 1M insert + 1M lookup + 1M delete each. Shared jse/node.
const n = 1_000_000;

let t = performance.now();
const map = new Map();
for (let i = 0; i < n; i++) map.set(i, i * 2);
let hit = 0;
for (let i = 0; i < n; i++) if (map.get(i) === i * 2) hit++;
for (let i = 0; i < n; i += 2) map.delete(i);
const mapMs = performance.now() - t;

t = performance.now();
const set = new Set();
for (let i = 0; i < n; i++) set.add(i);
let has = 0;
for (let i = 0; i < n; i++) if (set.has(i)) has++;
for (let i = 0; i < n; i += 2) set.delete(i);
const setMs = performance.now() - t;

if (hit !== n || has !== n || map.size !== n / 2 || set.size !== n / 2) throw new Error("mismatch");
console.log(`RESULT n=${n} ms=${(mapMs + setMs).toFixed(1)} (map ${mapMs.toFixed(1)}, set ${setMs.toFixed(1)})`);
