// Adversarial test suite for node:cluster, SO_REUSEPORT port-sharing, and child_process.fork
import assert from "node:assert";
import cluster from "node:cluster";
import http from "node:http";
import path from "node:path";
import { fork as cpFork } from "node:child_process";

console.log("=== CLUSTER & CONCURRENCY SCALING ADVERSARIAL TEST ===");

// 1. Primary process cluster invariants
console.log("1. Testing cluster primary invariants...");
assert.strictEqual(cluster.isPrimary, true, "Must be primary");
assert.strictEqual(cluster.isMaster, true, "Must be master");
assert.strictEqual(cluster.isWorker, false, "Must not be worker");
assert.strictEqual(cluster.worker, undefined, "Primary has no cluster.worker");
assert.deepStrictEqual(cluster.workers, {}, "Initial cluster.workers must be empty");
assert.strictEqual(cluster.SCHED_RR, 1);
assert.strictEqual(cluster.SCHED_NONE, 2);

// 2. SO_REUSEPORT port sharing validation
// In standard Node without cluster handle-passing, two servers binding the same
// port throw EADDRINUSE. In jse, SO_REUSEPORT allows multiple servers to bind the
// exact same port simultaneously with kernel-level connection balancing!
console.log("2. Testing SO_REUSEPORT port-sharing concurrency...");
const TEST_PORT = 24981;
const server1 = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain", "X-Server": "1" });
  res.end("server1");
});
const server2 = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain", "X-Server": "2" });
  res.end("server2");
});

await new Promise((resolve) => server1.listen(TEST_PORT, "127.0.0.1", resolve));
await new Promise((resolve) => server2.listen(TEST_PORT, "127.0.0.1", resolve));

// Both servers are listening on the same port! Send multiple requests.
for (let i = 0; i < 4; i++) {
  const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
  assert.strictEqual(resp.status, 200, "Request to shared SO_REUSEPORT port succeeded");
  const text = await resp.text();
  assert.ok(text === "server1" || text === "server2", "Response handled by one of the shared listeners");
}

await new Promise((resolve) => server1.close(resolve));
await new Promise((resolve) => server2.close(resolve));
console.log("SO_REUSEPORT: PASS");

// 3. Child process fork & two-way IPC messaging
console.log("3. Testing child_process.fork() IPC ping-pong...");
const workerPath = path.resolve(import.meta.dirname, "cluster_worker.js");
const child = cpFork(workerPath);

const pongPromise = new Promise((resolve, reject) => {
  child.on("message", (msg) => {
    if (msg.cmd === "pong") {
      resolve(msg);
    }
  });
  child.on("error", reject);
});

child.send({ cmd: "ping", payload: "jse-ipc-test" });

const pongMsg = await pongPromise;
assert.strictEqual(pongMsg.payload, "jse-ipc-test", "IPC ping-pong message payload matches");

// Gracefully shutdown child
const childExitPromise = new Promise((resolve) => child.on("exit", resolve));
child.send({ cmd: "shutdown" });
await childExitPromise;
console.log("child_process.fork IPC: PASS");

// 4. node:cluster fork and lifecycle events
console.log("4. Testing node:cluster fork() lifecycle...");
cluster.setupPrimary({ exec: workerPath });

let forkFired = false;
cluster.once("fork", () => {
  forkFired = true;
});

const worker = cluster.fork();
assert.ok(worker.id > 0, "Worker assigned unique ID");
assert.ok(cluster.workers[worker.id] === worker, "Worker registered in cluster.workers");

const workerPongPromise = new Promise((resolve) => {
  worker.on("message", (msg) => {
    if (msg.cmd === "pong") resolve(msg);
  });
});

worker.send({ cmd: "ping", payload: "cluster-worker-test" });

const workerPong = await workerPongPromise;
assert.strictEqual(workerPong.payload, "cluster-worker-test", "Cluster worker received & responded");

const exitPromise = new Promise((resolve) => {
  cluster.once("exit", (deadWorker, code) => {
    assert.strictEqual(deadWorker.id, worker.id, "Correct worker in exit event");
    assert.strictEqual(cluster.workers[deadWorker.id], undefined, "Worker removed from cluster.workers");
    resolve();
  });
});

worker.send({ cmd: "shutdown" });
await exitPromise;

console.log("node:cluster lifecycle: PASS");
console.log("=== ALL CLUSTER & CONCURRENCY TESTS PASSED ===");
