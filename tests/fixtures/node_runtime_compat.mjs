// Regressions for fs, crypto, streams, timers, events, and Blob/FormData,
// checked against Node (this file also passes under `node`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { Readable, Writable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jse-compat-"));
const file = path.join(dir, "a.txt");

// ---- fs -------------------------------------------------------------------------
fs.writeFileSync(file, "hello");
fs.writeFileSync(file, "!", { flag: "a" });
assert.equal(fs.readFileSync(file, "utf8"), "hello!");
assert.throws(() => fs.writeFileSync(file, "x", { flag: "wx" }), { code: "EEXIST" });
assert.equal(fs.readFileSync(file, "base64"), Buffer.from("hello!").toString("base64"));
fs.writeFileSync(path.join(dir, "b64.bin"), "aGk=", "base64");
assert.equal(fs.readFileSync(path.join(dir, "b64.bin"), "utf8"), "hi");
assert.throws(() => fs.copyFileSync(file, path.join(dir, "b64.bin"), fs.constants.COPYFILE_EXCL), { code: "EEXIST" });
assert.throws(() => fs.readFileSync(path.join(dir, "missing")), {
  code: "ENOENT",
  syscall: "open",
  path: path.join(dir, "missing"),
});
assert.equal(fs.statSync(path.join(dir, "missing"), { throwIfNoEntry: false }), undefined);
assert.equal(fs.mkdirSync(path.join(dir, "x", "y"), { recursive: true }), path.join(dir, "x"));
assert.deepEqual(fs.readdirSync(path.join(dir, "x"), { recursive: true }), ["y"]);
fs.cpSync(path.join(dir, "x"), path.join(dir, "x2"), { recursive: true });
assert.ok(fs.existsSync(path.join(dir, "x2", "y")));
fs.utimesSync(file, 1000, 2000);
assert.equal(fs.statSync(file).mtimeMs, 2000 * 1000);
assert.throws(() => fs.rmSync(path.join(dir, "x")), { code: "ERR_FS_EISDIR" });
fs.rmSync(dir, { recursive: true, force: true });

// ---- crypto -----------------------------------------------------------------------
// RFC 7914 test vector.
assert.equal(
  crypto.scryptSync("password", "NaCl", 64, { N: 1024, r: 8, p: 16 }).toString("hex"),
  "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
);
const h = crypto.createHash("sha256").update("a");
assert.equal(h.copy().digest("hex"), crypto.hash("sha256", "a"));
assert.throws(() => { h.digest(); h.digest(); }, { code: "ERR_CRYPTO_HASH_FINALIZED" });
const n = crypto.randomInt(5, 10);
assert.ok(n >= 5 && n < 10);

// ---- timers -----------------------------------------------------------------------
{
  const order = [];
  setTimeout(() => order.push("timeout"), 0);
  setImmediate(() => order.push("immediate"));
  Promise.resolve().then(() => order.push("micro"));
  process.nextTick(() => order.push("tick"));
  order.push("sync");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // In an ES module, promise jobs run before nextTick callbacks. Whether
  // the immediate or the 1ms timeout goes first depends on timing.
  assert.deepEqual(order.slice(0, 3), ["sync", "micro", "tick"]);
  assert.deepEqual(order.slice(3).sort(), ["immediate", "timeout"]);
  const t = setTimeout(() => {}, 1000);
  assert.equal(t.unref().hasRef(), false);
  clearTimeout(t);
}

// ---- streams & events -------------------------------------------------------------
{
  const w = new Writable({ highWaterMark: 2, write(c, e, cb) { setTimeout(cb, 1); } });
  assert.equal(w.write("abc"), false); // backpressure
  const chunks = [];
  await pipeline(Readable.from(["a", "b"]), new PassThrough(), new Writable({
    write(c, e, cb) {
      chunks.push(String(c));
      cb();
    },
  }));
  assert.deepEqual(chunks, ["a", "b"]);

  // once('data') must resume a socket, like on('data').
  const server = net.createServer((sock) => sock.on("data", () => sock.end("pong")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = net.connect(server.address().port, "127.0.0.1");
  await new Promise((resolve) => client.once("connect", resolve));
  client.write("ping");
  assert.equal(String(await new Promise((resolve) => client.once("data", resolve))), "pong");
  client.destroy();
  await new Promise((resolve) => server.close(resolve));
}

// ---- Blob / File / FormData ---------------------------------------------------------
{
  const blob = new Blob(["héllo", new Uint8Array([33])], { type: "Text/Plain" });
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.slice(1, -1).text(), "éllo");
  const form = new FormData();
  form.append("f", new Blob(["data"]), "d.bin");
  assert.equal(form.get("f").name, "d.bin");
  assert.ok(form.get("f") instanceof File);
  const res = new Response(form);
  const parsed = await res.formData();
  assert.equal(await parsed.get("f").text(), "data");
}

assert.throws(() => structuredClone(() => {}), { name: "DataCloneError" });

// Node's platform/arch names, not Rust's ("macos", "aarch64").
assert.ok(["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix"].includes(process.platform), process.platform);
assert.ok(["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64", "loong64"].includes(process.arch), process.arch);
assert.equal(os.tmpdir().endsWith(path.sep) && os.tmpdir().length > 3, false);

{
  const a = new BroadcastChannel("compat");
  const b = new BroadcastChannel("compat");
  const got = new Promise((resolve) => (b.onmessage = (event) => resolve(event.data)));
  a.postMessage({ n: 1, m: new Map([[1, 2]]) });
  const data = await got;
  assert.equal(data.n, 1);
  assert.ok(data.m instanceof Map);
  a.close();
  b.close();
  assert.throws(() => a.postMessage(1), { name: "InvalidStateError" });
}
console.log("node_runtime_compat: ok");
