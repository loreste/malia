// Deliberately limited: no proxy-eval impersonation of isolated V8 contexts.
function unsupported(feature) {
  const error = new Error(`node:vm ${feature} is not supported by Malia`);
  error.code = 'ERR_VM_UNSUPPORTED'; throw error;
}
function optionsSupported(options = {}) {
  for (const key of Object.keys(options)) {
    if (key !== 'filename') unsupported(`option ${key}`);
  }
}
export function createContext() { unsupported('isolated contexts'); }
export function isContext() { return false; }
export function runInContext() { unsupported('isolated contexts'); }
export function runInNewContext() { unsupported('isolated contexts'); }
export function runInThisContext(code, options = {}) {
  optionsSupported(options);
  return (0, eval)(String(code));
}
export function compileFunction(code, params = [], options = {}) {
  optionsSupported(options);
  return new Function(...params, String(code));
}
export class Script {
  constructor(code, options = {}) {
    optionsSupported(options);
    this.code = String(code);
    this.options = { ...options };
  }
  runInContext() { unsupported('isolated contexts'); }
  runInNewContext() { unsupported('isolated contexts'); }
  runInThisContext(options = {}) { return runInThisContext(this.code, { ...this.options, ...options }); }
  createCachedData() { unsupported('cached data'); }
}
export default { createContext, isContext, runInContext, runInNewContext, runInThisContext, compileFunction, Script };
