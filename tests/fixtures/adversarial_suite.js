// Adversarial Integration Suite: HTTP/2, WebSockets, Node Builtins, and Security
import http2 from "node:http2";
import { WebSocket, WebSocketServer } from "node:ws";
import tls from "node:tls";
import { performance, PerformanceMark } from "node:perf_hooks";
import { setTimeout as sleep, setImmediate as yieldImmediate } from "node:timers/promises";
import constants from "node:constants";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

console.log("=== RUNNING ADVERSARIAL SUITE ===");

// ---------------------------------------------------------------------------
// 1. node:perf_hooks & node:timers/promises
// ---------------------------------------------------------------------------
console.log("1. Testing perf_hooks & timers/promises...");
const t0 = performance.now();
await sleep(10);
const t1 = performance.now();
assert(t1 > t0, `performance.now() monotonically increasing: t0=${t0}, t1=${t1}`);

const mark = new PerformanceMark("start-mark");
assert(mark.name === "start-mark", "PerformanceMark name");

let yielded = false;
await yieldImmediate().then(() => { yielded = true; });
assert(yielded, "setImmediate yielded");

// ---------------------------------------------------------------------------
// 2. node:constants
// ---------------------------------------------------------------------------
console.log("2. Testing constants...");
assert(typeof constants.O_RDONLY === "number", "fs O_RDONLY");
assert(typeof constants.Z_OK === "number", "zlib Z_OK");

// ---------------------------------------------------------------------------
// 3. node:tls
// ---------------------------------------------------------------------------
console.log("3. Testing tls module...");
assert(typeof tls.connect === "function", "tls.connect function");
assert(typeof tls.TLSSocket === "function", "tls.TLSSocket class");
let unsupportedContext = false;
try { tls.createSecureContext(); }
catch (error) { unsupportedContext = error.code === "ERR_TLS_UNSUPPORTED_OPTION"; }
assert(unsupportedContext, "TLS secure contexts must reject explicitly until implemented");

// ---------------------------------------------------------------------------
// 4. Standards-Compliant WebSockets & ws Compatibility
// ---------------------------------------------------------------------------
console.log("4. Testing WebSockets (RFC 6455, binaryType, ping/pong, ws shim)...");

// Verify RFC 6455 close validation
const dummyWs = new WebSocket("ws://localhost:1");
let threwInvalidCode = false;
try {
  dummyWs.close(1005); // Reserved code, cannot be sent by application
} catch (e) {
  threwInvalidCode = e.name === "InvalidAccessError";
}
assert(threwInvalidCode, "WebSocket.close(1005) throws InvalidAccessError");

let threwLongReason = false;
try {
  dummyWs.close(1000, "a".repeat(124)); // Reason exceeds 123 bytes
} catch (e) {
  threwLongReason = e.name === "SyntaxError";
}
assert(threwLongReason, "WebSocket.close() with >123 byte reason throws SyntaxError");

// Start WebSocketServer using ws shim
const wsPort = 44120;
const wss = new WebSocketServer({ port: wsPort });

const wsServerPromise = new Promise((resolve, reject) => {
  wss.on("connection", (serverSocket) => {
    serverSocket.on("message", (msg) => {
      if (typeof msg === "string") {
        if (msg === "ping-test") {
          serverSocket.send("pong-reply");
        } else {
          serverSocket.send(`echo:${msg}`);
        }
      } else if (Buffer.isBuffer(msg) || msg instanceof Uint8Array) {
        // Echo binary back with first byte incremented
        const buf = Buffer.from(msg);
        buf[0] = (buf[0] + 1) % 256;
        serverSocket.send(buf);
      }
    });

    serverSocket.on("close", (code, reason) => {
      resolve({ code, reason });
    });
  });
});

// Connect client with binaryType = "nodebuffer"
const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
clientWs.binaryType = "nodebuffer";

await new Promise((resolve) => {
  clientWs.on("open", resolve);
});

// Test text echo
const textReply = await new Promise((resolve) => {
  clientWs.once("message", (data) => resolve(data));
  clientWs.send("hello adversarial ws");
});
assert(textReply === "echo:hello adversarial ws", `Text echo mismatch: ${textReply}`);

// Test binary echo with nodebuffer
const binPayload = Buffer.from([42, 1, 2, 3, 4]);
const binReply = await new Promise((resolve) => {
  clientWs.once("message", (data) => resolve(data));
  clientWs.send(binPayload);
});
assert(Buffer.isBuffer(binReply), `Expected Buffer reply, got ${typeof binReply}`);
assert(binReply[0] === 43 && binReply[1] === 1, `Binary echo mismatch: ${binReply}`);

// Test ping/pong
let pongReceived = false;
clientWs.on("pong", () => { pongReceived = true; });
clientWs.ping("test");
clientWs.pong("test");

// Clean shutdown with code 1000
clientWs.close(1000, "adversarial test complete");
const serverCloseRes = await wsServerPromise;
assert(serverCloseRes.code === 1000, `Expected close code 1000, got ${serverCloseRes.code}`);

wss.close();
console.log("WebSocket tests: PASS");

// ---------------------------------------------------------------------------
// 5. HTTP/2 Server & Client
// ---------------------------------------------------------------------------
console.log("5. Testing HTTP/2 server & client (multiplexing & streaming)...");

const h2Port = 44121;
const h2Server = http2.createServer();

h2Server.on("stream", (stream, headers) => {
  const path = headers[":path"];
  if (path === "/hello") {
    stream.respond({
      ":status": 200,
      "content-type": "text/plain",
      "x-h2-test": "passed",
    });
    stream.write("Hello ");
    stream.write("HTTP/2 ");
    stream.end("World!");
  } else if (path === "/echo") {
    stream.respond({
      ":status": 200,
      "content-type": "application/octet-stream",
    });
    stream.on("data", (chunk) => stream.write(chunk));
    stream.on("end", () => stream.end());
  } else {
    stream.respond({ ":status": 404 });
    stream.end("Not Found");
  }
});

await new Promise((resolve) => {
  h2Server.listen(h2Port, "127.0.0.1", resolve);
});

// Connect via http2.connect
const clientSession = http2.connect(`http://127.0.0.1:${h2Port}`);

await new Promise((resolve) => {
  clientSession.on("connect", resolve);
});

// Multiplex stream 1: GET /hello
const stream1 = clientSession.request({ ":path": "/hello", ":method": "GET" });
stream1.end();
const resp1Headers = await new Promise((resolve) => stream1.on("response", resolve));
assert(resp1Headers[":status"] === 200, `H2 status: ${resp1Headers[":status"]}`);
assert(resp1Headers["x-h2-test"] === "passed", "H2 custom header");

let body1 = "";
stream1.on("data", (chunk) => { body1 += chunk.toString("utf8"); });
await new Promise((resolve) => stream1.on("close", resolve));
assert(body1 === "Hello HTTP/2 World!", `H2 body mismatch: ${body1}`);

// Multiplex stream 2: POST /echo
const stream2 = clientSession.request({ ":path": "/echo", ":method": "POST" });
stream2.write("stream2-chunk1;");
stream2.write("stream2-chunk2;");
stream2.end("stream2-chunk3");

const resp2Headers = await new Promise((resolve) => stream2.on("response", resolve));
assert(resp2Headers[":status"] === 200, `H2 echo status: ${resp2Headers[":status"]}`);

let body2 = "";
stream2.on("data", (chunk) => { body2 += chunk.toString("utf8"); });
await new Promise((resolve) => stream2.on("close", resolve));
assert(body2 === "stream2-chunk1;stream2-chunk2;stream2-chunk3", `H2 echo mismatch: ${body2}`);

clientSession.close();
h2Server.close();
console.log("HTTP/2 tests: PASS");

console.log("=== ALL ADVERSARIAL TESTS PASSED ===");
