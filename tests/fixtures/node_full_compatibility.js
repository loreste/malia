// Comprehensive Node.js drop-in compatibility test
import assert from "node:assert";
import posixPath from "node:path/posix";
import win32Path from "node:path/win32";
import utilTypes from "node:util/types";
import { format, promisify, callbackify, isDeepStrictEqual, types } from "node:util";
import { ReadableStream, WritableStream, TransformStream } from "node:stream/web";
import v8 from "node:v8";
import vm from "node:vm";
import dc from "node:diagnostics_channel";
import punycode from "node:punycode";
import domain from "node:domain";
import { createRequire } from "node:module";

// 1. Globals
assert.strictEqual(globalThis.global, globalThis, "global should point to globalThis");
assert.strictEqual(globalThis.GLOBAL, globalThis, "GLOBAL should point to globalThis");
assert.strictEqual(globalThis.root, globalThis, "root should point to globalThis");
assert.strictEqual(typeof process, "object", "process should exist");
assert.match(process.version, /^v\d+\.\d+\.\d+/, "process.version should match vX.Y.Z format");
assert.strictEqual(process.release.name, "node", "process.release.name should be 'node'");
assert.strictEqual(typeof process.title, "string", "process.title should be a string");
assert.strictEqual(typeof ReadableStream, "function", "ReadableStream should be globally available");
assert.strictEqual(typeof WritableStream, "function", "WritableStream should be globally available");

// 2. path/posix & path/win32
assert.strictEqual(posixPath.join("foo", "bar", "baz"), "foo/bar/baz");
assert.strictEqual(posixPath.basename("/a/b/file.txt"), "file.txt");
assert.strictEqual(win32Path.join("foo", "bar"), "foo/bar");

// 3. util & util/types
assert(utilTypes.isPromise(Promise.resolve()), "isPromise");
assert(utilTypes.isDate(new Date()), "isDate");
assert(utilTypes.isRegExp(/hello/), "isRegExp");
assert(utilTypes.isArrayBufferView(new Uint8Array(4)), "isArrayBufferView");
assert(utilTypes.isUint8Array(new Uint8Array(4)), "isUint8Array");
assert(utilTypes.isMap(new Map()), "isMap");
assert(utilTypes.isSet(new Set()), "isSet");
assert(utilTypes.isNativeError(new Error("test")), "isNativeError");
assert(utilTypes.isAsyncFunction(async () => {}), "isAsyncFunction");
assert(utilTypes.isGeneratorFunction(function* () {}), "isGeneratorFunction");
assert(types.isPromise(Promise.resolve()), "util.types alias");
assert.strictEqual(isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), true);
assert.strictEqual(isDeepStrictEqual({ a: 1 }, { a: 2 }), false);

const asyncFn = async (x) => x * 2;
const cbFn = callbackify(asyncFn);
cbFn(21, (err, res) => {
  assert.ifError(err);
  assert.strictEqual(res, 42);
});

// 4. stream/web
const readable = new ReadableStream({
  start(controller) {
    controller.enqueue("chunk-1");
    controller.enqueue("chunk-2");
    controller.close();
  },
});
const reader = readable.getReader();
const r1 = await reader.read();
const r2 = await reader.read();
const r3 = await reader.read();
assert.strictEqual(r1.value, "chunk-1");
assert.strictEqual(r2.value, "chunk-2");
assert.strictEqual(r3.done, true);

// 5. v8
const heap = v8.getHeapStatistics();
assert(heap.total_heap_size > 0, "heap size > 0");
const serialized = v8.serialize({ hello: "v8" });
assert(Buffer.isBuffer(serialized), "serialized is buffer");
const deserialized = v8.deserialize(serialized);
assert.strictEqual(deserialized.hello, "v8");

// 6. vm
const context = vm.createContext({ count: 5 });
assert(vm.isContext(context), "isContext");
const vmRes = vm.runInContext("count += 10; count * 2", context);
assert.strictEqual(vmRes, 30);
assert.strictEqual(context.count, 15);

const script = new vm.Script("count + 1");
assert.strictEqual(script.runInContext(context), 16);

// 7. diagnostics_channel
let dcMessage = null;
const ch = dc.channel("compat:test");
assert.strictEqual(dc.hasSubscribers("compat:test"), false);
ch.subscribe((msg) => {
  dcMessage = msg;
});
assert.strictEqual(dc.hasSubscribers("compat:test"), true);
ch.publish({ ping: "pong" });
assert.deepStrictEqual(dcMessage, { ping: "pong" });

// 8. punycode
assert.strictEqual(punycode.toASCII("mañana.com"), "xn--maana-pta.com");
assert.strictEqual(punycode.toUnicode("xn--maana-pta.com"), "mañana.com");

// 9. domain
const d = domain.create();
let domainCaught = false;
d.on("error", (err) => {
  domainCaught = true;
  assert.strictEqual(err.message, "domain error test");
});
d.run(() => {
  throw new Error("domain error test");
});
assert.strictEqual(domainCaught, true);

// 10. stream/consumers & stream.finished
import streamConsumers, { buffer as streamBuffer, text as streamText, json as streamJson } from "node:stream/consumers";
import { Readable, Writable, finished } from "node:stream";
import streamPromises from "node:stream/promises";

const testReadable = Readable.from(["hello ", "world"]);
const consumedText = await streamText(testReadable);
assert.strictEqual(consumedText, "hello world");

const jsonReadable = Readable.from(['{"num":42}']);
const consumedJson = await streamJson(jsonReadable);
assert.strictEqual(consumedJson.num, 42);

let streamFinished = false;
const finStream = Readable.from(["a", "b"]);
const pFinished = new Promise((resolve) => {
  finished(finStream, () => {
    streamFinished = true;
    resolve();
  });
});
finStream.resume();
await pFinished;
assert.strictEqual(streamFinished, true);

const cStream = Readable.from(["c"]);
const pFin = streamPromises.finished(cStream);
cStream.resume();
await pFin;


// 11. events enhancements
import { EventEmitter, getEventListeners, listenerCount, on as eventOn } from "node:events";
const ee = new EventEmitter();
const fn1 = () => {};
ee.on("test-event", fn1);
assert.strictEqual(listenerCount(ee, "test-event"), 1);
assert.strictEqual(getEventListeners(ee, "test-event")[0], fn1);

// 12. os & net enhancements
import os from "node:os";
import net from "node:net";
assert(typeof os.uptime() === "number");
assert(Array.isArray(os.loadavg()));
assert(os.constants && typeof os.constants.priority === "object");
assert(typeof net.SocketAddress === "function");
const sockAddr = new net.SocketAddress({ address: "127.0.0.1", port: 8080 });
assert.strictEqual(sockAddr.address, "127.0.0.1");
assert.strictEqual(sockAddr.port, 8080);
assert(typeof net.BlockList === "function");

// 13. CommonJS require with builtins
const req = createRequire(import.meta.url);
const reqPosix = req("path/posix");
assert.strictEqual(reqPosix.join("a", "b"), "a/b");
const reqTypes = req("util/types");
assert(reqTypes.isPromise(Promise.resolve()));
const reqV8 = req("v8");
assert(reqV8.getHeapStatistics().total_heap_size > 0);
const reqVm = req("vm");
assert.strictEqual(typeof reqVm.createContext, "function");
const reqConsumers = req("stream/consumers");
assert.strictEqual(typeof reqConsumers.text, "function");

// 14. Module class static properties
import { Module } from "node:module";
assert(typeof Module._nodeModulePaths === "function");
const paths = Module._nodeModulePaths(process.cwd());
assert(Array.isArray(paths) && paths.length > 0);
assert(typeof Module.syncBuiltinESMExports === "function");

// 15. dgram, repl, and stream toWeb / fromWeb
import dgram from "node:dgram";
const udp = dgram.createSocket("udp4");
assert.strictEqual(typeof udp.bind, "function");
assert.strictEqual(typeof udp.send, "function");
assert.strictEqual(typeof udp.address, "function");
udp.close();

import repl from "node:repl";
assert.strictEqual(typeof repl.start, "function");
assert.strictEqual(typeof repl.REPLServer, "function");

assert.strictEqual(typeof Readable.toWeb, "function");
assert.strictEqual(typeof Readable.fromWeb, "function");
assert.strictEqual(typeof Writable.toWeb, "function");
assert.strictEqual(typeof Writable.fromWeb, "function");

const reqDgram = req("dgram");
assert.strictEqual(typeof reqDgram.createSocket, "function");
const reqRepl = req("repl");
assert.strictEqual(typeof reqRepl.start, "function");

console.log("NODE COMPATIBILITY: ALL TESTS PASSED");


