// Worker side: compute fib on receipt of a number, post the result back.
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

onmessage = (e) => {
  postMessage(fib(e.data));
};
