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

const TRACE_EVENTS = ["start", "end", "asyncStart", "asyncEnd", "error"];

// TracingChannel: publishes start/end/asyncStart/asyncEnd/error around a
// traced call, with the same context object passed to every event.
export class TracingChannel {
  constructor(nameOrChannels) {
    for (const event of TRACE_EVENTS) {
      this[event] = typeof nameOrChannels === "string"
        ? channel(`tracing:${nameOrChannels}:${event}`)
        : nameOrChannels[event];
    }
  }

  get hasSubscribers() {
    return TRACE_EVENTS.some((event) => this[event].hasSubscribers);
  }

  subscribe(handlers) {
    for (const event of TRACE_EVENTS) if (handlers[event]) this[event].subscribe(handlers[event]);
  }

  unsubscribe(handlers) {
    let done = true;
    for (const event of TRACE_EVENTS) if (handlers[event] && !this[event].unsubscribe(handlers[event])) done = false;
    return done;
  }

  traceSync(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    this.start.publish(context);
    try {
      const result = fn.apply(thisArg, args);
      context.result = result;
      return result;
    } catch (err) {
      context.error = err;
      this.error.publish(context);
      throw err;
    } finally {
      this.end.publish(context);
    }
  }

  tracePromise(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    const settle = (key, value) => {
      context[key] = value;
      if (key === "error") this.error.publish(context);
      this.asyncStart.publish(context);
      this.asyncEnd.publish(context);
    };
    this.start.publish(context);
    try {
      return Promise.resolve(fn.apply(thisArg, args)).then(
        (result) => {
          settle("result", result);
          return result;
        },
        (err) => {
          settle("error", err);
          throw err;
        },
      );
    } catch (err) {
      context.error = err;
      this.error.publish(context);
      throw err;
    } finally {
      this.end.publish(context);
    }
  }

  traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    const callback = args.at(position);
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const self = this;
    args.splice(position, 1, function (err, result) {
      if (err) {
        context.error = err;
        self.error.publish(context);
      } else {
        context.result = result;
      }
      self.asyncStart.publish(context);
      try {
        return callback.apply(this, arguments);
      } finally {
        self.asyncEnd.publish(context);
      }
    });
    return this.traceSync(fn, context, thisArg, ...args);
  }
}

export function tracingChannel(nameOrChannels) {
  return new TracingChannel(nameOrChannels);
}

export default {
  Channel,
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
  TracingChannel,
};
