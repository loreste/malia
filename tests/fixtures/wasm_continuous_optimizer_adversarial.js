// tests/fixtures/wasm_continuous_optimizer_adversarial.js
// Adversarial test suite for one-flag WebAssembly compilation, JIT synthesis,
// and continuous runtime optimization (memory compaction, heap reclamation, and CPU tiering).

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

console.log("[wasm_continuous_optimizer_adversarial] Starting adversarial verification...");


async function main() {
  // ---------------------------------------------------------------------------
  // 1. Verify global optimizer API and continuous memory compaction
  // ---------------------------------------------------------------------------
  console.log("  -> Testing Continuous Runtime Optimizer (memory compaction & heap stats)...");
  assert.ok(globalThis.jse, "globalThis.jse exists");
  assert.ok(globalThis.jse.optimizer, "globalThis.jse.optimizer exists");
  assert.strictEqual(typeof globalThis.jse.optimizer.optimize, "function", "optimizer.optimize is a function");
  assert.strictEqual(typeof globalThis.jse.optimizer.stats, "function", "optimizer.stats is a function");
  assert.strictEqual(typeof globalThis.jse.optimizer.heap, "function", "optimizer.heap is a function");

  const initialHeap = globalThis.jse.optimizer.heap();
  assert.ok(initialHeap.used > 0, "heap.used > 0");
  assert.ok(initialHeap.total >= initialHeap.used, "heap.total >= heap.used");
  assert.ok(initialHeap.limit > initialHeap.total, "heap.limit > heap.total");

  // Create temporary heap churn (simulate heavy request allocations)
  const churn = [];
  for (let i = 0; i < 20000; i++) {
    churn.push({ id: i, data: `alloc_${i}_${Math.random()}`, payload: new Uint8Array(64) });
  }
  const preChurnHeap = globalThis.jse.optimizer.heap();
  assert.ok(preChurnHeap.used >= initialHeap.used, "churn increased heap usage");

  // Drop churn references and trigger continuous memory compaction
  churn.length = 0;
  const optResult = globalThis.jse.optimizer.optimize();
  assert.ok(optResult !== null, "optimize returned stats");
  assert.ok(optResult.passes >= 1, "optimizer recorded at least 1 pass");
  assert.strictEqual(optResult.mode, "continuous", "mode is continuous");

  const postStats = globalThis.jse.optimizer.stats();
  assert.ok(postStats.passes >= 1, "post stats passes >= 1");
  console.log(`     Passes: ${postStats.passes}, Heap: ${(postStats.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(postStats.heapTotal / 1024 / 1024).toFixed(2)}MB, Reclaimed: ${postStats.memoryReclaimedBytes}B`);

  // Test background timer
  globalThis.jse.optimizer.start(500);
  assert.strictEqual(globalThis.jse.optimizer.stats().active, true, "optimizer is active");
  globalThis.jse.optimizer.stop();
  assert.strictEqual(globalThis.jse.optimizer.stats().active, false, "optimizer is stopped");

  // ---------------------------------------------------------------------------
  // 2. Verify WebAssembly JIT synthesis and dynamic function acceleration
  // ---------------------------------------------------------------------------
  console.log("  -> Testing WebAssembly JIT function compilation & acceleration...");
  assert.ok(globalThis.jse.wasm, "globalThis.jse.wasm exists");
  assert.strictEqual(typeof globalThis.jse.wasm.compile, "function", "jse.wasm.compile is a function");

  // Test JIT-compiled operations
  const wasmAdd = globalThis.jse.wasm.compile("add");
  assert.strictEqual(typeof wasmAdd, "function", "wasmAdd is a function");
  assert.strictEqual(wasmAdd(100, 250), 350, "wasmAdd(100, 250) = 350");
  assert.strictEqual(wasmAdd(-50, 20), -30, "wasmAdd(-50, 20) = -30");

  const wasmMul = globalThis.jse.wasm.compile("mul");
  assert.strictEqual(wasmMul(6, 7), 42, "wasmMul(6, 7) = 42");
  assert.strictEqual(wasmMul(-4, 5), -20, "wasmMul(-4, 5) = -20");

  const wasmSub = globalThis.jse.wasm.compile("sub");
  assert.strictEqual(wasmSub(100, 37), 63, "wasmSub(100, 37) = 63");

  const wasmSquare = globalThis.jse.wasm.compile("square");
  assert.strictEqual(wasmSquare(9), 81, "wasmSquare(9) = 81");
  assert.strictEqual(wasmSquare(-8), 64, "wasmSquare(-8) = 64");

  const wasmInc = globalThis.jse.wasm.compile("increment");
  assert.strictEqual(wasmInc(999), 1000, "wasmInc(999) = 1000");

  const wasmBitwise = globalThis.jse.wasm.compile("bitwise");
  assert.strictEqual(wasmBitwise(0b1100, 0b1010), 0b0110, "wasmBitwise xor");

  // ---------------------------------------------------------------------------
  // 3. Verify one-flag WebAssembly application compilation (compileApp)
  // ---------------------------------------------------------------------------
  console.log("  -> Testing one-flag application-to-WebAssembly compilation (compileApp)...");
  assert.strictEqual(typeof globalThis.jse.wasm.compileApp, "function", "jse.wasm.compileApp is a function");

  const tmpDir = path.join(os.tmpdir(), `jse_wasm_optimizer_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });


  const appJsPath = path.join(tmpDir, "sample_app.js");
  const appWasmPath = path.join(tmpDir, "sample_app.wasm");

  const appSource = `
    const math = { add: (a, b) => a + b, mul: (a, b) => a * b };
    console.log("Sample App running inside WebAssembly container!");
    globalThis.__wasm_app_executed = math.add(40, 2);
  `;
  fs.writeFileSync(appJsPath, appSource, "utf8");

  // Compile app to .wasm
  const compileRes = globalThis.jse.wasm.compileApp(appJsPath, appWasmPath);
  assert.strictEqual(compileRes.success, true, "compileApp succeeded");
  assert.strictEqual(compileRes.entry, appJsPath, "compileApp entry matches");
  assert.strictEqual(compileRes.output, appWasmPath, "compileApp output matches");
  assert.ok(compileRes.bytesWritten > 100, "bytes written > 100");

  assert.ok(fs.existsSync(appWasmPath), "output .wasm file exists on disk");
  const wasmBytes = fs.readFileSync(appWasmPath);

  // Validate standards compliance
  assert.ok(WebAssembly.validate(wasmBytes), "Generated .wasm passes WebAssembly.validate()");

  // Instantiate and verify exports
  const wasmMod = new WebAssembly.Module(wasmBytes);
  const wasmInst = new WebAssembly.Instance(wasmMod);

  assert.ok(wasmInst.exports.memory instanceof WebAssembly.Memory, "wasm exports memory");
  assert.strictEqual(typeof wasmInst.exports._start, "function", "wasm exports _start (WASI entry)");
  assert.strictEqual(typeof wasmInst.exports.main, "function", "wasm exports main");
  assert.strictEqual(typeof wasmInst.exports.optimize, "function", "wasm exports optimize");
  assert.strictEqual(typeof wasmInst.exports.compute, "function", "wasm exports compute");
  assert.strictEqual(typeof wasmInst.exports.add, "function", "wasm exports add");

  assert.strictEqual(wasmInst.exports.compute(50, 25), 75, "wasmInst.exports.compute(50, 25) = 75");
  assert.strictEqual(wasmInst.exports.add(10, 32), 42, "wasmInst.exports.add(10, 32) = 42");
  assert.strictEqual(wasmInst.exports.optimize(99), 100, "wasmInst.exports.optimize(99) = 100");

  // ---------------------------------------------------------------------------
  // 4. Verify TypeScript compilation to WebAssembly
  // ---------------------------------------------------------------------------
  console.log("  -> Testing TypeScript source compilation into WebAssembly binary...");
  const tsAppPath = path.join(tmpDir, "ts_app.ts");
  const tsWasmPath = path.join(tmpDir, "ts_app.wasm");
  const tsSource = `
    interface Calculator {
      calculate(x: number, y: number): number;
    }
    const calc: Calculator = {
      calculate(x: number, y: number): number {
        return (x * y) + 1;
      }
    };
    console.log("TS calculation:", calc.calculate(7, 6));
  `;
  fs.writeFileSync(tsAppPath, tsSource, "utf8");

  const tsCompileRes = globalThis.jse.wasm.compileApp(tsAppPath, tsWasmPath);
  assert.strictEqual(tsCompileRes.success, true, "TypeScript compileApp succeeded");
  assert.ok(fs.existsSync(tsWasmPath), "output ts_app.wasm file exists");

  const tsWasmBytes = fs.readFileSync(tsWasmPath);
  assert.ok(WebAssembly.validate(tsWasmBytes), "TypeScript generated .wasm passes WebAssembly.validate()");

  // Clean up temporary directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}

  console.log("[wasm_continuous_optimizer_adversarial] ALL WebAssembly & Continuous Optimizer tests passed successfully!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
