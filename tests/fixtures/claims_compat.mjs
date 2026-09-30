// Covers README claims no other fixture exercises: abort signals, text
// streams, the remaining WebCrypto algorithms, inspector, readline,
// string_decoder, stream compose, fetch decompression, and jse.serve TLS.
import assert from "node:assert/strict";
import inspector from "node:inspector";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { Readable, Transform, Writable, compose } from "node:stream";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- AbortController / AbortSignal ---------------------------------------------
{
  const controller = new AbortController();
  let fired = 0;
  controller.signal.addEventListener("abort", () => fired++);
  controller.abort("stop");
  controller.abort("again");
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, "stop");
  assert.equal(fired, 1);
  assert.throws(() => controller.signal.throwIfAborted(), (e) => e === "stop");

  const timed = AbortSignal.timeout(5);
  await new Promise((resolve) => timed.addEventListener("abort", resolve));
  assert.equal(timed.reason.name, "TimeoutError");

  const a = new AbortController();
  const any = AbortSignal.any([a.signal, new AbortController().signal]);
  a.abort("first");
  assert.equal(any.aborted, true);
  assert.equal(any.reason, "first");
  assert.equal(AbortSignal.abort().reason.name, "AbortError");

  // A listener registered with a signal is removed when it aborts.
  const target = new EventTarget();
  const remove = new AbortController();
  let calls = 0;
  target.addEventListener("x", () => calls++, { signal: remove.signal });
  target.dispatchEvent(new Event("x"));
  remove.abort();
  target.dispatchEvent(new Event("x"));
  assert.equal(calls, 1);
}

// ---- TextEncoderStream / TextDecoderStream -------------------------------------------
{
  const bytes = new TextEncoder().encode("h€llo");
  const source = new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, 2)); // splits the multi-byte "€"
      c.enqueue(bytes.slice(2));
      c.close();
    },
  });
  let text = "";
  for await (const chunk of source.pipeThrough(new TextDecoderStream())) text += chunk;
  assert.equal(text, "h€llo");

  const encoded = [];
  const strings = new ReadableStream({ start(c) { c.enqueue("ab"); c.enqueue("€"); c.close(); } });
  for await (const chunk of strings.pipeThrough(new TextEncoderStream())) encoded.push(...chunk);
  assert.deepEqual(encoded, [...new TextEncoder().encode("ab€")]);
}

// ---- Timeout.refresh -----------------------------------------------------------------
{
  const start = performance.now();
  const fired = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(performance.now() - start), 40);
    setTimeout(() => t.refresh(), 25);
  });
  assert.ok(fired >= 60, `refresh re-armed the timer (fired after ${fired.toFixed(1)}ms)`);
}

// ---- WebCrypto algorithms not covered elsewhere --------------------------------------
{
  const { subtle } = globalThis.crypto;
  const data = new TextEncoder().encode("claims");
  const rsa = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

  const oaep = await subtle.generateKey({ name: "RSA-OAEP", ...rsa }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const sealed = await subtle.encrypt({ name: "RSA-OAEP" }, oaep.publicKey, data);
  assert.equal(new TextDecoder().decode(await subtle.decrypt({ name: "RSA-OAEP" }, oaep.privateKey, sealed)), "claims");

  const aes = await subtle.generateKey({ name: "AES-CBC", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cbc = await subtle.encrypt({ name: "AES-CBC", iv }, aes, data);
  assert.equal(new TextDecoder().decode(await subtle.decrypt({ name: "AES-CBC", iv }, aes, cbc)), "claims");

  // wrapKey/unwrapKey: an AES key wrapped with RSA-OAEP, as raw and as JWK.
  for (const format of ["raw", "jwk"]) {
    const wrapped = await subtle.wrapKey(format, aes, oaep.publicKey, { name: "RSA-OAEP" });
    const unwrapped = await subtle.unwrapKey(format, wrapped, oaep.privateKey, { name: "RSA-OAEP" }, "AES-CBC", true, ["decrypt"]);
    assert.equal(new TextDecoder().decode(await subtle.decrypt({ name: "AES-CBC", iv }, unwrapped, cbc)), "claims", format);
  }

  const ctrKey = await subtle.generateKey({ name: "AES-CTR", length: 128 }, false, ["encrypt", "decrypt"]);
  const ctr = { name: "AES-CTR", counter: new Uint8Array(16), length: 64 };
  const ctrSealed = await subtle.encrypt(ctr, ctrKey, data);
  assert.equal(ctrSealed.byteLength, data.byteLength);
  assert.equal(new TextDecoder().decode(await subtle.decrypt(ctr, ctrKey, ctrSealed)), "claims");

  const pss = await subtle.generateKey({ name: "RSA-PSS", ...rsa }, false, ["sign", "verify"]);
  const pssSig = await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, pss.privateKey, data);
  assert.equal(await subtle.verify({ name: "RSA-PSS", saltLength: 32 }, pss.publicKey, pssSig, data), true);

  const ed = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const edSig = await subtle.sign("Ed25519", ed.privateKey, data);
  const raw = await subtle.exportKey("raw", ed.publicKey);
  assert.equal(raw.byteLength, 32);
  const edPub = await subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
  assert.equal(await subtle.verify("Ed25519", edPub, edSig, data), true);
  assert.equal(await subtle.verify("Ed25519", edPub, edSig, new TextEncoder().encode("other")), false);
}

// ---- sleep cancellation and the less common hashes -------------------------------------
{
  const controller = new AbortController();
  const pending = sleep(10_000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });

  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha224").update("abc").digest("hex"), "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7");
  assert.equal(
    createHash("sha512-256").update("abc").digest("hex"),
    "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23",
  );
}

// ---- inspector ---------------------------------------------------------------------
assert.equal(typeof inspector.Session, "function");
assert.equal(typeof inspector.open, "function");
assert.equal(inspector.url(), undefined);

// ---- readline ------------------------------------------------------------------------
{
  const input = Readable.from(["first line\nsecond", " line\nthird\n"]);
  const lines = [];
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  assert.deepEqual(lines, ["first line", "second line", "third"]);

  const rlp = readlinePromises.createInterface({ input: Readable.from(["answer\n"]) });
  const events = [];
  rlp.on("line", (line) => events.push(line));
  await new Promise((resolve) => rlp.once("close", resolve));
  assert.deepEqual(events, ["answer"]);
}

// ---- string_decoder -------------------------------------------------------------------
{
  const decoder = new StringDecoder("utf8");
  const euro = Buffer.from("€");
  assert.equal(decoder.write(euro.subarray(0, 1)), "");
  assert.equal(decoder.write(euro.subarray(1)), "€");
  assert.equal(new StringDecoder("hex").write(Buffer.from([0xab])), "ab");
  assert.equal(new StringDecoder("base64").end(Buffer.from("hi")), "aGk=");
}

// ---- stream compose -------------------------------------------------------------------
{
  const upper = new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } });
  const exclaim = new Transform({ transform(c, e, cb) { cb(null, `${c}!`); } });
  const chunks = [];
  for await (const chunk of Readable.from(["a", "b"]).pipe(compose(upper, exclaim))) chunks.push(String(chunk));
  // Chunk boundaries depend on buffering; the content does not.
  assert.equal(chunks.join(""), "A!B!");
}

// ---- fetch decompresses gzip/deflate/brotli responses ---------------------------------
{
  const body = "compressed body ".repeat(50);
  const encoders = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
  const server = jse.serve({ port: 23531, hostname: "127.0.0.1" }, (req) => {
    const encoding = new URL(req.url, "http://x").searchParams.get("e");
    return new Response(encoders[encoding](body), { headers: { "content-encoding": encoding } });
  });
  for (const encoding of Object.keys(encoders)) {
    assert.equal(await (await fetch(`http://127.0.0.1:23531/?e=${encoding}`)).text(), body, encoding);
  }
  server.close();
}

// ---- http/https Agent ----------------------------------------------------------------
{
  const http = await import("node:http");
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  assert.ok(agent instanceof http.Agent);
  assert.equal(agent.defaultPort, 443);
  assert.equal(agent.maxSockets, 4);
  assert.ok(https.globalAgent instanceof https.Agent);
  assert.equal(http.globalAgent.defaultPort, 80);
}

// ---- fixes found by the database driver suite ----------------------------------------
{
  // Buffer[Symbol.species] views an ArrayBuffer range (undici).
  const ab = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  assert.deepEqual([...new Buffer[Symbol.species](ab, 1, 3)], [2, 3, 4]);
  // Prototype methods are enumerable (mysql2 mocks them with for...in).
  const names = [];
  for (const name in Buffer.prototype) names.push(name);
  assert.ok(names.includes("writeUInt32LE"));

  const http = await import("node:http");
  assert.equal(http.STATUS_CODES[404], "Not Found");
  assert.equal(http.maxHeaderSize, 16384);
  assert.throws(() => http.validateHeaderName("bad name"), { code: "ERR_INVALID_HTTP_TOKEN" });

  // The client response is a Readable; a numeric-string port connects.
  const server = jse.serve({ port: 23533, hostname: "127.0.0.1" }, () => new Response("piped"));
  const res = await new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: "23533", path: "/" }, resolve).on("error", reject);
  });
  const chunks = [];
  await new Promise((resolve) => res.pipe(new Writable({
    write(c, e, cb) { chunks.push(c); cb(); },
  })).on("finish", resolve));
  assert.equal(Buffer.concat(chunks).toString(), "piped");
  server.close();
}

// ---- jse.serve over TLS -------------------------------------------------------------------
{
  const server = jse.serve(
    { port: 23532, hostname: "127.0.0.1", cert: path.join(here, "tls_cert.pem"), key: path.join(here, "tls_key.pem") },
    () => new Response("over tls"),
  );
  const text = await new Promise((resolve, reject) => {
    https.get({ hostname: "127.0.0.1", port: 23532, path: "/", rejectUnauthorized: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
  assert.equal(text, "over tls");
  server.close();
}

console.log("claims_compat: ok");
