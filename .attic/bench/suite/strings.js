// String building: 1M concatenations. Runs on both jse and node.
const t = performance.now();
let s = "";
for (let i = 0; i < 1_000_000; i++) {
  s += "x";
}
const ms = performance.now() - t;
if (s.length !== 1_000_000) throw new Error("length mismatch");
console.log(`RESULT len=${s.length} ms=${ms.toFixed(1)}`);
