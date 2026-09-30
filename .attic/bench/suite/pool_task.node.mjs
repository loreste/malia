// Pool task (node variant): fib per job via worker_threads.
import { parentPort } from "node:worker_threads";
function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}
parentPort.on("message", (n) => {
  parentPort.postMessage(fib(n));
});
