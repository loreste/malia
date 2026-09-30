// Web/Node compatibility regressions: TextDecoder streaming, WHATWG stream
// globals and compression, fetch request bodies, node:http client requests.
import http from "node:http";
import zlib from "node:zlib";
import { ReadableStream as WebReadableStream } from "node:stream/web";

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, code, msg) {
  try {
    fn();
  } catch (err) {
    assertEq(err.code, code, msg);
    return;
  }
  throw new Error(`${msg}: did not throw`);
}

// ---- TextDecoder ------------------------------------------------------------
const text = "a€😀b";
const bytes = new TextEncoder().encode(text);
for (let i = 1; i < bytes.length; i++) {
  const d = new TextDecoder();
  assertEq(d.decode(bytes.subarray(0, i), { stream: true }) + d.decode(bytes.subarray(i)), text, `stream split at ${i}`);
}
assertEq(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x68])), "h", "BOM stripped");
assertEq(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x68])), "﻿h", "BOM kept");
assertEq(new TextDecoder("utf-16le").decode(new Uint8Array([0x68, 0, 0x69, 0])), "hi", "utf-16le");
assertThrows(() => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])), "ERR_ENCODING_INVALID_ENCODED_DATA", "fatal");
assertEq(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode("�")), "�", "fatal allows U+FFFD");
assertThrows(() => new TextDecoder("no-such-encoding"), "ERR_ENCODING_NOT_SUPPORTED", "unknown label");

// ---- Streams ------------------------------------------------------------------
assertEq(WebReadableStream, ReadableStream, "node:stream/web re-exports the global");
assertEq(Object.keys(globalThis).includes("ReadableStream"), false, "stream globals are non-enumerable");

function streamOf(...chunks) {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

async function collect(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(...chunk);
  return new Uint8Array(parts);
}

const piped = await collect(streamOf(new Uint8Array([1]), new Uint8Array([2])).pipeThrough(new TransformStream()));
assertEq(piped.join(), "1,2", "pipeThrough ends");

const plain = new TextEncoder().encode("hello ".repeat(200));
for (const format of ["gzip", "deflate", "deflate-raw"]) {
  const packed = await collect(streamOf(plain.slice(0, 10), plain.slice(10)).pipeThrough(new CompressionStream(format)));
  if (packed.length >= plain.length) throw new Error(`${format}: output not compressed`);
  const unpacked = await collect(streamOf(packed).pipeThrough(new DecompressionStream(format)));
  assertEq(new TextDecoder().decode(unpacked), "hello ".repeat(200), `${format} round trip`);
}
const gz = await collect(streamOf(plain).pipeThrough(new CompressionStream("gzip")));
assertEq(zlib.gunzipSync(gz).toString(), "hello ".repeat(200), "CompressionStream output is real gzip");

// ---- fetch request bodies -----------------------------------------------------
const echo = jse.serve({ port: 23481, hostname: "127.0.0.1" }, async (req) =>
  new Response(`${req.headers.get("content-type")}|${await req.text()}`));
const post = async (init) => (await fetch("http://127.0.0.1:23481/", { method: "POST", ...init })).text();

assertEq(await post({ body: new URLSearchParams({ a: "1 2" }) }), "application/x-www-form-urlencoded;charset=UTF-8|a=1+2", "URLSearchParams body");
assertEq(await post({ body: "hi" }), "text/plain;charset=UTF-8|hi", "string body");
assertEq(await post({ body: "{}", headers: { "Content-Type": "application/json" } }), "application/json|{}", "explicit content-type kept");
assertEq(await post({ body: streamOf(new TextEncoder().encode("rs")) }), "null|rs", "ReadableStream body");
assertEq(await post({ body: (async function* () { yield "a"; yield new Uint8Array([98]); })() }), "null|ab", "async iterable body");
echo.close();

// ---- node:http client -----------------------------------------------------------
assertThrows(() => http.request({ port: 1, headers: { "x-a": "v\r\nInjected: 1" } }), "ERR_INVALID_CHAR", "CRLF in header value");
assertThrows(() => http.request({ port: 1, headers: { "x a": "1" } }), "ERR_INVALID_HTTP_TOKEN", "invalid header name");
assertThrows(() => http.request({ port: 1, path: "/a b" }), "ERR_UNESCAPED_CHARACTERS", "space in path");
assertThrows(() => http.request({ port: 1, method: "GET / HTTP/1.1\r\n" }), "ERR_INVALID_HTTP_TOKEN", "invalid method");

const server = http.createServer((req, res) => {
  res.end(JSON.stringify({ host: req.headers.host, auth: req.headers.authorization, x: req.headers["x-a"] }));
});
await new Promise((resolve) => server.listen(23482, "127.0.0.1", resolve));
const reply = await new Promise((resolve, reject) => {
  const req = http.request("http://u:p%40ss@127.0.0.1:23482/", (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve(JSON.parse(body)));
  });
  req.on("error", reject);
  req.setHeader("X-A", "1");
  assertEq(req.getHeader("x-a"), "1", "getHeader");
  req.end();
});
assertEq(reply.auth, "Basic " + btoa("u:p@ss"), "auth from URL");
assertEq(reply.host, "127.0.0.1:23482", "Host header");
assertEq(reply.x, "1", "setHeader");
server.close();

console.log("web_compat: ok");
