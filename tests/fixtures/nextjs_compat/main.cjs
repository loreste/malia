"use strict";
// Node behaviors the Next.js production server relies on at startup.
const assert = require("assert");

// 1. An optional native addon behind a lazy require: unreachable code must not
//    abort the process, and a failed load must be catchable.
function loadAddon() { return require("fakeaddon"); }
let caught = null;
try { loadAddon(); } catch (e) { caught = e; }
assert.ok(caught, "loading an unsupported native addon must throw");

// 2. CommonJS with a nested template literal containing `import`.
assert.ok(require("./gen.js").code.includes("require('path')"));

// 3. require.extensions is Module._extensions and hookable.
const Module = require("module");
assert.strictEqual(typeof require.extensions, "object");
assert.strictEqual(require.extensions, Module._extensions);
assert.strictEqual(typeof require.extensions[".js"], "function");

// 4. require.resolve works for specifiers the static scan didn't see.
const spec = ["./", "gen", ".js"].join("");
assert.ok(require.resolve(spec).endsWith("gen.js"), "computed require.resolve");
assert.ok(require.resolve("assert"), "builtin require.resolve");

// 5. process is a full EventEmitter.
const calls = [];
const a = () => calls.push("a");
const b = () => calls.push("b");
process.on("custom", a);
process.prependListener("custom", b);
process.emit("custom");
assert.deepStrictEqual(calls, ["b", "a"]);
process.prependOnceListener("custom", () => calls.push("once"));
process.emit("custom");
process.emit("custom");
assert.deepStrictEqual(calls, ["b", "a", "once", "b", "a", "b", "a"]);
assert.ok(process.eventNames().includes("custom"));
process.removeAllListeners("custom");
assert.strictEqual(process.listenerCount("custom"), 0);
assert.strictEqual(process.setMaxListeners(20), process);
assert.strictEqual(process.getMaxListeners(), 20);

// 7. Runtime require (computed paths, as Next.js loads its build manifests):
//    JSON is parsed, relative requires resolve from the child's directory,
//    and errors thrown by the module body are not reported as not-found.
const at = (f) => require("path").join(__dirname, f);
assert.strictEqual(require(at("data.json")).answer, 42);
assert.strictEqual(require(at("sub/child.js")).sibling, "sibling");
assert.strictEqual(require(at("sub/uses_builtins.js")).ok, true);
assert.throws(() => require(at("sub/throws.js")), (e) => e instanceof TypeError && /boom/.test(e.message));

// 8. http.ServerResponse has the internal _implicitHeader that compression
//    middleware calls.
assert.strictEqual(typeof require("http").ServerResponse.prototype._implicitHeader, "function");

// 9. Request subclasses may define url/method getters (NextRequest does).
class SubRequest extends Request {
  get url() { return "https://override.example/"; }
}
const sr = new SubRequest("https://real.example/path", { method: "post" });
assert.strictEqual(sr.url, "https://override.example/");
assert.strictEqual(sr.method, "POST");
const plain = new Request("https://real.example/path");
assert.strictEqual(plain.url, "https://real.example/path");
assert.strictEqual(new Request(plain).url, "https://real.example/path");

// 10. TextEncoder.encodeInto (React's streaming renderer writes every chunk
//     with it): whole characters only, read in UTF-16 units, written in bytes.
const te = new TextEncoder();
assert.strictEqual(te.encoding, "utf-8");
const into = (str, size) => { const buf = new Uint8Array(size); const r = te.encodeInto(str, buf); return [r.read, r.written, Array.from(buf.subarray(0, r.written))]; };
assert.deepStrictEqual(into("hi", 8), [2, 2, [104, 105]]);
assert.deepStrictEqual(into("héllo", 2), [1, 1, [104]]);
assert.deepStrictEqual(into("a😀b", 4), [1, 1, [97]]);
assert.deepStrictEqual(into("a😀b", 5), [3, 5, [97, 240, 159, 152, 128]]);
assert.deepStrictEqual(into("x\uD800y", 8), [3, 5, [120, 239, 191, 189, 121]]);

// 11. Headers iterate with lowercase names in sorted order, set-cookie values
//     separately (WHATWG); Next.js maps proxy request headers by these names.
const hd = new Headers({ "X-B": "2", "Content-Security-Policy": "x" });
hd.set("X-A", "1");
hd.append("x-b", "3");
hd.append("Set-Cookie", "a=1");
hd.append("set-cookie", "b=2");
assert.deepStrictEqual([...hd], [["content-security-policy", "x"], ["set-cookie", "a=1"], ["set-cookie", "b=2"], ["x-a", "1"], ["x-b", "2, 3"]]);
assert.deepStrictEqual([...hd.keys()], ["content-security-policy", "set-cookie", "set-cookie", "x-a", "x-b"]);
const seen = [];
hd.forEach((v, k) => seen.push(k + "=" + v));
assert.strictEqual(seen.join(";"), "content-security-policy=x;set-cookie=a=1;set-cookie=b=2;x-a=1;x-b=2, 3");

// 12. fs.ReadStream / fs.WriteStream classes (send, used for static files,
//     checks instanceof fs.ReadStream and calls close()).
const fs = require("fs");
const rs = fs.createReadStream(__filename);
assert.ok(rs instanceof fs.ReadStream, "createReadStream returns a ReadStream");
assert.strictEqual(typeof rs.close, "function");
assert.strictEqual(rs.path, __filename);
rs.close();
assert.strictEqual(typeof fs.WriteStream, "function");

// 13. ServerResponse stream state and destroy() (compression and send call them).
const srp = require("http").ServerResponse.prototype;
for (const m of ["destroy", "cork", "uncork"]) assert.strictEqual(typeof srp[m], "function", "ServerResponse." + m);

// 14. Buffer is callable without `new` (deprecated in Node, but safe-buffer,
//     used by compression middleware, does it); subclasses still work.
/* eslint-disable no-buffer-constructor */
assert.strictEqual(Buffer("abc").toString(), "abc");
assert.strictEqual(Buffer(4).length, 4);
assert.ok(Buffer("x") instanceof Buffer && Buffer.from("y") instanceof Buffer);
assert.strictEqual(new Buffer("z").toString(), "z");
class SubBuffer extends Buffer {}
const sb = new SubBuffer(2);
assert.ok(sb instanceof Buffer && Buffer.isBuffer(sb) && sb.length === 2);
assert.strictEqual(Buffer.name, "Buffer");
for (const k of ["from", "alloc", "isBuffer", "concat", "byteLength"]) assert.ok(Object.prototype.hasOwnProperty.call(Buffer, k), "Buffer." + k + " is an own property");
assert.strictEqual(Buffer.from("ab").constructor, Buffer);

// 15. zlib streams have flush(), which compression middleware calls after
//     each chunk so streamed HTML reaches the browser promptly.
{
  const zlib = require("zlib");
  const gz = zlib.createGzip();
  const parts = [];
  gz.on("data", (c) => parts.push(c));
  assert.strictEqual(typeof gz.flush, "function");
  gz.write("first chunk ");
  gz.flush(() => {
    // Everything written so far decodes, before the stream ends.
    const sofar = Buffer.concat(parts);
    assert.ok(sofar.length > 0, "flush produced output");
    const gunzip = zlib.createGunzip();
    let partial = "";
    gunzip.on("data", (d) => (partial += d));
    gunzip.write(sofar);
    setTimeout(() => {
      assert.strictEqual(partial, "first chunk ", "flushed bytes decode on their own");
      gz.end("second");
    }, 50);
  });
  gz.on("end", () => assert.strictEqual(zlib.gunzipSync(Buffer.concat(parts)).toString(), "first chunk second"));
}

// 16. Body streams are WHATWG ReadableStreams (Next.js pipes proxied API
//     responses with body.pipeTo); bodiless requests/responses have null.
{
  const resp = new Response("streamed body");
  assert.ok(resp.body instanceof ReadableStream);
  assert.strictEqual(resp.body, resp.body, "body is the same stream each time");
  const got = [];
  resp.body.pipeTo(new WritableStream({ write(c) { got.push(...c); } })).then(() => {
    assert.strictEqual(Buffer.from(got).toString(), "streamed body");
  });
  assert.strictEqual(new Response(null).body, null);
  assert.strictEqual(new Request("https://x.example/").body, null);
  assert.ok(new Request("https://x.example/", { method: "POST", body: "b" }).body instanceof ReadableStream);
}

// 17. Connection errors carry Node's codes (proxies and retry logic branch on them).
require("net").connect({ host: "127.0.0.1", port: 1 }).on("error", (e) => {
  assert.strictEqual(e.code, "ECONNREFUSED");
  assert.strictEqual(e.syscall, "connect");
  assert.strictEqual(e.port, 1);
});

// 6. Server-side globals: isomorphic code checks `typeof window`.
assert.strictEqual(typeof window, "undefined");
assert.strictEqual(typeof self, "undefined");

console.log("NEXTJS COMPAT: PASS");
