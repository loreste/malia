// Stub used for require() calls whose specifier could not be resolved at
// wrap time (typically optional dependencies inside try/catch).
export default new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === Symbol.toPrimitive) return () => "[missing module]";
    throw Object.assign(new Error("Cannot find module (optional require() could not be resolved)"), { code: "MODULE_NOT_FOUND" });
  },
  apply() {
    throw Object.assign(new Error("Cannot find module (optional require() could not be resolved)"), { code: "MODULE_NOT_FOUND" });
  },
});
