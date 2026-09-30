// Adversarial test suite for logging, failure recovery, panic isolation, and server resilience.
import assert from "node:assert";
import http from "node:http";

console.log("[logging_resilience_adversarial] Starting comprehensive verification...");

// =========================================================================
// 1. Application-Level Structured Logging (jse.log)
// =========================================================================
console.log("  -> Testing jse.log API and configuration...");

assert(globalThis.jse, "globalThis.jse exists");
assert(globalThis.jse.log, "globalThis.jse.log exists");
const { log } = globalThis.jse;

// Level getter & setter
const initialLevel = log.level;
assert(typeof initialLevel === "string", "log.level is string");

log.level = "debug";
assert.strictEqual(log.level, "debug", "log.level set to debug");

log.level = "warn";
assert.strictEqual(log.level, "warn", "log.level set to warn");

// Format getter & setter
const initialFormat = log.format;
assert(initialFormat === "text" || initialFormat === "json", "format is text or json");

log.format = "json";
assert.strictEqual(log.format, "json", "format set to json");

log.format = "text";
assert.strictEqual(log.format, "text", "format set to text");

// HTTP logging toggle
log.http = true;
assert.strictEqual(log.http, true, "log.http set to true");

log.http = false;
assert.strictEqual(log.http, false, "log.http set to false");

// Reconfigure method
log.configure({ level: "info", format: "text", http: true });
assert.strictEqual(log.level, "info", "configure level");
assert.strictEqual(log.format, "text", "configure format");
assert.strictEqual(log.http, true, "configure http");

// Calling logger methods (must not throw under any level)
log.debug("test", "Debug message (should be filtered under info level)");
log.info("test", "Info message with values:", 42, true, { a: 1 });
log.warn("test", "Warning message with details:", "HIGH_LOAD");
log.error("test", "Error message with error context:", new Error("Sample error").message);

// Console integration check
console.debug("Console debug test");
console.info("Console info test");
console.warn("Console warn test");
console.error("Console error test");

// =========================================================================
// 2. Process Failure Handling (uncaughtException & unhandledRejection)
// =========================================================================
console.log("  -> Testing process uncaughtException & unhandledRejection hooks...");

assert.strictEqual(typeof process.listenerCount, "function", "process.listenerCount is a function");
assert.strictEqual(typeof process.rawListeners, "function", "process.rawListeners is a function");

let uncaughtHandled = false;
let uncaughtReceived = null;
const uncaughtHandler = (err, origin) => {
  uncaughtHandled = true;
  uncaughtReceived = err;
};

process.on("uncaughtException", uncaughtHandler);
assert.strictEqual(process.listenerCount("uncaughtException"), 1, "listenerCount is 1");

const testErr = new Error("Simulated uncaught exception");
const dispatched = process._dispatchException(testErr);
assert.strictEqual(dispatched, true, "exception was dispatched to listener");
assert.strictEqual(uncaughtHandled, true, "uncaughtHandler was called");
assert.strictEqual(uncaughtReceived, testErr, "received exact error object");

let rejectionHandled = false;
let rejectionReason = null;
const rejectionHandler = (reason, promise) => {
  rejectionHandled = true;
  rejectionReason = reason;
};

process.on("unhandledRejection", rejectionHandler);
assert.strictEqual(process.listenerCount("unhandledRejection"), 1, "listenerCount is 1 for unhandledRejection");

const testReason = new Error("Simulated unhandled rejection");
const rejectionDispatched = process._dispatchUnhandledRejection(testReason, Promise.resolve());
assert.strictEqual(rejectionDispatched, true, "rejection was dispatched to listener");
assert.strictEqual(rejectionHandled, true, "rejectionHandler was called");
assert.strictEqual(rejectionReason, testReason, "received exact rejection reason");

// =========================================================================
// 3. Timer Exception Isolation
// =========================================================================
console.log("  -> Testing timer exception isolation...");

// When a timer throws, with uncaughtException listener registered, the exception
// is dispatched and the timer pump loop does NOT crash.
let timerUncaughtFired = false;
const timerHandler = (err) => {
  if (err && err.message === "Timer failure test") {
    timerUncaughtFired = true;
  }
};
process.on("uncaughtException", timerHandler);

let subsequentTimerFired = false;
await new Promise((resolve) => {
  // First timer throws
  setTimeout(() => {
    throw new Error("Timer failure test");
  }, 5);

  // Subsequent timer MUST fire normally
  setTimeout(() => {
    subsequentTimerFired = true;
    resolve();
  }, 25);
});

assert.strictEqual(timerUncaughtFired, true, "uncaught exception in timer was caught by process handler");
assert.strictEqual(subsequentTimerFired, true, "subsequent timer executed cleanly without loop crash");

// Clean up test listener
process.off("uncaughtException", timerHandler);

// =========================================================================
// 4. HTTP Server Failure & Error Resilience (jse.serve)
// =========================================================================
console.log("  -> Testing jse.serve error resilience and request logging...");

const servePort = 19472;
const server = jse.serve({ port: servePort, log: true }, async (req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/sync-crash") {
    throw new Error("Deliberate synchronous handler crash");
  }
  if (url.pathname === "/async-crash") {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error("Deliberate asynchronous handler crash");
  }
  if (url.pathname === "/ok") {
    return new Response("healthy", { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

// 1. Healthy request
const okRes1 = await fetch(`http://127.0.0.1:${server.port}/ok`);
assert.strictEqual(okRes1.status, 200, "healthy request returns 200");
assert.strictEqual(await okRes1.text(), "healthy");

// 2. Synchronous throwing route: must return 500 and NOT crash server
const syncCrashRes = await fetch(`http://127.0.0.1:${server.port}/sync-crash`);
assert.strictEqual(syncCrashRes.status, 500, "sync throw returns 500 status");

// 3. Asynchronous throwing route: must return 500 and NOT crash server
const asyncCrashRes = await fetch(`http://127.0.0.1:${server.port}/async-crash`);
assert.strictEqual(asyncCrashRes.status, 500, "async throw returns 500 status");

// 4. Server MUST still be completely operational
const okRes2 = await fetch(`http://127.0.0.1:${server.port}/ok`);
assert.strictEqual(okRes2.status, 200, "server remains operational after multiple failures");
assert.strictEqual(await okRes2.text(), "healthy");

server.close();

// =========================================================================
// 5. Node.js HTTP Server Error Resilience (node:http)
// =========================================================================
console.log("  -> Testing node:http error resilience...");

const nodeHttpServer = http.createServer((req, res) => {
  if (req.url === "/node-crash") {
    throw new Error("Deliberate node:http handler crash");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("node-ok");
});

await new Promise((resolve) => {
  nodeHttpServer.listen(0, "127.0.0.1", resolve);
});
const nodePort = nodeHttpServer.address().port;

// 1. Node request listener throwing error: server sends 500 and doesn't break
const nodeCrashRes = await fetch(`http://127.0.0.1:${nodePort}/node-crash`);
assert.strictEqual(nodeCrashRes.status, 500, "node:http throwing handler returns 500");

// 2. Subsequent request succeeds
const nodeOkRes = await fetch(`http://127.0.0.1:${nodePort}/node-ok`);
assert.strictEqual(nodeOkRes.status, 200, "node:http server continues serving after error");
assert.strictEqual(await nodeOkRes.text(), "node-ok");

await new Promise((resolve) => nodeHttpServer.close(resolve));

console.log("[logging_resilience_adversarial] ALL failure handling, panic isolation & logging tests passed successfully!");
