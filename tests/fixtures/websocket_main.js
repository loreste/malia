// WebSocket client/server and DOM EventTarget/Event test suite
function assert(cond, what) {
  if (!cond) throw new Error(what);
}

// 1. DOM Event classes
assert(typeof Event === "function", "Event exists");
assert(typeof CustomEvent === "function", "CustomEvent exists");
assert(typeof MessageEvent === "function", "MessageEvent exists");
assert(typeof CloseEvent === "function", "CloseEvent exists");
assert(typeof ErrorEvent === "function", "ErrorEvent exists");
assert(typeof EventTarget === "function", "EventTarget exists");
assert(typeof WebSocket === "function", "WebSocket exists");

// 2. EventTarget behavior
const target = new EventTarget();
let targetFired = 0;
const listener = (e) => {
  assert(e.type === "custom", "event type");
  targetFired++;
};
target.addEventListener("custom", listener);
target.dispatchEvent(new Event("custom"));
target.removeEventListener("custom", listener);
target.dispatchEvent(new Event("custom"));
assert(targetFired === 1, `targetFired ${targetFired}`);

// 3. WebSocket constants
assert(WebSocket.CONNECTING === 0, "CONNECTING");
assert(WebSocket.OPEN === 1, "OPEN");
assert(WebSocket.CLOSING === 2, "CLOSING");
assert(WebSocket.CLOSED === 3, "CLOSED");

// 4. WebSocket Server & Client Roundtrip
let serverSocket = null;
const serverMsgs = [];
let serverClosed = false;

const server = jse.serve({ hostname: "127.0.0.1", port: 0 }, (req) => {
  const upgrade = req.headers.get("upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    const { response, socket } = jse.upgradeWebSocket(req);
    serverSocket = socket;
    socket.onopen = () => {
      // server socket opened
    };
    socket.onmessage = (e) => {
      serverMsgs.push(e.data);
      if (typeof e.data === "string") {
        socket.send("server-echo:" + e.data);
      } else {
        // binary echo
        socket.send(e.data);
      }
    };
    socket.onclose = (e) => {
      serverClosed = true;
    };
    return response;
  }
  return new Response("Not websocket", { status: 400 });
});

const port = server.port;
assert(port > 0, `server.port ${port}`);

// Connect client
const clientMsgs = [];
let clientOpened = false;
let clientCloseEvent = null;

const client = new WebSocket(`ws://127.0.0.1:${port}/chat`);
client.binaryType = "arraybuffer";
assert(client.readyState === WebSocket.CONNECTING, "client readyState CONNECTING");

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("client connect timeout")), 3000);
  client.onopen = () => {
    clearTimeout(timeout);
    clientOpened = true;
    resolve();
  };
  client.onerror = (e) => {
    clearTimeout(timeout);
    reject(new Error("client error: " + (e.message || "unknown")));
  };
});

assert(clientOpened, "client opened");
assert(client.readyState === WebSocket.OPEN, "client readyState OPEN");

// Send text message
const textEchoPromise = new Promise((resolve) => {
  const handler = (e) => {
    client.removeEventListener("message", handler);
    resolve(e.data);
  };
  client.addEventListener("message", handler);
});
client.send("hello-jse-websocket");
const echoedText = await textEchoPromise;
assert(echoedText === "server-echo:hello-jse-websocket", `echoedText ${echoedText}`);

// Send binary message
const binEchoPromise = new Promise((resolve) => {
  const handler = (e) => {
    client.removeEventListener("message", handler);
    resolve(e.data);
  };
  client.addEventListener("message", handler);
});
const sentBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
client.send(sentBytes);
const echoedBin = await binEchoPromise;
assert(echoedBin instanceof ArrayBuffer, "echoedBin is ArrayBuffer");
const receivedBytes = new Uint8Array(echoedBin);
assert(
  receivedBytes.length === 4 &&
  receivedBytes[0] === 0xde &&
  receivedBytes[1] === 0xad &&
  receivedBytes[2] === 0xbe &&
  receivedBytes[3] === 0xef,
  `echoedBin content ${receivedBytes}`,
);

// Close from client
const closePromise = new Promise((resolve) => {
  client.onclose = (e) => {
    clientCloseEvent = e;
    resolve();
  };
});
client.close(1000, "client normal close");
await closePromise;

assert(clientCloseEvent !== null, "client close event received");
assert(clientCloseEvent.code === 1000, `client close code ${clientCloseEvent.code}`);
assert(clientCloseEvent.reason === "client normal close", `client close reason ${clientCloseEvent.reason}`);
assert(client.readyState === WebSocket.CLOSED, "client readyState CLOSED");

// Give server socket brief moment to process close
await new Promise((r) => setTimeout(r, 50));
assert(serverClosed, "server socket observed close");

server.close();
console.log("WEBSOCKET: PASS");
