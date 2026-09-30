// node:async_hooks - AsyncLocalStorage with cross-await propagation via
// Promise.prototype.then patching. AsyncResource is a pass-through.

// -- Global context slot: a stack of (AsyncLocalStorage, store) pairs --
// Each ALS instance registers its current store here. The Promise.then
// patch snapshots the whole stack before yielding and restores it when
// the continuation runs.
let _ctxStack = [];

function _snapshot() {
  return _ctxStack.slice();
}

function _restore(snap) {
  _ctxStack = snap;
  // Push stores back into each ALS instance.
  for (const [als, store] of snap) {
    als._store = store;
  }
}

// Patch Promise.prototype.then once to propagate context across awaits.
// On each .then(), capture the current ALS context. When the callback fires,
// restore that context so the continuation sees the same stores as the code
// that created the promise chain.
const _origThen = Promise.prototype.then;
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (_ctxStack.length === 0) {
    // Fast path: no ALS active, skip wrapping entirely.
    return _origThen.call(this, onFulfilled, onRejected);
  }
  const snap = _snapshot();
  const wrapFn = (fn) => {
    if (typeof fn !== "function") return fn;
    return function (...args) {
      _restore(snap);
      return fn.apply(this, args);
    };
  };
  return _origThen.call(this, wrapFn(onFulfilled), wrapFn(onRejected));
};

class AsyncResource {
  constructor(type, _options) {
    this.type = type;
    this._snap = _snapshot();
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const prev = _snapshot();
    _restore(this._snap);
    try {
      return fn.apply(thisArg, args);
    } finally {
      _restore(prev);
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
  asyncId() { return 0; }
  triggerAsyncId() { return 0; }
}

class AsyncLocalStorage {
  _store = undefined;

  getStore() {
    return this._store;
  }

  enterWith(store) {
    // Remove any existing entry for this ALS, then push.
    _ctxStack = _ctxStack.filter(([als]) => als !== this);
    _ctxStack.push([this, store]);
    this._store = store;
  }

  run(store, callback, ...args) {
    const previous = this._store;
    const prevStack = _snapshot();
    this.enterWith(store);
    let result;
    try {
      result = callback(...args);
    } catch (err) {
      _restore(prevStack);
      this._store = previous;
      throw err;
    }
    // If the callback returned a promise, defer context restoration to
    // after it settles. The Promise.then patch keeps the store alive
    // across intermediate awaits.
    if (result != null && typeof result === "object" && typeof result.then === "function") {
      return result.then(
        (val) => { _restore(prevStack); this._store = previous; return val; },
        (err) => { _restore(prevStack); this._store = previous; throw err; },
      );
    }
    _restore(prevStack);
    this._store = previous;
    return result;
  }

  exit(callback, ...args) {
    const previous = this._store;
    const prevStack = _snapshot();
    _ctxStack = _ctxStack.filter(([als]) => als !== this);
    this._store = undefined;
    let result;
    try {
      result = callback(...args);
    } catch (err) {
      _restore(prevStack);
      this._store = previous;
      throw err;
    }
    if (result != null && typeof result === "object" && typeof result.then === "function") {
      return result.then(
        (val) => { _restore(prevStack); this._store = previous; return val; },
        (err) => { _restore(prevStack); this._store = previous; throw err; },
      );
    }
    _restore(prevStack);
    this._store = previous;
    return result;
  }

  disable() {
    _ctxStack = _ctxStack.filter(([als]) => als !== this);
    this._store = undefined;
  }

  static bind(fn) {
    const snap = _snapshot();
    return (...args) => {
      const prev = _snapshot();
      _restore(snap);
      try {
        return fn(...args);
      } finally {
        _restore(prev);
      }
    };
  }

  static snapshot() {
    const snap = _snapshot();
    return (fn, ...args) => {
      const prev = _snapshot();
      _restore(snap);
      try {
        return fn(...args);
      } finally {
        _restore(prev);
      }
    };
  }
}

function executionAsyncId() { return 0; }
function triggerAsyncId() { return 0; }

export { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId };
export default { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId };
