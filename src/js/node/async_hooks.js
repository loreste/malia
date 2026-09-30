// node:async_hooks shim: no-op AsyncResource and a minimal AsyncLocalStorage.
// on-finished/raw-body use AsyncResource to annotate callback contexts;
// without real V8 async tracking these are pass-throughs. AsyncLocalStorage
// works for synchronous flows (run/enterWith/getStore/exit); context does
// not propagate across awaited async boundaries like Node's does.
class AsyncResource {
  constructor(type, _options) {
    this.type = type;
  }

  runInAsyncScope(fn, thisArg, ...args) {
    try {
      return fn.apply(thisArg, args);
    } finally {
      this.emitDestroy();
    }
  }

  bind(fn, thisArg) {
    return (...args) => this.runInAsyncScope(fn, thisArg, ...args);
  }

  static bind(fn, type, thisArg) {
    const res = new AsyncResource(type || "BOUND");
    return res.bind(fn, thisArg);
  }

  emitInit() {}

  emitDestroy() {}

  asyncId() {
    return 0;
  }

  triggerAsyncId() {
    return 0;
  }
}

class AsyncLocalStorage {
  #store;

  getStore() {
    return this.#store;
  }

  enterWith(store) {
    this.#store = store;
  }

  run(store, callback, ...args) {
    const previous = this.#store;
    this.#store = store;
    let res;
    try {
      res = callback(...args);
    } catch (err) {
      this.#store = previous;
      throw err;
    }
    if (res !== null && typeof res === "object" && typeof res.then === "function") {
      return res.then(
        (val) => {
          this.#store = previous;
          return val;
        },
        (err) => {
          this.#store = previous;
          throw err;
        },
      );
    }
    this.#store = previous;
    return res;
  }

  exit(callback, ...args) {
    const previous = this.#store;
    this.#store = undefined;
    let res;
    try {
      res = callback(...args);
    } catch (err) {
      this.#store = previous;
      throw err;
    }
    if (res !== null && typeof res === "object" && typeof res.then === "function") {
      return res.then(
        (val) => {
          this.#store = previous;
          return val;
        },
        (err) => {
          this.#store = previous;
          throw err;
        },
      );
    }
    this.#store = previous;
    return res;
  }

  disable() {
    this.#store = undefined;
  }

  static bind(fn) {
    return (...args) => fn(...args);
  }

  static snapshot() {
    return (fn, ...args) => fn(...args);
  }
}

function executionAsyncId() {
  return 0;
}

function triggerAsyncId() {
  return 0;
}

export { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId };
export default { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId };
