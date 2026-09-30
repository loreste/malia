// Provide `globalThis.malia` as the primary brand, while maintaining full backward-compatibility with `globalThis.jse`.
(() => {
  globalThis.jse = globalThis.jse || {};
  globalThis.jse.version = "0.1.0";
  globalThis.malia = globalThis.jse;
})();
