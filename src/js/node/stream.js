// node:stream shim: compact Readable/Writable/Transform + pipeline as
// function constructors (not classes) so legacy `Parent.call(this)`
// inheritance works — send's SendStream does `Stream.call(this)` after
// util.inherits. Behavior: flowing mode ('data'/'end'), _read pull,
// pause/resume, write/end ('finish'/'drain'), _transform, pipe with
// backpressure, async iteration, Readable.from.
import { EventEmitter } from "node:events";

const HIGH_WATER_MARK = 16384;

function normalizeWriteArgs(encoding, cb) {
  if (typeof encoding === "function") return ["utf8", encoding];
  return [encoding ?? "utf8", cb];
}

function inherit(child, parent) {
  child.prototype = Object.create(parent.prototype);
  child.prototype.constructor = child;
}

// ---- Readable ----------------------------------------------------------------

function Readable(options = {}) {
  EventEmitter.call(this);
  // Only assign when the caller passed a function. `options.read` is
  // otherwise undefined and would shadow Readable.prototype._read.
  if (typeof options.read === "function") this._read = options.read;
  this._rState = {
    buffer: [],
    ended: false,
    endEmitted: false,
    flowing: false,
    pumping: false,
    reading: false,
    destroyed: false,
  };
}
inherit(Readable, EventEmitter);

Object.defineProperty(Readable.prototype, "readableEnded", {
  get() {
    return this._rState.endEmitted;
  },
});

Readable.prototype.push = function (chunk) {
  const st = this._rState;
  // push ends the in-flight _read. Async _read implementations rely on this
  // so the pump does not call _read again until the bytes (or EOF) arrive.
  st.reading = false;
  if (st.ended) return false;
  if (chunk === null) {
    st.ended = true;
  } else {
    st.buffer.push(chunk);
  }
  if (st.flowing && !st.pumping) {
    st.pumping = true;
    this._pump();
  }
  return st.buffer.length < HIGH_WATER_MARK;
};

Readable.prototype.read = function () {
  const st = this._rState;
  if (st.buffer.length === 0) {
    if (!st.ended && this._read && !st.reading) {
      st.reading = true;
      queueMicrotask(() => this._callRead());
    }
    return null;
  }
  return st.buffer.shift();
};

Readable.prototype._callRead = function () {
  const st = this._rState;
  st.reading = true;
  try {
    this._read(HIGH_WATER_MARK);
  } catch (err) {
    st.reading = false;
    this.destroy(err);
    return;
  }
  // A synchronous push() cleared `reading`. An async _read leaves it set
  // and will push later; calling _read again here spins the microtask queue
  // and starves the op that should produce the chunk.
  if (st.reading) {
    st.pumping = false;
    return;
  }
  if (st.flowing) {
    st.pumping = true;
    this._pump();
  } else {
    st.pumping = false;
    if (st.ended && !st.endEmitted && st.buffer.length === 0) {
      this._emitEnd();
    }
  }
};

Readable.prototype._emitEnd = function () {
  const st = this._rState;
  st.endEmitted = true;
  st.pumping = false;
  this.emit("end");
};

Readable.prototype._pump = function () {
  const st = this._rState;
  if (!st.flowing || st.destroyed) {
    st.pumping = false;
    return;
  }
  if (st.buffer.length > 0) {
    const chunk = st.buffer.shift();
    this.emit("data", chunk);
    queueMicrotask(() => this._pump());
    return;
  }
  if (st.ended) {
    if (!st.endEmitted) this._emitEnd();
    return;
  }
  if (this._read && !st.reading) {
    st.reading = true;
    queueMicrotask(() => this._callRead());
    return;
  }
  // Waiting for an external push(); it will re-enter _pump.
  st.pumping = false;
};

Readable.prototype.pause = function () {
  this._rState.flowing = false;
  return this;
};

Readable.prototype.resume = function () {
  const st = this._rState;
  if (!st.flowing) {
    st.flowing = true;
    if (!st.pumping) {
      st.pumping = true;
      queueMicrotask(() => this._pump());
    }
  }
  return this;
};

Readable.prototype.on = function (type, listener) {
  EventEmitter.prototype.on.call(this, type, listener);
  if (type === "data") this.resume();
  if (type === "end" && this._rState.endEmitted) queueMicrotask(listener);
  return this;
};

Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.once = function (type, listener) {
  EventEmitter.prototype.once.call(this, type, listener);
  if (type === "data") this.resume();
  if (type === "end" && this._rState.endEmitted) queueMicrotask(listener);
  return this;
};

Readable.prototype.prependListener = function (type, listener) {
  EventEmitter.prototype.prependListener.call(this, type, listener);
  if (type === "data") this.resume();
  return this;
};

Readable.prototype.prependOnceListener = function (type, listener) {
  EventEmitter.prototype.prependOnceListener.call(this, type, listener);
  if (type === "data") this.resume();
  return this;
};

Readable.prototype.pipe = function (dest, options = {}) {
  const onData = (chunk) => {
    const canContinue = dest.write(chunk);
    if (canContinue === false) {
      this.pause();
      dest.once("drain", () => this.resume());
    }
  };
  const onEnd = () => {
    if (options.end !== false && typeof dest.end === "function") dest.end();
    cleanup();
  };
  const onError = (err) => {
    cleanup();
    if (typeof dest.destroy === "function") dest.destroy(err);
    else dest.emit("error", err);
  };
  const cleanup = () => {
    this.off("data", onData);
    this.off("end", onEnd);
    this.off("error", onError);
  };
  this.on("data", onData);
  this.once("end", onEnd);
  this.once("error", onError);
  if (typeof dest.emit === "function") dest.emit("pipe", this);
  return dest;
};

Readable.prototype.unpipe = function (_dest) {
  this.removeAllListeners("data");
  return this;
};

Readable.prototype.destroy = function (err) {
  const st = this._rState;
  if (st.destroyed) return this;
  st.destroyed = true;
  st.flowing = false;
  if (err) this.emit("error", err);
  this.emit("close");
  return this;
};

Readable.prototype[Symbol.asyncIterator] = function () {
  const stream = this;
  return {
    next() {
      return new Promise((resolve, reject) => {
        const st = stream._rState;
        if (st.buffer.length > 0) {
          resolve({ value: st.buffer.shift(), done: false });
          return;
        }
        if (st.endEmitted || (st.ended && st.buffer.length === 0)) {
          resolve({ value: undefined, done: true });
          return;
        }
        stream.once("end", () => resolve({ value: undefined, done: true }));
        stream.once("error", reject);
        const onData = (chunk) => {
          stream.pause();
          stream.off("data", onData);
          resolve({ value: chunk, done: false });
        };
        stream.on("data", onData);
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

Readable.from = function (iterable) {
  const iterator = iterable[Symbol.asyncIterator]?.() ?? iterable[Symbol.iterator]?.();
  if (!iterator) throw new TypeError("Readable.from: argument is not iterable");
  const stream = new Readable();
  const pull = () => {
    Promise.resolve(iterator.next()).then(
      ({ value, done }) => {
        if (done) stream.push(null);
        else {
          stream.push(value);
          if (!stream._rState.destroyed && !stream._rState.ended) queueMicrotask(pull);
        }
      },
      (err) => stream.destroy(err),
    );
  };
  queueMicrotask(pull);
  return stream;
};

Readable.toWeb = function (stream) {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => {
        controller.enqueue(chunk);
      });
      stream.on("end", () => {
        controller.close();
      });
      stream.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel(reason) {
      stream.destroy(reason);
    },
  });
};

Readable.fromWeb = function (webStream) {
  const reader = webStream.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
        } else {
          this.push(value);
        }
      } catch (err) {
        this.destroy(err);
      }
    },
  });
};

// ---- Writable ----------------------------------------------------------------

function Writable(options = {}) {
  EventEmitter.call(this);
  if (typeof options.write === "function") this._write = options.write;
  if (typeof options.final === "function") this._final = options.final;
  this._wState = {
    buffer: [],
    writing: false,
    ending: false,
    ended: false,
    finished: false,
    destroyed: false,
  };
}
inherit(Writable, EventEmitter);

Object.defineProperty(Writable.prototype, "writableEnded", {
  get() {
    return this._wState.ended;
  },
});

Object.defineProperty(Writable.prototype, "writableFinished", {
  get() {
    return this._wState.finished;
  },
});

Writable.prototype.write = function (chunk, encoding, cb) {
  [encoding, cb] = normalizeWriteArgs(encoding, cb);
  const st = this._wState;
  if (st.ended) {
    const err = new Error("write after end");
    if (cb) queueMicrotask(() => cb(err));
    else this.emit("error", err);
    return false;
  }
  const entry = { chunk, encoding, cb };
  if (st.writing) {
    st.buffer.push(entry);
  } else {
    this._doWrite(entry);
  }
  return st.buffer.length < 16;
};

Writable.prototype._doWrite = function (entry) {
  const st = this._wState;
  st.writing = true;
  let called = false;
  const done = (err) => {
    if (called) return;
    called = true;
    st.writing = false;
    if (entry.cb) entry.cb(err ?? null);
    if (err) {
      this.emit("error", err);
      return;
    }
    if (st.buffer.length > 0) {
      this._doWrite(st.buffer.shift());
    } else if (st.ending) {
      this._doFinal();
    } else {
      this.emit("drain");
    }
  };
  if (this._write) {
    try {
      this._write(entry.chunk, entry.encoding, done);
    } catch (err) {
      done(err);
    }
  } else {
    queueMicrotask(done);
  }
};

Writable.prototype._doFinal = function () {
  const st = this._wState;
  const finish = (err) => {
    if (err) {
      this.emit("error", err);
      return;
    }
    st.finished = true;
    this.emit("finish");
  };
  if (this._final) {
    try {
      this._final(finish);
    } catch (err) {
      finish(err);
    }
  } else {
    finish(null);
  }
};

Writable.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === "function") {
    cb = chunk;
    chunk = undefined;
    encoding = undefined;
  } else if (typeof encoding === "function") {
    cb = encoding;
    encoding = undefined;
  }
  const st = this._wState;
  if (st.ended) {
    if (cb) queueMicrotask(cb);
    return this;
  }
  if (cb) this.once("finish", cb);
  // Write the final chunk before marking ended, or write() rejects it.
  if (chunk !== undefined && chunk !== null) {
    this.write(chunk, encoding);
  }
  st.ended = true;
  st.ending = true;
  if (!st.writing && st.buffer.length === 0) {
    queueMicrotask(() => this._doFinal());
  }
  return this;
};

Writable.prototype.destroy = function (err) {
  const st = this._wState;
  if (st.destroyed) return this;
  st.destroyed = true;
  if (err) this.emit("error", err);
  this.emit("close");
  return this;
};

Writable.toWeb = function (nodeWritable) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = nodeWritable.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
        if (ok) resolve();
      });
    },
    close() {
      return new Promise((resolve) => {
        nodeWritable.end(resolve);
      });
    },
    abort(reason) {
      nodeWritable.destroy(reason);
    },
  });
};

Writable.fromWeb = function (webStream) {
  const writer = webStream.getWriter();
  return new Writable({
    async write(chunk, encoding, callback) {
      try {
        await writer.write(chunk);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    async final(callback) {
      try {
        await writer.close();
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
};

// ---- Transform -----------------------------------------------------------------

function Transform(options = {}) {
  Readable.call(this, options);
  if (typeof options.transform === "function") this._transform = options.transform;
  if (typeof options.flush === "function") this._flush = options.flush;
  this._tState = {
    queue: [],
    transforming: false,
    ending: false,
    ended: false,
    finished: false,
  };
}
inherit(Transform, Readable);

Transform.prototype.write = function (chunk, encoding, cb) {
  [encoding, cb] = normalizeWriteArgs(encoding, cb);
  const st = this._tState;
  if (st.ended) {
    const err = new Error("write after end");
    if (cb) queueMicrotask(() => cb(err));
    else this.emit("error", err);
    return false;
  }
  st.queue.push({ chunk, encoding, cb });
  this._process();
  return st.queue.length < 16;
};

Transform.prototype._process = function () {
  const st = this._tState;
  if (st.transforming) return;
  if (st.queue.length === 0) {
    if (st.ending && !st.finished) this._doFlush();
    return;
  }
  const entry = st.queue.shift();
  st.transforming = true;
  let called = false;
  const done = (err, data) => {
    if (called) return;
    called = true;
    st.transforming = false;
    if (entry.cb) entry.cb(err ?? null);
    if (err) {
      this.emit("error", err);
      return;
    }
    if (data !== undefined && data !== null) this.push(data);
    this.emit("drain");
    this._process();
  };
  if (this._transform) {
    try {
      this._transform(entry.chunk, entry.encoding, done);
    } catch (err) {
      done(err);
    }
  } else {
    done(null, entry.chunk);
  }
};

Transform.prototype._doFlush = function () {
  const st = this._tState;
  st.finished = true;
  const finish = (err, data) => {
    if (err) {
      this.emit("error", err);
      return;
    }
    if (data !== undefined && data !== null) this.push(data);
    this.push(null);
    this.emit("finish");
  };
  if (this._flush) {
    try {
      this._flush(finish);
    } catch (err) {
      finish(err);
    }
  } else {
    finish(null);
  }
};

Transform.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === "function") {
    cb = chunk;
    chunk = undefined;
    encoding = undefined;
  } else if (typeof encoding === "function") {
    cb = encoding;
    encoding = undefined;
  }
  const st = this._tState;
  if (st.ended) {
    if (cb) queueMicrotask(cb);
    return this;
  }
  if (cb) this.once("finish", cb);
  if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
  st.ended = true;
  st.ending = true;
  this._process();
  return this;
};

Object.defineProperty(Transform.prototype, "writableEnded", {
  get() {
    return this._tState.ended;
  },
});

// ---- Duplex / PassThrough -------------------------------------------------------

function Duplex(options = {}) {
  Readable.call(this, options);
  this._wState = {
    buffer: [],
    writing: false,
    ending: false,
    ended: false,
    finished: false,
    destroyed: false,
  };
  if (typeof options.write === "function") this._write = options.write;
  if (typeof options.final === "function") this._final = options.final;
}
inherit(Duplex, Readable);
Duplex.prototype.write = Writable.prototype.write;
Duplex.prototype._doWrite = Writable.prototype._doWrite;
Duplex.prototype._doFinal = Writable.prototype._doFinal;
Duplex.prototype.end = Writable.prototype.end;
Object.defineProperty(
  Duplex.prototype,
  "writableEnded",
  Object.getOwnPropertyDescriptor(Writable.prototype, "writableEnded"),
);
Object.defineProperty(
  Duplex.prototype,
  "writableFinished",
  Object.getOwnPropertyDescriptor(Writable.prototype, "writableFinished"),
);
const readableDestroy = Readable.prototype.destroy;
Duplex.prototype.destroy = function (err) {
  if (this._wState) this._wState.destroyed = true;
  return readableDestroy.call(this, err);
};

function PassThrough(options = {}) {
  Transform.call(this, options);
}
inherit(PassThrough, Transform);

// ---- pipeline --------------------------------------------------------------------

function pipeline(...args) {
  let cb;
  if (typeof args[args.length - 1] === "function") cb = args.pop();
  const streams = args;
  if (streams.length < 2) throw new TypeError("pipeline requires at least two streams");

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    for (const stream of streams) {
      if (typeof stream.once === "function") stream.once("error", fail);
    }
    const last = streams[streams.length - 1];
    last.once("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    last.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    for (let i = 0; i < streams.length - 1; i++) {
      streams[i].pipe(streams[i + 1]);
    }
  });

  if (cb) {
    promise.then(() => cb(null), cb);
    return undefined;
  }
  return promise;
}

// ---- finished --------------------------------------------------------------------

function finished(stream, opts, cb) {
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  opts = opts || {};
  if (!cb) {
    return new Promise((resolve, reject) => {
      finished(stream, opts, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  let closed = false;
  const onfinish = () => {
    if (closed) return;
    closed = true;
    cleanup();
    cb();
  };
  const onclose = () => {
    if (closed) return;
    closed = true;
    cleanup();
    cb();
  };
  const onerror = (err) => {
    if (closed) return;
    closed = true;
    cleanup();
    cb(err);
  };
  const onend = () => {
    if (closed) return;
    closed = true;
    cleanup();
    cb();
  };

  function cleanup() {
    if (typeof stream.removeListener === "function") {
      stream.removeListener("finish", onfinish);
      stream.removeListener("close", onclose);
      stream.removeListener("error", onerror);
      stream.removeListener("end", onend);
    }
  }

  if (typeof stream.once === "function") {
    const isReadable = opts.readable !== false && stream.readable !== false;
    const isWritable = opts.writable !== false && stream.writable !== false;

    if (stream.destroyed || (isReadable && stream.readableEnded) || (isWritable && stream.writableEnded)) {
      queueMicrotask(() => cb());
      return () => {};
    }

    stream.once("error", onerror);
    stream.once("close", onclose);
    if (isWritable) {
      stream.once("finish", onfinish);
    }
    if (isReadable) {
      stream.once("end", onend);
    }
  } else {
    queueMicrotask(() => cb());
  }

  return cleanup;
}

const consumers = {
  async buffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  },
  async text(stream, encoding = "utf8") {
    const buf = await consumers.buffer(stream);
    return buf.toString(encoding);
  },
  async json(stream) {
    const str = await consumers.text(stream);
    return JSON.parse(str);
  },
  async arrayBuffer(stream) {
    const buf = await consumers.buffer(stream);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async blob(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return new Blob(chunks);
  },
};

const promises = {
  pipeline,
  finished,
  ...consumers,
};

export { Readable, Writable, Transform, Duplex, PassThrough, pipeline, finished, promises, consumers };
// Node compatibility: require("stream") IS the Stream constructor with the
// concrete classes as properties (util.inherits(X, require("stream"))).
export const Stream = Readable;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Transform = Transform;
Stream.Duplex = Duplex;
Stream.PassThrough = PassThrough;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.promises = promises;
Stream.consumers = consumers;
Stream.Stream = Stream;
export default Stream;

