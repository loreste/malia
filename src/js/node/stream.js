// node:stream: Node's stream implementation (readable-stream 4, vendored in
// jse:internal/readable_stream) wired to this runtime's builtins, plus the
// web-stream adapters (toWeb/fromWeb).
import EventEmitter from "node:events";
import { StringDecoder } from "node:string_decoder";
import loadReadableStream from "jse:internal/readable_stream";

const builtins = {
  events: EventEmitter,
  buffer: { Buffer: globalThis.Buffer, Blob: globalThis.Blob },
  "string_decoder/": { StringDecoder },
  "process/": globalThis.process,
  "abort-controller": { AbortController: globalThis.AbortController, AbortSignal: globalThis.AbortSignal },
  // Only consulted when READABLE_STREAM=disable; never the case here.
  stream: null,
};

const Stream = loadReadableStream((id) => {
  if (!(id in builtins)) throw new Error(`readable-stream: unexpected require("${id}")`);
  return builtins[id];
});

const { Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, promises } = Stream;

Readable.toWeb = function (stream) {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel(reason) {
      stream.destroy(reason);
    },
  });
};

Readable.fromWeb = function (webStream, options) {
  const reader = webStream.getReader();
  return new Readable({
    ...options,
    async read() {
      try {
        const { done, value } = await reader.read();
        this.push(done ? null : value);
      } catch (err) {
        this.destroy(err);
      }
    },
  });
};

Writable.toWeb = function (nodeWritable) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = nodeWritable.write(chunk, (err) => (err ? reject(err) : resolve()));
        if (ok) resolve();
      });
    },
    close() {
      return new Promise((resolve) => nodeWritable.end(resolve));
    },
    abort(reason) {
      nodeWritable.destroy(reason);
    },
  });
};

Writable.fromWeb = function (webStream, options) {
  const writer = webStream.getWriter();
  return new Writable({
    ...options,
    async write(chunk, _encoding, callback) {
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

export const {
  addAbortSignal,
  compose,
  destroy,
  isDisturbed,
  isErrored,
  isReadable,
  _isUint8Array,
  _uint8ArrayToBuffer,
} = Stream;
export { Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, promises, Stream };
export default Stream;
