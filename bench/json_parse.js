// Measures: JSON parse + stringify throughput
const obj = { users: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `user_${i}`, email: `user${i}@test.com`, active: i % 3 !== 0, scores: [i * 10, i * 20, i * 30] })) };
const json = JSON.stringify(obj);

const iterations = 5000;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const parsed = JSON.parse(json);
  JSON.stringify(parsed);
}
const elapsed = performance.now() - start;
console.log(`json: ${iterations} iterations in ${elapsed.toFixed(1)}ms (${(iterations / elapsed * 1000).toFixed(0)} ops/s)`);
