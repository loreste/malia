// Regex throughput: ~1M match iterations + 200k replaces. Shared jse/node.
const text = "The quick brown fox jumps over the lazy dog 0123456789. ".repeat(500);

let t = performance.now();
let count = 0;
for (let i = 0; i < 500; i++) {
  const m = text.match(/o[a-z0-9]/g);
  count += m.length;
}
const matchMs = performance.now() - t;

t = performance.now();
let replaced = "";
for (let i = 0; i < 200; i++) {
  replaced = text.replaceAll(/fox (?<action>\w+)/g, "cat $<action>!");
}
const replaceMs = performance.now() - t;

if (count === 0 || !replaced.includes("cat jumps!")) throw new Error("regex mismatch");
console.log(`RESULT matches=${count} ms=${(matchMs + replaceMs).toFixed(1)} (match ${matchMs.toFixed(1)}, replace ${replaceMs.toFixed(1)})`);
