// node:vm shim
const CONTEXT_SYMBOL = Symbol("vm.context");

export function createContext(contextObject = {}) {
  if (isContext(contextObject)) return contextObject;
  Object.defineProperty(contextObject, CONTEXT_SYMBOL, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return contextObject;
}

export function isContext(sandbox) {
  return Boolean(sandbox && sandbox[CONTEXT_SYMBOL]);
}

export function runInContext(code, contextifiedObject, _options = {}) {
  if (!isContext(contextifiedObject)) {
    throw new TypeError("contextifiedObject must be a context created by createContext");
  }
  const sandbox = new Proxy(contextifiedObject, {
    has() {
      return true;
    },
    get(target, prop, receiver) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      return Reflect.get(globalThis, prop, receiver);
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
  const fn = new Function("sandbox", "with(sandbox) { return eval(" + JSON.stringify(String(code)) + "); }");
  return fn.call(contextifiedObject, sandbox);
}

export function runInNewContext(code, contextObject = {}, options = {}) {
  const context = createContext(contextObject);
  return runInContext(code, context, options);
}

export function runInThisContext(code, _options = {}) {
  return (0, eval)(String(code));
}

export function compileFunction(code, params = [], _options = {}) {
  return new Function(...params, code);
}

export class Script {
  constructor(code, options = {}) {
    this.code = String(code);
    this.options = options;
  }
  runInContext(contextifiedObject, options) {
    return runInContext(this.code, contextifiedObject, options);
  }
  runInNewContext(contextObject, options) {
    return runInNewContext(this.code, contextObject, options);
  }
  runInThisContext(options) {
    return runInThisContext(this.code, options);
  }
  createCachedData() {
    return Buffer.alloc(0);
  }
}

export default {
  createContext,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext,
  compileFunction,
  Script,
};
