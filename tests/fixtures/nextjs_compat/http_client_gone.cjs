"use strict";
// A client that disconnects mid-response must not take the server down: like
// Node, the response is destroyed and emits 'close', later writes are dropped
// (their callback gets an error) and no 'error' event is raised. Next.js keeps
// streaming a page after the browser navigates away.
const assert = require("assert");
const http = require("http");
const net = require("net");

let resolveDone;

const srv = http.createServer((req, res) => {
  res.on("error", (e) => assert.fail("no 'error' event expected: " + e.message));
  res.on("close", () => {
    // Writing to a closed response is dropped, not thrown.
    let cbErr = null;
    const ret = res.write("late", (e) => (cbErr = e));
    assert.strictEqual(ret, false);
    assert.ok(res.destroyed, "destroyed after the client left");
    setTimeout(() => {
      assert.ok(cbErr, "write callback gets an error");
      res.end();
      resolveDone(req.url);
    }, 50);
  });
  if (req.url === "/before-headers") {
    // Client gone before anything was sent: the first write starts the response.
    setTimeout(() => res.write("first"), 200);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.write("chunk-0\n");
  let i = 1;
  const t = setInterval(() => {
    if (res.destroyed) return clearInterval(t);
    res.write("chunk-" + i++ + "\n");
  }, 20);
});

function hangUp(port, path, afterFirstByte) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
      if (!afterFirstByte) setTimeout(() => { sock.destroy(); resolve(); }, 50);
    });
    sock.once("data", () => { if (afterFirstByte) { sock.destroy(); resolve(); } });
  });
}

srv.listen(0, "127.0.0.1", async () => {
  const { port } = srv.address();
  for (const [path, afterFirstByte] of [["/streaming", true], ["/before-headers", false]]) {
    const done = new Promise((r) => (resolveDone = r));
    await hangUp(port, path, afterFirstByte);
    const url = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("no 'close' for " + path)), 3000))]);
    assert.strictEqual(url, path);
  }
  srv.close();
  console.log("ok");
});
