// WHATWG Streams globals (ReadableStream, WritableStream, TransformStream,
// ...). node:stream/web re-exports these.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  class ByteLengthQueuingStrategy {
    constructor({ highWaterMark }) {
      this.highWaterMark = highWaterMark;
    }
    size(chunk) {
      return chunk?.byteLength ?? 0;
    }
  }

  class CountQueuingStrategy {
    constructor({ highWaterMark }) {
      this.highWaterMark = highWaterMark;
    }
    size() {
      return 1;
    }
  }

  class ReadableStreamDefaultController {
    constructor(stream, underlyingSource, _strategy) {
      this._stream = stream;
      this._source = underlyingSource;
      this._queue = [];
      this._pendingPulls = [];
      this._closeRequested = false;
    }

    get desiredSize() {
      if (this._closeRequested) return 0;
      return 1 - this._queue.length;
    }

    enqueue(chunk) {
      if (this._closeRequested) throw new TypeError("Cannot enqueue after close requested");
      if (this._pendingPulls.length > 0) {
        const resolver = this._pendingPulls.shift();
        resolver({ value: chunk, done: false });
      } else {
        this._queue.push(chunk);
      }
    }

    close() {
      if (this._closeRequested) return;
      this._closeRequested = true;
      while (this._pendingPulls.length > 0) {
        const resolver = this._pendingPulls.shift();
        resolver({ value: undefined, done: true });
      }
    }

    error(e) {
      this._stream._errored = e;
      while (this._pendingPulls.length > 0) {
        const resolver = this._pendingPulls.shift();
        resolver(Promise.reject(e));
      }
    }
  }

  class ReadableStreamDefaultReader {
    constructor(stream) {
      if (stream.locked) throw new TypeError("ReadableStream is locked");
      this._stream = stream;
      stream._reader = this;
    }

    get closed() {
      return this._stream._closedPromise;
    }

    async read() {
      const stream = this._stream;
      if (stream._errored) return Promise.reject(stream._errored);
      const controller = stream._controller;
      if (controller._queue.length > 0) {
        const value = controller._queue.shift();
        return { value, done: false };
      }
      if (controller._closeRequested) {
        return { value: undefined, done: true };
      }
      return new Promise((resolve, reject) => {
        controller._pendingPulls.push(resolve);
        if (typeof controller._source.pull === "function") {
          try {
            Promise.resolve(controller._source.pull(controller)).catch(reject);
          } catch (err) {
            reject(err);
          }
        }
      });
    }

    releaseLock() {
      if (this._stream) {
        this._stream._reader = null;
        this._stream = null;
      }
    }

    cancel(reason) {
      return this._stream.cancel(reason);
    }
  }

  class ReadableStream {
    constructor(underlyingSource = {}, strategy = {}) {
      this._underlyingSource = underlyingSource;
      this._strategy = strategy;
      this._reader = null;
      this._errored = null;
      this._closedPromise = new Promise((resolve) => {
        this._closeResolve = resolve;
      });
      this._controller = new ReadableStreamDefaultController(this, underlyingSource, strategy);

      if (typeof underlyingSource.start === "function") {
        try {
          const p = underlyingSource.start(this._controller);
          if (p && typeof p.then === "function") {
            p.catch((err) => this._controller.error(err));
          }
        } catch (err) {
          this._controller.error(err);
        }
      }
    }

    get locked() {
      return this._reader !== null;
    }

    getReader(_options = {}) {
      return new ReadableStreamDefaultReader(this);
    }

    async cancel(reason) {
      if (typeof this._underlyingSource.cancel === "function") {
        return this._underlyingSource.cancel(reason);
      }
    }

    pipeThrough({ writable, readable }, options) {
      // Errors reach `readable` through the writable's abort; don't leave
      // the pipe promise rejected and unhandled.
      this.pipeTo(writable, options).catch(() => {});
      return readable;
    }

    async pipeTo(dest, options = {}) {
      const reader = this.getReader();
      const writer = dest.getWriter();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            if (!options.preventClose) await writer.close();
            break;
          }
          await writer.write(value);
        }
      } catch (err) {
        if (!options.preventAbort) await writer.abort(err);
        throw err;
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    }

    tee() {
      let controller1, controller2;
      const s1 = new ReadableStream({
        start(c) {
          controller1 = c;
        },
      });
      const s2 = new ReadableStream({
        start(c) {
          controller2 = c;
        },
      });

      const reader = this.getReader();
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              controller1.close();
              controller2.close();
              break;
            }
            controller1.enqueue(value);
            controller2.enqueue(value);
          }
        } catch (err) {
          controller1.error(err);
          controller2.error(err);
        }
      })();

      return [s1, s2];
    }

    [Symbol.asyncIterator]() {
      const reader = this.getReader();
      return {
        async next() {
          const { value, done } = await reader.read();
          if (done) {
            reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value };
        },
        async return() {
          reader.releaseLock();
          return { done: true, value: undefined };
        },
      };
    }

    values(_options = {}) {
      return this[Symbol.asyncIterator]();
    }
  }

  class WritableStreamDefaultController {
    constructor(stream, underlyingSink) {
      this._stream = stream;
      this._sink = underlyingSink;
    }

    error(e) {
      this._stream._errored = e;
    }
  }

  class WritableStreamDefaultWriter {
    constructor(stream) {
      if (stream.locked) throw new TypeError("WritableStream is locked");
      this._stream = stream;
      stream._writer = this;
    }

    get desiredSize() {
      return 1;
    }

    get ready() {
      return Promise.resolve();
    }

    get closed() {
      return this._stream._closedPromise;
    }

    async write(chunk) {
      if (this._stream._errored) return Promise.reject(this._stream._errored);
      if (typeof this._stream._underlyingSink.write === "function") {
        return this._stream._underlyingSink.write(chunk, this._stream._controller);
      }
    }

    async close() {
      return this._stream.close();
    }

    async abort(reason) {
      return this._stream.abort(reason);
    }

    releaseLock() {
      if (this._stream) {
        this._stream._writer = null;
        this._stream = null;
      }
    }
  }

  class WritableStream {
    constructor(underlyingSink = {}, strategy = {}) {
      this._underlyingSink = underlyingSink;
      this._strategy = strategy;
      this._writer = null;
      this._errored = null;
      this._closedPromise = new Promise((resolve) => {
        this._closeResolve = resolve;
      });
      this._controller = new WritableStreamDefaultController(this, underlyingSink);
      if (typeof underlyingSink.start === "function") {
        try {
          underlyingSink.start(this._controller);
        } catch (err) {
          this._controller.error(err);
        }
      }
    }

    get locked() {
      return this._writer !== null;
    }

    getWriter() {
      return new WritableStreamDefaultWriter(this);
    }

    async abort(reason) {
      if (typeof this._underlyingSink.abort === "function") {
        return this._underlyingSink.abort(reason);
      }
    }

    async close() {
      if (typeof this._underlyingSink.close === "function") {
        await this._underlyingSink.close();
      }
      this._closeResolve();
    }
  }

  class TransformStream {
    constructor(transformer = {}, writableStrategy = {}, readableStrategy = {}) {
      let controller;
      this.readable = new ReadableStream(
        {
          start(c) {
            controller = c;
          },
        },
        readableStrategy,
      );

      this.writable = new WritableStream(
        {
          start(_wc) {
            if (typeof transformer.start === "function") {
              return transformer.start(controller);
            }
          },
          write(chunk, _wc) {
            if (typeof transformer.transform === "function") {
              return transformer.transform(chunk, controller);
            }
            controller.enqueue(chunk);
          },
          async close() {
            if (typeof transformer.flush === "function") {
              await transformer.flush(controller);
            }
            controller.close();
          },
          abort(reason) {
            controller.error(reason);
          },
        },
        writableStrategy,
      );
    }
  }

  class TextEncoderStream extends TransformStream {
    constructor() {
      const encoder = new TextEncoder();
      super({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(chunk));
        },
      });
    }
  }

  class TextDecoderStream extends TransformStream {
    constructor(label = "utf-8", options = {}) {
      const decoder = new TextDecoder(label, options);
      super({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk, { stream: true }));
        },
        flush(controller) {
          const remaining = decoder.decode();
          if (remaining) controller.enqueue(remaining);
        },
      });
    }
  }

  // WHATWG formats -> zlib op kinds (encoder; decoder is kind + 1).
  const ZLIB_KINDS = { gzip: 0, deflate: 2, "deflate-raw": 4 };

  function zlibTransformer(format, decompress) {
    const kind = ZLIB_KINDS[format];
    if (kind === undefined) {
      throw new TypeError(`Unsupported compression format: '${format}'`);
    }
    const id = ops.op_zlib_new(kind + (decompress ? 1 : 0), -1);
    return {
      transform(chunk, controller) {
        if (!ArrayBuffer.isView(chunk) && !(chunk instanceof ArrayBuffer)) {
          throw new TypeError("chunk must be an ArrayBuffer or ArrayBufferView");
        }
        const bytes = chunk instanceof Uint8Array
          ? chunk
          : ArrayBuffer.isView(chunk)
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : new Uint8Array(chunk);
        const out = ops.op_zlib_write(id, bytes, false);
        if (out.length) controller.enqueue(out);
      },
      flush(controller) {
        try {
          const out = ops.op_zlib_write(id, new Uint8Array(0), true);
          if (out.length) controller.enqueue(out);
        } finally {
          ops.op_zlib_close(id);
        }
      },
    };
  }

  class CompressionStream extends TransformStream {
    constructor(format) {
      super(zlibTransformer(format, false));
    }
  }

  class DecompressionStream extends TransformStream {
    constructor(format) {
      super(zlibTransformer(format, true));
    }
  }

  // Node exposes these as writable, configurable, non-enumerable globals.
  for (const [name, value] of Object.entries({
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamDefaultController,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    TransformStream,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream,
  })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
  }
})(globalThis);
