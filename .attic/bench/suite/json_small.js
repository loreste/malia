// Small-doc JSON: 100k parse + 100k stringify of ~1KB docs. Shared jse/node.
const sample = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "benchmark document",
  tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
  meta: { created: "2026-09-29T00:00:00Z", version: 3, flags: { a: true, b: false } },
  items: Array.from({ length: 10 }, (_, i) => ({ k: "key-" + i, v: i * 1.5, note: "lorem ipsum dolor" })),
};
const doc = JSON.stringify(sample);
if (doc.length < 500) throw new Error("doc too small: " + doc.length);

let t = performance.now();
let acc = 0;
for (let i = 0; i < 100_000; i++) {
  const obj = JSON.parse(doc);
  acc += obj.items.length;
}
const parseMs = performance.now() - t;

t = performance.now();
let len = 0;
for (let i = 0; i < 100_000; i++) {
  len = JSON.stringify(sample).length;
}
const stringifyMs = performance.now() - t;

if (acc !== 1_000_000 || len !== doc.length) throw new Error("mismatch");
console.log(`RESULT bytes=${doc.length} ms=${(parseMs + stringifyMs).toFixed(1)} (parse ${parseMs.toFixed(1)}, stringify ${stringifyMs.toFixed(1)})`);
