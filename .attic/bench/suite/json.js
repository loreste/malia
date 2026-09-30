// JSON roundtrip of a ~10MB payload. Runs on both jse and node.
const arr = [];
for (let i = 0; i < 100000; i++) {
  arr.push({ id: i, name: "item-" + i, tags: ["alpha", "beta", "gamma"], active: i % 2 === 0, score: i * 1.5 });
}
let t = performance.now();
const text = JSON.stringify(arr);
const stringifyMs = performance.now() - t;
t = performance.now();
const back = JSON.parse(text);
const parseMs = performance.now() - t;
if (back.length !== arr.length) throw new Error("roundtrip mismatch");
console.log(`RESULT bytes=${text.length} ms=${(stringifyMs + parseMs).toFixed(1)} (stringify ${stringifyMs.toFixed(1)}, parse ${parseMs.toFixed(1)})`);
