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

EventEmitter.prototype.on = function (type, listener) {
  this._listeners(type).push({ fn: listener, once: false });
  return this;
};

EventEmitter.prototype.addListener = function (type, listener) {
  return this.on(type, listener);
};

EventEmitter.prototype.once = function (type, listener) {
  this._listeners(type).push({ fn: listener, once: true });
  return this;
};

EventEmitter.prototype.prependListener = function (type, listener) {
  this._listeners(type).unshift({ fn: listener, once: false });
  return this;
};

EventEmitter.prototype.prependOnceListener = function (type, listener) {
  this._listeners(type).unshift({ fn: listener, once: true });
  return this;
};

EventEmitter.prototype.off = function (type, listener) {
  return this.removeListener(type, listener);
};

EventEmitter.prototype.removeListener = function (type, listener) {
  const list = this._events?.get(type);
  if (list) {
    const idx = list.findIndex((l) => l.fn === listener);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this._events.delete(type);
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
    if (type === "error" && args[0] instanceof Error) throw args[0];
    return false;
  }
  for (const entry of [...list]) {
    if (entry.once) this.removeListener(type, entry.fn);
    entry.fn.apply(this, args);
  }
  return true;
};

EventEmitter.prototype.listeners = function (type) {
  return (this._events?.get(type) || []).map((l) => l.fn);
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

EventEmitter.once = function (emitter, name) {
  return new Promise((resolve, reject) => {
    emitter.once(name, resolve);
    if (name !== "error" && typeof emitter.once === "function") {
      emitter.once("error", reject);
    }
  });
};

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

