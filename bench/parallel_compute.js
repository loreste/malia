// Measures: raw single-thread compute speed (no I/O, pure V8)
// Tests: tight loop, object allocation, array operations, regex

// 1. Tight numeric loop
const N = 50_000_000;
let start = performance.now();
let sum = 0;
for (let i = 0; i < N; i++) sum += i;
let elapsed = performance.now() - start;
console.log(`tight loop (${(N/1e6).toFixed(0)}M): ${elapsed.toFixed(1)}ms`);

// 2. Object allocation + GC pressure
const OBJ_COUNT = 500_000;
start = performance.now();
const arr = [];
for (let i = 0; i < OBJ_COUNT; i++) {
  arr.push({ id: i, name: `item_${i}`, tags: [i % 3, i % 5] });
}
elapsed = performance.now() - start;
console.log(`object alloc (${(OBJ_COUNT/1000).toFixed(0)}k): ${elapsed.toFixed(1)}ms`);

// 3. Array sort
start = performance.now();
arr.sort((a, b) => b.id - a.id);
elapsed = performance.now() - start;
console.log(`array sort (${(OBJ_COUNT/1000).toFixed(0)}k): ${elapsed.toFixed(1)}ms`);

// 4. Regex matching
const TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(1000);
const RE = /\b\w{4,}\b/g;
const REGEX_ROUNDS = 500;
start = performance.now();
let matches = 0;
for (let i = 0; i < REGEX_ROUNDS; i++) {
  const m = TEXT.match(RE);
  matches += m.length;
}
elapsed = performance.now() - start;
console.log(`regex (${REGEX_ROUNDS} rounds): ${elapsed.toFixed(1)}ms (${matches} matches)`);
