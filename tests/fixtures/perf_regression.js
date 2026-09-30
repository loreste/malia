// Regression tests for performance and Node.js compatibility improvements:
// 1. os.cpus() returns real CPU info (not stubs)
// 2. os.loadavg() returns real values (not [0,0,0])
// 3. os.uptime() returns a positive number
// 4. WASM loading works (base64 path)

import assert from "node:assert";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// ---- os.cpus() returns real info ----
{
  const cpuList = os.cpus();
  assert.ok(Array.isArray(cpuList), "os.cpus() must return an array");
  assert.ok(cpuList.length > 0, "os.cpus() must have at least 1 CPU");

  const first = cpuList[0];
  assert.ok(first.model && first.model !== "jse-cpu",
    `CPU model must be real, got: ${first.model}`);
  assert.ok(typeof first.speed === "number" && first.speed > 0,
    `CPU speed must be positive, got: ${first.speed}`);
  assert.ok(first.times && typeof first.times === "object",
    "CPU times must be an object");
  assert.ok(typeof first.times.user === "number", "times.user must be a number");
  assert.ok(typeof first.times.idle === "number", "times.idle must be a number");
}
console.log("PASS: os.cpus() returns real CPU info");

// ---- os.loadavg() returns real values ----
{
  const avg = os.loadavg();
  assert.ok(Array.isArray(avg) && avg.length === 3, "loadavg must return [1m, 5m, 15m]");
  // On any running system, at least one average should be > 0
  const anyPositive = avg.some(v => v > 0);
  assert.ok(anyPositive, `loadavg should have positive values, got: [${avg}]`);
}
console.log("PASS: os.loadavg() returns real values");

// ---- os.uptime() returns positive ----
{
  const up = os.uptime();
  assert.ok(typeof up === "number" && up > 0,
    `os.uptime() must be positive, got: ${up}`);
}
console.log("PASS: os.uptime() returns positive value");

// ---- availableParallelism matches cpus length ----
{
  const par = os.availableParallelism();
  const cpuCount = os.cpus().length;
  assert.strictEqual(par, cpuCount,
    `availableParallelism (${par}) should match cpus().length (${cpuCount})`);
}
console.log("PASS: availableParallelism matches cpus count");

// ---- WASM loading (base64 path) ----
// Minimal WASM module: exports a function that returns 42.
// (module (func (export "answer") (result i32) (i32.const 42)))
{
  const wasmBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x0a, 0x01, 0x06, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72, 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
  ]);
  const tmpDir = path.join(os.tmpdir(), `jse-wasm-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const wasmFile = path.join(tmpDir, "test.wasm");
  fs.writeFileSync(wasmFile, wasmBytes);

  // Dynamic import of the wasm file
  const mod = await import(wasmFile);
  assert.ok(mod.module instanceof WebAssembly.Module, "wasm module export");
  assert.ok(mod.bytes instanceof Uint8Array, "wasm bytes export");
  assert.strictEqual(mod.bytes.length, wasmBytes.length, "wasm bytes length");

  // Instantiate with no imports
  const inst = mod.instantiate();
  assert.strictEqual(inst.exports.answer(), 42, "wasm function returns 42");

  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log("PASS: WASM module loading works");

console.log("ALL PERF REGRESSION TESTS PASSED");
