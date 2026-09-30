// ES2024/2025/2026 feature smoke test. Each check throws on failure.
import jsonData from "./data.json" with { type: "json" };

function check(name, cond) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  console.log(`ok: ${name}`);
}

// ES2024
check("Promise.withResolvers", typeof Promise.withResolvers === "function");
const { promise, resolve } = Promise.withResolvers();
resolve(7);
check("Promise.withResolvers resolves", (await promise) === 7);

check("Object.groupBy", JSON.stringify(Object.groupBy([1, 2, 3, 4], (x) => x % 2)) === '{"0":[2,4],"1":[1,3]}');

const asyncNums = await Array.fromAsync((async function* () { yield 1; yield 2; })());
check("Array.fromAsync", asyncNums.length === 2 && asyncNums[1] === 2);

// ES2025
check("RegExp.escape", RegExp.escape("[a.b]") === "\\[a\\.b\\]");
check("Promise.try", (await Promise.try(() => 42)) === 42);
check("Float16Array", new Float16Array([1.5])[0] === 1.5);
check("Set.prototype.union", new Set([1, 2]).union(new Set([2, 3])).size === 3);
check("Iterator helpers", [1, 2, 3].values().map((x) => x * 2).toArray()[2] === 6);

// Host-provided
const cloned = structuredClone({ a: [1, { b: 2 }], d: new Date(0) });
check("structuredClone", cloned.a[1].b === 2 && cloned.d instanceof Date);

// Import attributes
check("import attributes (json)", jsonData.answer === 42);

console.log("ES FEATURES: ALL PASS");
