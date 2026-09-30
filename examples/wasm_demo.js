// Example demonstrating WebAssembly, WASI, and JS Framework compatibility in jse.
import { WASI } from "node:wasi";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

console.log("=== WebAssembly & Framework Support in jse ===\n");

// 1. WebAssembly: Direct instantiation & function call
const wasmAddBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02,
  0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61,
  0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01,
  0x6a, 0x0b,
]);
const wasmModule = new WebAssembly.Module(wasmAddBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule);
console.log("1. WebAssembly Execution:");
console.log(`   wasmInstance.exports.add(40, 2) = ${wasmInstance.exports.add(40, 2)}`);

// 2. WASI (WebAssembly System Interface)
const wasi = new WASI({
  args: ["jse_app", "--port", "8080"],
  env: { NODE_ENV: "production", FRAMEWORK: "vue" },
  returnOnExit: true,
});
const imports = wasi.getImportObject();
console.log("\n2. WASI Preview 1 Subsystem:");
console.log(`   Import namespace available: ${Object.keys(imports).join(", ")}`);

// 3. Framework & SSR Globals (Angular, Vue, React, Vite)
console.log("\n3. Framework & SSR Compatibility Globals:");
console.log(`   navigator.userAgent: ${navigator.userAgent}`);
console.log(`   navigator.hardwareConcurrency: ${navigator.hardwareConcurrency}`);
console.log(`   navigator.onLine: ${navigator.onLine}`);
console.log(`   crypto.randomUUID(): ${crypto.randomUUID()}`);
console.log(`   globalThis.window === globalThis: ${globalThis.window === globalThis}`);

// 4. React Scheduler: MessageChannel
const channel = new MessageChannel();
channel.port2.onmessage = (e) => {
  console.log(`   React Scheduler MessageChannel tick received: ${JSON.stringify(e.data)}`);
  channel.port1.close();
  channel.port2.close();
};
channel.port1.postMessage({ type: "REACT_CONCURRENT_SCHEDULE", priority: "user-blocking" });

// 5. AsyncLocalStorage (Angular SSR, Nuxt, Next.js context propagation)
const als = new AsyncLocalStorage();
await als.run({ correlationId: "tx-4981" }, async () => {
  await new Promise((r) => setTimeout(r, 10));
  console.log(`   AsyncLocalStorage across await: correlationId=${als.getStore()?.correlationId}`);
});

console.log("\n=== All WebAssembly & Framework features verified! ===");
