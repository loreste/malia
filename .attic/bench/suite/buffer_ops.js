// Buffer ops: 1M slice + toString + concat + from. Shared jse/node
// (Buffer is a global on both).
const base = Buffer.from("the quick brown fox jumps over the lazy dog");

let t = performance.now();
let acc = 0;
for (let i = 0; i < 1_000_000; i++) {
  const s = base.slice(4, 9);
  acc += s.toString().length;
}
const sliceMs = performance.now() - t;

t = performance.now();
for (let i = 0; i < 100_000; i++) {
  const c = Buffer.concat([base, base]);
  acc += c.length;
}
const concatMs = performance.now() - t;

t = performance.now();
for (let i = 0; i < 100_000; i++) {
  acc += Buffer.from("hello buffer world").length;
}
const fromMs = performance.now() - t;

if (acc <= 0) throw new Error("mismatch");
console.log(`RESULT acc=${acc} ms=${(sliceMs + concatMs + fromMs).toFixed(1)} (slice+tostr ${sliceMs.toFixed(1)}, concat ${concatMs.toFixed(1)}, from ${fromMs.toFixed(1)})`);
