// Pool worker: compute fib per job.
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

onmessage = (e) => {
  postMessage(fib(e.data));
};
