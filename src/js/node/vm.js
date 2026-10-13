// Contexts are real V8 contexts (op_vm_run_in_context): the sandbox's
// properties seed the context's global, and globals the code defines or
// changes are copied back. No proxy-eval impersonation. Like Node, a scoping
// tool, not a security boundary.
const kContext = Symbol("vm.context");
function unsupported(feature) {
  const error = new Error(`node:vm ${feature} is not supported by Malia`);
  error.code = 'ERR_VM_UNSUPPORTED'; throw error;
}
function optionsSupported(options = {}) {
  for (const key of Object.keys(options)) {
    if (key !== 'filename') unsupported(`option ${key}`);
  }
}
export function createContext(sandbox = {}, options = {}) {
  if (sandbox === null || typeof sandbox !== 'object') throw new TypeError('The "contextObject" argument must be of type object');
  if (!sandbox[kContext]) Object.defineProperty(sandbox, kContext, { value: true });
  return sandbox;
}
export function isContext(sandbox) {
  if (sandbox === null || typeof sandbox !== 'object') throw new TypeError('The "object" argument must be of type object');
  return sandbox[kContext] === true;
}
function filenameOf(options) {
  return typeof options === 'string' ? options : (options && options.filename) || 'evalmachine.<anonymous>';
}
export function runInContext(code, contextifiedObject, options = {}) {
  if (!contextifiedObject || contextifiedObject[kContext] !== true) {
    throw new TypeError('The "contextifiedObject" argument must be an vm.Context');
  }
  return Deno.core.ops.op_vm_run_in_context(String(code), contextifiedObject, filenameOf(options));
}
export function runInNewContext(code, sandbox = {}, options = {}) {
  return runInContext(code, createContext(sandbox), options);
}
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
  runInContext(context, options = {}) { return runInContext(this.code, context, { ...this.options, ...options }); }
  runInNewContext(sandbox = {}, options = {}) { return runInNewContext(this.code, sandbox, { ...this.options, ...options }); }
  runInThisContext(options = {}) { return runInThisContext(this.code, { ...this.options, ...options }); }
  createCachedData() { unsupported('cached data'); }
}
export default { createContext, isContext, runInContext, runInNewContext, runInThisContext, compileFunction, Script };
