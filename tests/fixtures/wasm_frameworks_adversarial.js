// Adversarial test suite for WebAssembly, WASI, and JS Framework compatibility (Vue, Angular, React, Next, Nuxt, Vite).
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire, builtinModules, isBuiltin, Module } from "node:module";
import { WASI } from "node:wasi";
import { WASI as BareWASI } from "wasi";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

console.log("[wasm_frameworks_adversarial] Starting comprehensive verification...");

// =========================================================================
// 1. WebAssembly Core & Streaming API
// =========================================================================
console.log("  -> Testing WebAssembly Core & Streaming API...");

// Valid WebAssembly binary exporting `add(a: i32, b: i32) -> i32`
const wasmAddBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // Type: (i32, i32) -> i32
  0x03, 0x02, 0x01, 0x00, // Func: [0]
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, // Export: "add" func 0
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // Code: local.get 0, local.get 1, i32.add, end
]);

// Sync/Standard compile & instantiate
const compiledModule = new WebAssembly.Module(wasmAddBytes);
const instance = new WebAssembly.Instance(compiledModule);
assert.strictEqual(typeof instance.exports.add, "function", "wasm export 'add' is a function");
assert.strictEqual(instance.exports.add(40, 2), 42, "wasm 40 + 2 = 42");

// WebAssembly.compile & instantiate promises
const asyncMod = await WebAssembly.compile(wasmAddBytes);
const asyncInst = await WebAssembly.instantiate(asyncMod);
assert.strictEqual(asyncInst.exports.add(100, 200), 300, "async instantiate 100 + 200 = 300");

// WebAssembly.compileStreaming with Response
const response1 = new Response(wasmAddBytes, {
  headers: { "Content-Type": "application/wasm" },
});
const streamedModule = await WebAssembly.compileStreaming(response1);
const streamedInst1 = await WebAssembly.instantiate(streamedModule);
assert.strictEqual(streamedInst1.exports.add(15, 25), 40, "compileStreaming add(15, 25) = 40");

// WebAssembly.instantiateStreaming with Response
const response2 = new Response(wasmAddBytes, {
  headers: { "Content-Type": "application/wasm" },
});
const streamedResult = await WebAssembly.instantiateStreaming(response2);
assert(streamedResult.instance instanceof WebAssembly.Instance, "instantiateStreaming returns instance");
assert(streamedResult.module instanceof WebAssembly.Module, "instantiateStreaming returns module");
assert.strictEqual(streamedResult.instance.exports.add(7, 8), 15, "instantiateStreaming add(7, 8) = 15");

// =========================================================================
// 2. Direct .wasm File Loading (createRequire & ESM import)
// =========================================================================
console.log("  -> Testing direct .wasm file loading...");

const tmpDir = path.join(os.tmpdir(), `jse_wasm_frameworks_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(tmpDir, { recursive: true });
const tmpWasmPath = path.join(tmpDir, "math.wasm");
fs.writeFileSync(tmpWasmPath, wasmAddBytes);

// createRequire loading .wasm directly
const req = createRequire(import.meta.url);
const wasmReqExports = req(tmpWasmPath);
assert.strictEqual(typeof wasmReqExports.add, "function", "createRequire .wasm returns exports");
assert.strictEqual(wasmReqExports.add(50, 50), 100, "createRequire wasm add(50, 50) = 100");

// Dynamic ESM import of .wasm file
const esmLoaded = await import(tmpWasmPath);
assert(esmLoaded.default, "ESM wasm has default export");
assert.strictEqual(esmLoaded.default.add(99, 1), 100, "ESM default export add(99, 1) = 100");
assert(esmLoaded.instance instanceof WebAssembly.Instance, "ESM has instance export");
assert(esmLoaded.module instanceof WebAssembly.Module, "ESM has module export");
assert.strictEqual(esmLoaded.instance.exports.add(12, 12), 24, "ESM instance.exports add(12, 12) = 24");

// Clean up wasm temp file
fs.unlinkSync(tmpWasmPath);

// =========================================================================
// 3. WASI Subsystem (node:wasi and wasi)
// =========================================================================
console.log("  -> Testing WASI subsystem...");

assert.strictEqual(typeof WASI, "function", "node:wasi exports WASI class");
assert.strictEqual(typeof BareWASI, "function", "bare 'wasi' exports WASI class");

const wasi = new WASI({
  args: ["jse_engine", "--test-flag", "arg_value"],
  env: { RUNTIME: "jse", NODE_ENV: "production" },
  returnOnExit: true,
});

const imports = wasi.getImportObject();
assert(imports.wasi_snapshot_preview1, "import object has wasi_snapshot_preview1");
const { wasi_snapshot_preview1: sys } = imports;

// Test memory setup
const mem = new WebAssembly.Memory({ initial: 2 });
wasi.instance = { exports: { memory: mem } };
const view = new DataView(mem.buffer);

// clock_time_get
const timePtr = 8;
const clockRc = sys.clock_time_get(0, 0n, timePtr);
assert.strictEqual(clockRc, 0, "clock_time_get returned WASI_ESUCCESS");
const timeNs = view.getBigUint64(timePtr, true);
assert(timeNs > 0n, `clock_time_get produced valid timestamp: ${timeNs}`);

// clock_res_get
const resPtr = 16;
const resRc = sys.clock_res_get(0, resPtr);
assert.strictEqual(resRc, 0, "clock_res_get returned WASI_ESUCCESS");

// random_get
const randPtr = 64;
const randLen = 32;
const randRc = sys.random_get(randPtr, randLen);
assert.strictEqual(randRc, 0, "random_get returned WASI_ESUCCESS");
const randU8 = new Uint8Array(mem.buffer, randPtr, randLen);
assert(randU8.some((b) => b !== 0), "random_get populated non-zero entropy");

// args_sizes_get and args_get
const argcPtr = 100;
const argvBufSizePtr = 104;
assert.strictEqual(sys.args_sizes_get(argcPtr, argvBufSizePtr), 0, "args_sizes_get succeeded");
assert.strictEqual(view.getUint32(argcPtr, true), 3, "argc is 3");
assert(view.getUint32(argvBufSizePtr, true) > 0, "argv_buf_size > 0");

const argvPtr = 120;
const argvBufPtr = 150;
assert.strictEqual(sys.args_get(argvPtr, argvBufPtr), 0, "args_get succeeded");

// environ_sizes_get and environ_get
const envcPtr = 200;
const envBufSizePtr = 204;
assert.strictEqual(sys.environ_sizes_get(envcPtr, envBufSizePtr), 0, "environ_sizes_get succeeded");
assert.strictEqual(view.getUint32(envcPtr, true), 2, "environ_count is 2");

const envPtr = 220;
const envBufPtr = 250;
assert.strictEqual(sys.environ_get(envPtr, envBufPtr), 0, "environ_get succeeded");

// fd_write to stdout (fd = 1)
const iovsPtr = 300;
const msg = new TextEncoder().encode("[WASI fd_write verification OK]\n");
const msgPtr = 400;
new Uint8Array(mem.buffer).set(msg, msgPtr);
view.setUint32(iovsPtr, msgPtr, true);
view.setUint32(iovsPtr + 4, msg.length, true);
const nwrittenPtr = 350;
const writeRc = sys.fd_write(1, iovsPtr, 1, nwrittenPtr);
assert.strictEqual(writeRc, 0, "fd_write returned WASI_ESUCCESS");
assert.strictEqual(view.getUint32(nwrittenPtr, true), msg.length, "wrote expected byte count");

// proc_exit with returnOnExit: true
let exitErr = null;
try {
  sys.proc_exit(42);
} catch (e) {
  exitErr = e;
}
assert(exitErr, "proc_exit throws exit exception");
assert.strictEqual(exitErr.code, 42, "proc_exit exit code matches 42");

// =========================================================================
// 4. Framework Compatibility: Globals, SSR, React Scheduler
// =========================================================================
console.log("  -> Testing Framework SSR & React Scheduler globals...");

// Window & Self aliases
assert.strictEqual(globalThis.self, globalThis, "globalThis.self === globalThis");
assert.strictEqual(globalThis.window, globalThis, "globalThis.window === globalThis");
assert.strictEqual(globalThis.global, globalThis, "globalThis.global === globalThis");

// Navigator (Angular SSR, Vue 3, Vite, Nuxt)
assert(typeof navigator === "object" && navigator !== null, "navigator exists");
assert(typeof navigator.userAgent === "string" && navigator.userAgent.includes("Node"), "navigator.userAgent present");
assert(typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency > 0, "hardwareConcurrency valid");
assert.strictEqual(navigator.onLine, true, "navigator.onLine is true");
assert(Array.isArray(navigator.languages) && navigator.languages.length > 0, "navigator.languages array");
assert(typeof navigator.platform === "string", "navigator.platform string");

// Web Crypto (Node 19+, Angular, React, Vue, Vite)
assert(typeof crypto === "object" && crypto !== null, "crypto object exists");
const randomBuf = crypto.getRandomValues(new Uint8Array(32));
assert.strictEqual(randomBuf.length, 32, "getRandomValues populated 32 bytes");
assert(randomBuf.some((b) => b !== 0), "getRandomValues has entropy");

const uuid = crypto.randomUUID();
assert.strictEqual(typeof uuid, "string", "randomUUID returns string");
assert(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid),
  `randomUUID '${uuid}' is a valid RFC 4122 v4 UUID`,
);

// MessageChannel & MessagePort (Crucial for React Scheduler Concurrent Mode)
assert.strictEqual(typeof MessageChannel, "function", "MessageChannel is defined on globalThis");
assert.strictEqual(typeof MessagePort, "function", "MessagePort is defined on globalThis");

const channel = new MessageChannel();
assert(channel.port1 instanceof MessagePort, "port1 is MessagePort");
assert(channel.port2 instanceof MessagePort, "port2 is MessagePort");

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("MessagePort message timed out")), 2000);
  channel.port2.onmessage = (event) => {
    clearTimeout(timeout);
    assert.strictEqual(event.data.action, "REACT_TICK");
    assert.strictEqual(event.data.payload, 12345);
    channel.port1.close();
    channel.port2.close();
    resolve();
  };
  channel.port1.postMessage({ action: "REACT_TICK", payload: 12345 });
});

// DOMException
assert.strictEqual(typeof DOMException, "function", "DOMException is defined");
const domEx = new DOMException("Abort triggered", "AbortError");
assert.strictEqual(domEx.message, "Abort triggered");
assert.strictEqual(domEx.name, "AbortError");

// atob & btoa
const sampleStr = "Antigravity JS Engine Frameworks Test!";
const base64Str = btoa(sampleStr);
const roundtripStr = atob(base64Str);
assert.strictEqual(roundtripStr, sampleStr, "btoa / atob roundtrip matches");

// =========================================================================
// 5. AsyncLocalStorage Asynchronous Context Retention (Angular SSR, Nuxt)
// =========================================================================
console.log("  -> Testing AsyncLocalStorage async propagation...");

const als = new AsyncLocalStorage();
assert.strictEqual(als.getStore(), undefined, "initial store is undefined");

const asyncRes = await als.run({ requestId: "REQ_999", user: "dev" }, async () => {
  assert.strictEqual(als.getStore()?.requestId, "REQ_999", "store accessible before await");
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(als.getStore()?.requestId, "REQ_999", "store retained across async await boundary");
  return "async_als_ok";
});

assert.strictEqual(asyncRes, "async_als_ok", "als.run returns async promise result");
assert.strictEqual(als.getStore(), undefined, "store cleanly restored to undefined after run");

// AsyncResource binding
const resource = new AsyncResource("HTTP_REQUEST");
const boundFn = resource.bind((a, b) => a + b);
assert.strictEqual(boundFn(10, 20), 30, "AsyncResource boundFn executes");

// =========================================================================
// 6. Node Module & createRequire (Vite, Rollup, PostCSS plugins)
// =========================================================================
console.log("  -> Testing node:module createRequire & builtins...");

assert(builtinModules.includes("wasi"), "builtinModules includes 'wasi'");
assert(builtinModules.includes("cluster"), "builtinModules includes 'cluster'");
assert(builtinModules.includes("http2"), "builtinModules includes 'http2'");
assert(builtinModules.includes("crypto"), "builtinModules includes 'crypto'");

assert(isBuiltin("node:wasi"), "isBuiltin('node:wasi') is true");
assert(isBuiltin("wasi"), "isBuiltin('wasi') is true");
assert(isBuiltin("fs"), "isBuiltin('fs') is true");

const localReq = createRequire(import.meta.url);

// Resolving builtins
const requiredFs = localReq("fs");
assert.strictEqual(typeof requiredFs.readFileSync, "function", "required 'fs' has readFileSync");
const requiredWasi = localReq("wasi");
assert.strictEqual(typeof requiredWasi.WASI, "function", "required 'wasi' has WASI");

// Requiring JSON
const tmpJsonPath = path.join(tmpDir, "config.json");
fs.writeFileSync(tmpJsonPath, JSON.stringify({ framework: "Vue", version: 3.5 }));
const loadedJson = localReq(tmpJsonPath);
assert.strictEqual(loadedJson.framework, "Vue");
assert.strictEqual(loadedJson.version, 3.5);
fs.unlinkSync(tmpJsonPath);

// Requiring CommonJS
const tmpCjsPath = path.join(tmpDir, "calc.cjs");
fs.writeFileSync(
  tmpCjsPath,
  "module.exports = { multiply: function(a, b) { return a * b; } };",
);
const loadedCjs = localReq(tmpCjsPath);
assert.strictEqual(typeof loadedCjs.multiply, "function", "CJS exports multiply function");
assert.strictEqual(loadedCjs.multiply(6, 7), 42, "CJS multiply(6, 7) = 42");
fs.unlinkSync(tmpCjsPath);

// Cleanup tmpDir
fs.rmdirSync(tmpDir);

console.log("[wasm_frameworks_adversarial] ALL WebAssembly, WASI & Framework tests passed successfully!");
