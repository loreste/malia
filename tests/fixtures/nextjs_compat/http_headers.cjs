"use strict";
// IncomingMessage headers as Node exposes them (Next.js reads rawHeaders and
// relies on merged duplicates).
const assert = require("assert");
const http = require("http");
const net = require("net");

const srv = http.createServer((req, res) => {
  try {
    assert.ok(Array.isArray(req.rawHeaders), "rawHeaders is an array");
    const raw = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw.push(req.rawHeaders[i].toLowerCase() + "=" + req.rawHeaders[i + 1]);
    assert.ok(raw.includes("x-dup=a") && raw.includes("x-dup=b"), "rawHeaders keeps every occurrence");
    assert.strictEqual(req.headers["x-dup"], "a, b");
    assert.strictEqual(req.headers.cookie, "a=1; b=2");
    // Implicit headers go through writeHead, so hooks (the on-headers pattern
    // compression middleware uses) can still set headers.
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      this.setHeader("x-hooked", "yes");
      return writeHead.apply(this, args);
    };
    // Writable state, as Next.js's response piping reads it.
    assert.strictEqual(res.destroyed, false);
    assert.strictEqual(res.writable, true);
    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(res.writableFinished, false);
    assert.strictEqual(res.writableNeedDrain, false);
    assert.strictEqual(res.closed, false);
    assert.strictEqual(res.write(""), true, "write returns true below the high-water mark");
    res.end("ok");
    assert.strictEqual(res.writableEnded, true);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e && e.message));
  }
});
srv.listen(0, "127.0.0.1", () => {
  const sock = net.connect(srv.address().port, "127.0.0.1", () => {
    sock.write("GET / HTTP/1.1\r\nHost: x\r\nX-Dup: a\r\nX-Dup: b\r\nCookie: a=1\r\nCookie: b=2\r\nConnection: close\r\n\r\n");
  });
  let out = "";
  sock.on("data", (d) => (out += d));
  sock.on("end", () => {
    // The body is "ok" whether sent with content-length or chunked.
    if (!/\r\nx-hooked: yes\r\n/i.test(out)) throw new Error("writeHead hook not applied: " + JSON.stringify(out.split("\r\n\r\n")[0]));
    if (!/\r\nok(\r\n|$)/.test(out)) throw new Error("server said: " + JSON.stringify(out.slice(out.indexOf("\r\n\r\n") + 4)));
    // ClientRequest emits 'close' once the response is complete (Next.js's
    // proxy waits for it before treating a proxied request as done).
    const events = [];
    const creq = http.get("http://127.0.0.1:" + srv.address().port + "/", (cres) => {
      cres.resume();
      cres.on("end", () => events.push("res end"));
    });
    // 'socket' fires before the request is sent (proxies emit proxyReq from it).
    creq.on("socket", (s) => {
      assert.ok(s && creq.socket === s, "req.socket is the emitted socket");
      events.push("socket");
    });
    creq.on("close", () => {
      events.push("req close");
      assert.deepStrictEqual(events, ["socket", "res end", "req close"]);
      // Proxy pattern (httpxy, used by Next.js rewrites): the body is piped in
      // only after 'socket', so 'socket' must fire before the request ends.
      const { Readable } = require("stream");
      const preq = http.request({ host: "127.0.0.1", port: srv.address().port, method: "POST", path: "/" }, (pres) => {
        pres.resume();
        pres.on("end", () => {
          srv.close();
          console.log("HTTP HEADERS: PASS");
        });
      });
      preq.on("socket", () => Readable.from([Buffer.from("piped")]).pipe(preq));
    });
  });
});
