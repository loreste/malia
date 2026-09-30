// node:diagnostics_channel shim
const channels = new Map();

export class Channel {
  constructor(name) {
    this.name = name;
    this._subscribers = new Set();
  }

  get hasSubscribers() {
    return this._subscribers.size > 0;
  }

  publish(message) {
    for (const fn of this._subscribers) {
      try {
        fn(message, this.name);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  subscribe(fn) {
    if (typeof fn !== "function") throw new TypeError("subscriber must be a function");
    this._subscribers.add(fn);
  }

  unsubscribe(fn) {
    return this._subscribers.delete(fn);
  }

  bindStore(_store, _transform) {}

  unbindStore(_store) {}

  runStores(_context, fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }
}

export function channel(name) {
  if (typeof name !== "string" && typeof name !== "symbol") {
    throw new TypeError("channel name must be a string or symbol");
  }
  let ch = channels.get(name);
  if (!ch) {
    ch = new Channel(name);
    channels.set(name, ch);
  }
  return ch;
}

export function hasSubscribers(name) {
  const ch = channels.get(name);
  return ch ? ch.hasSubscribers : false;
}

export function subscribe(name, fn) {
  return channel(name).subscribe(fn);
}

export function unsubscribe(name, fn) {
  return channel(name).unsubscribe(fn);
}

export function tracingChannel(nameOrChannels) {
  if (typeof nameOrChannels === "string") {
    return {
      start: channel(`tracing:${nameOrChannels}:start`),
      end: channel(`tracing:${nameOrChannels}:end`),
      asyncStart: channel(`tracing:${nameOrChannels}:asyncStart`),
      asyncEnd: channel(`tracing:${nameOrChannels}:asyncEnd`),
      error: channel(`tracing:${nameOrChannels}:error`),
      trace(fn, _context = {}, thisArg, ...args) {
        return fn.apply(thisArg, args);
      },
    };
  }
  return nameOrChannels;
}

export default {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
};
