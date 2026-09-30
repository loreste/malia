// fib(35) — CPU-bound baseline. Runs on both jse and node.
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}
const t = performance.now();
const r = fib(35);
const ms = performance.now() - t;
console.log(`RESULT fib=${r} ms=${ms.toFixed(1)}`);
