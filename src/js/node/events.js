// node:events shim: EventEmitter as a function constructor (not a class),
// so legacy `EventEmitter.call(this)` inheritance works — packages like
// send use that pattern via util.inherits. Fields lazy-init for mixin
// users (express copies these methods onto plain objects).
function EventEmitter() {
  this._events = new Map();
  this._maxListeners = 10;
}

EventEmitter.prototype._listeners = function (type) {
  let events = this._events;
  if (!events) {
    events = new Map();
    this._events = events;
  }
  let list = events.get(type);
  if (!list) {
    list = [];
    events.set(type, list);
  }
  return list;
};

function checkListener(listener) {
  if (typeof listener !== "function") throw __jse.invalidArgType("listener", "function", listener);
}

function addEntry(emitter, type, listener, once, prepend) {
  checkListener(listener);
  // Like Node, announce before adding so a newListener handler does not
  // see itself called for its own registration.
  if (emitter._events?.get("newListener")?.length) emitter.emit("newListener", type, listener);
  const list = emitter._listeners(type);
  const entry = { fn: listener, once };
  if (prepend) list.unshift(entry);
  else list.push(entry);
  return emitter;
}

function removeEntry(emitter, type, entry) {
  const list = emitter._events?.get(type);
  if (!list) return;
  const idx = list.indexOf(entry);
  if (idx < 0) return;
  list.splice(idx, 1);
  if (list.length === 0) emitter._events.delete(type);
  if (emitter._events.get("removeListener")?.length) emitter.emit("removeListener", type, entry.fn);
}

EventEmitter.prototype.on = function (type, listener) {
  return addEntry(this, type, listener, false, false);
};

EventEmitter.prototype.addListener = function (type, listener) {
  return this.on(type, listener);
};

EventEmitter.prototype.once = function (type, listener) {
  return addEntry(this, type, listener, true, false);
};

EventEmitter.prototype.prependListener = function (type, listener) {
  return addEntry(this, type, listener, false, true);
};

EventEmitter.prototype.prependOnceListener = function (type, listener) {
  return addEntry(this, type, listener, true, true);
};

EventEmitter.prototype.off = function (type, listener) {
  return this.removeListener(type, listener);
};

EventEmitter.prototype.removeListener = function (type, listener) {
  const list = this._events?.get(type);
  if (list) {
    // Node removes the most recently added matching listener.
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === listener) {
        removeEntry(this, type, list[i]);
        break;
      }
    }
  }
  return this;
};

EventEmitter.prototype.removeAllListeners = function (type) {
  if (!this._events) return this;
  if (type === undefined) this._events.clear();
  else this._events.delete(type);
  return this;
};

EventEmitter.prototype.emit = function (type, ...args) {
  const list = this._events?.get(type);
  if (!list || list.length === 0) {
    if (type === "error") {
      const er = args[0];
      if (er instanceof Error) throw er;
      const err = new Error(`Unhandled error. (${__jse.inspect(er)})`);
      err.code = "ERR_UNHANDLED_ERROR";
      err.context = er;
      throw err;
    }
    return false;
  }
  for (const entry of [...list]) {
    if (entry.once) removeEntry(this, type, entry);
    entry.fn.apply(this, args);
  }
  return true;
};

EventEmitter.prototype.listeners = function (type) {
  return (this._events?.get(type) || []).map((l) => l.fn);
};

// Like listeners(), but once() registrations come back as wrappers with a
// .listener property, as in Node.
EventEmitter.prototype.rawListeners = function (type) {
  return (this._events?.get(type) || []).map((entry) => {
    if (!entry.once) return entry.fn;
    const emitter = this;
    const wrapper = function (...args) {
      removeEntry(emitter, type, entry);
      return entry.fn.apply(this, args);
    };
    wrapper.listener = entry.fn;
    return wrapper;
  });
};

EventEmitter.prototype.listenerCount = function (type) {
  return (this._events?.get(type) || []).length;
};

EventEmitter.prototype.eventNames = function () {
  return this._events ? [...this._events.keys()] : [];
};

EventEmitter.prototype.setMaxListeners = function (n) {
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.getMaxListeners = function () {
  return this._maxListeners ?? 10;
};

// events.once(emitter, name): resolves with the array of event arguments.
EventEmitter.once = function (emitter, name, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      if (typeof emitter.removeListener === "function") {
        emitter.removeListener(name, onEvent);
        if (name !== "error") emitter.removeListener("error", onError);
      } else {
        emitter.removeEventListener?.(name, onEvent);
      }
      signal?.removeEventListener?.("abort", onAbort);
    };
    if (typeof emitter.once === "function") {
      emitter.once(name, onEvent);
      if (name !== "error") emitter.once("error", onError);
    } else {
      // EventTarget
      emitter.addEventListener(name, onEvent, { once: true });
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
};

function abortError(signal) {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  err.cause = signal?.reason;
  return err;
}

EventEmitter.listenerCount = function (emitter, type) {
  if (typeof emitter?.listenerCount === "function") {
    return emitter.listenerCount(type);
  }
  return (emitter?._events?.get(type) || []).length;
};

EventEmitter.getEventListeners = function (emitter, type) {
  if (typeof emitter?.listeners === "function") {
    return emitter.listeners(type);
  }
  return (emitter?._events?.get(type) || []).map((l) => l.fn);
};

EventEmitter.on = async function* (emitter, event, options = {}) {
  const signal = options?.signal;
  if (signal?.aborted) return;
  const queue = [];
  let notify = null;
  const handler = (...args) => {
    queue.push(args);
    if (notify) {
      notify();
      notify = null;
    }
  };
  emitter.on(event, handler);
  try {
    while (!signal?.aborted) {
      if (queue.length === 0) {
        await new Promise((res) => { notify = res; });
      }
      while (queue.length > 0) {
        yield queue.shift();
      }
    }
  } finally {
    if (typeof emitter.off === "function") {
      emitter.off(event, handler);
    } else if (typeof emitter.removeListener === "function") {
      emitter.removeListener(event, handler);
    }
  }
};

const once = EventEmitter.once;
const listenerCount = EventEmitter.listenerCount;
const getEventListeners = EventEmitter.getEventListeners;
const on = EventEmitter.on;

export { EventEmitter, once, listenerCount, getEventListeners, on };
// Node compatibility: require("events") is the EventEmitter class itself,
// which also carries an .EventEmitter property.
EventEmitter.defaultMaxListeners = 10;
EventEmitter.EventEmitter = EventEmitter;
export default EventEmitter;

