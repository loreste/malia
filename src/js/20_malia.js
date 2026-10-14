// Provide `globalThis.malia` as the primary brand, while maintaining full backward-compatibility with `globalThis.jse`.
(() => {
  globalThis.jse = globalThis.jse || {};
  globalThis.jse.version = Deno.core.ops.op_runtime_version();
  globalThis.malia = globalThis.jse;
})();
