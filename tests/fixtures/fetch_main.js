// fetch fixture: the Rust test starts a local HTTP server and writes its
// port to tests/fixtures/.fetch_port before running this file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const port = readFileSync(fileURLToPath(new URL(".fetch_port", import.meta.url)), "utf8").trim();
const base = `http://127.0.0.1:${port}`;

// GET text.
const r1 = await fetch(`${base}/text`);
assertEq(r1.status, 200, "GET /text status");
if (!r1.ok) throw new Error("r1 not ok");
assertEq(await r1.text(), "hello jse", "GET /text body");
assertEq(r1.headers.get("content-type"), "text/plain", "content-type header");
if (r1.headers.get("X-CUSTOM") !== "yes") throw new Error("custom header case-insensitivity");

// GET json.
const r2 = await fetch(`${base}/json`);
const j = await r2.json();
assertEq(j.answer, 42, "GET /json body");

// 404.
const r3 = await fetch(`${base}/missing`);
assertEq(r3.status, 404, "GET /missing status");
if (r3.ok) throw new Error("404 should not be ok");

// POST echo (string body + request headers).
const r4 = await fetch(`${base}/echo`, {
  method: "POST",
  headers: { "x-test": "abc" },
  body: "ping-pong",
});
assertEq(await r4.text(), "ping-pong", "POST /echo body");
assertEq(r4.headers.get("x-seen"), "abc", "server saw request header");

// arrayBuffer + Uint8Array body.
const r5 = await fetch(`${base}/text`);
const ab = await r5.arrayBuffer();
if (!(ab instanceof ArrayBuffer)) throw new Error("arrayBuffer type");
assertEq(new TextDecoder().decode(ab), "hello jse", "arrayBuffer body");
const r6 = await fetch(`${base}/echo`, { method: "PUT", body: new Uint8Array([104, 105]) });
assertEq(await r6.text(), "hi", "PUT bytes body");

// Body reuse throws.
let threw = false;
try {
  await r1.text();
} catch {
  threw = true;
}
if (!threw) throw new Error("body reuse did not throw");

// Streaming body over a chunked endpoint: async iteration + getReader.
{
  const res = await fetch(`${base}/chunks`);
  let joined = "";
  let chunks = 0;
  for await (const chunk of res.body) {
    chunks++;
    joined += new TextDecoder().decode(chunk);
  }
  assertEq(joined, "aaabbc", "chunked body");
  if (chunks < 1) throw new Error("no chunks yielded");

  const res2 = await fetch(`${base}/chunks`);
  const reader = res2.body.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
  }
  assertEq(total, 6, "getReader bytes");

  // Whole-body helpers still work on a streamed response.
  const res3 = await fetch(`${base}/chunks`);
  assertEq(await res3.text(), "aaabbc", "text() on stream");
}

// Redirects
{
  // 1. follow (default)
  const rFollow = await fetch(`${base}/redirect`);
  assertEq(rFollow.status, 200, "redirect follow status");
  assertEq(await rFollow.text(), "hello jse", "redirect follow text");
  assertEq(rFollow.redirected, true, "rFollow.redirected");

  // 2. manual
  const rManual = await fetch(`${base}/redirect`, { redirect: "manual" });
  assertEq(rManual.status, 302, "redirect manual status");
  assertEq(rManual.redirected, false, "rManual.redirected");

  // 3. error
  let redirErr = false;
  try {
    await fetch(`${base}/redirect`, { redirect: "error" });
  } catch {
    redirErr = true;
  }
  if (!redirErr) throw new Error("redirect: error did not throw");
}

console.log("FETCH: PASS");
