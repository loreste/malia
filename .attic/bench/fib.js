// CPU benchmark: naive recursive fib.
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}
const start = performance.now();
const result = fib(35);
const ms = performance.now() - start;
console.log(`fib(35) = ${result} in ${ms.toFixed(1)}ms`);
