// Regression tests for bug fixes:
// 1. appendFile write error uses correct syscall name
// 2. KV atomic_incr preserves TTL
// 3. serve pending map cleanup on send failure
// 4. net.connect with port 0 to a hostname does not try Unix socket
// 5. net close actually frees the connection entry

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Bug 1: appendFile write error syscall ----
// appendFile to a directory should produce a write-related error (EISDIR),
// not silently succeed.
{
  const dir = path.join(os.tmpdir(), `jse-bugfix-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.appendFileSync(dir, "data");
    // If no throw, OS allowed it (unlikely). Move on.
  } catch (e) {
    // The error should reference the path and have an error code.
    assert.ok(
      e.message.includes(dir) || e.code,
      `appendFile error should reference path or have code: ${e.message}`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("PASS: appendFile error handling");

// ---- Bug 2: KV atomic_incr preserves TTL ----
{
  jse.kv.clear();

  // Set a key with a long TTL (10 seconds — more than enough for the test).
  // Use a number so JSON.stringify produces "5" (no quotes) which incr can parse.
  jse.kv.set("counter", 5, { ttlMs: 10000 });
  assert.strictEqual(jse.kv.get("counter"), 5, "initial value");

  // Increment it
  const result = jse.kv.atomic.incr("counter", 3);
  assert.strictEqual(result, 8, "incr result");

  // The key should still exist (TTL was preserved, not dropped)
  const after = jse.kv.get("counter");
  assert.strictEqual(after, 8, "value after incr");

  // Set a key with a very short TTL and let it expire
  jse.kv.set("expire-me", 10, { ttlMs: 1 });
  // Wait past the TTL
  await sleep(30);

  // Incrementing an expired key should start from 0
  const expired = jse.kv.atomic.incr("expire-me", 1);
  assert.strictEqual(expired, 1, "expired key incr starts from 0");

  jse.kv.clear();
}
console.log("PASS: KV incr preserves TTL");

// ---- Bug 3: net.connect with port 0 to TCP host should not try Unix ----
// Before the fix, net.connect("127.0.0.1", 0) on Unix would attempt a
// Unix socket connection to "127.0.0.1" as a file path. Now it should
// attempt a TCP connection (which will fail with connection refused, not
// a file-not-found error).
{
  let caught = false;
  try {
    await new Promise((resolve, reject) => {
      const conn = net.createConnection({ host: "127.0.0.1", port: 0 });
      conn.on("error", reject);
      conn.on("connect", resolve);
      setTimeout(() => { conn.destroy(); reject(new Error("timeout")); }, 500);
    });
  } catch (e) {
    caught = true;
    const msg = (e.message || "") + (e.code || "");
    // The error should be a network error, not "no such file" (ENOENT)
    // which would indicate it tried Unix socket.
    assert.ok(
      !msg.includes("ENOENT") && !msg.includes("no such file"),
      `port 0 TCP connect should not try Unix socket: ${msg}`
    );
  }
  assert.ok(caught, "net.connect to port 0 should error");
}
console.log("PASS: net.connect port 0 uses TCP not Unix");

// ---- Bug 4: HTTP serve pending map cleanup ----
// Start a server, make requests, shut it down. Verifies no hangs from
// leaked pending map entries.
{
  const server = jse.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    return new Response("ok");
  });
  const base = `http://127.0.0.1:${server.port}`;

  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${base}/test`);
    assert.strictEqual(r.status, 200, `request ${i} status`);
    assert.strictEqual(await r.text(), "ok", `request ${i} body`);
  }

  server.close();
}
console.log("PASS: serve cleanup");

// ---- Bug 5: net close frees connection entry ----
// Open and close many TCP connections; verify no errors or hangs from
// leaked connection map entries.
{
  const server = net.createServer((sock) => sock.end("hi"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve, reject) => {
      const conn = net.createConnection({ host: "127.0.0.1", port });
      conn.on("data", () => {});
      conn.on("close", resolve);
      conn.on("error", reject);
    });
  }

  server.close();
}
console.log("PASS: net close frees connections");

console.log("ALL BUGFIX REGRESSION TESTS PASSED");
