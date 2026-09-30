// node:zlib — gzip/deflate/raw via flate2. Brotli factories still throw.
import { Transform } from "node:stream";

const ops = Deno.core.ops;

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function levelOf(options) {
  if (typeof options === "number") return options;
  if (options && typeof options.level === "number") return options.level;
  return -1;
}

function toBytes(buf) {
  if (typeof buf === "string") return Buffer.from(buf);
  if (Buffer.isBuffer(buf)) return buf;
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return Buffer.from(buf ?? []);
}

class ZlibTransform extends Transform {
  constructor(kind, options) {
    super();
    this._id = ops.op_zlib_new(kind, levelOf(options));
  }

  _transform(chunk, _encoding, cb) {
    const self = this;
    ops.op_zlib_write_off(this._id, toBytes(chunk), false).then(
      (out) => {
        if (out.byteLength) self.push(asBuffer(out));
        cb();
      },
      (err) => cb(err),
    );
  }

  _flush(cb) {
    const self = this;
    ops.op_zlib_write_off(this._id, new Uint8Array(0), true).then(
      (out) => {
        if (out.byteLength) self.push(asBuffer(out));
        ops.op_zlib_close(self._id);
        cb();
      },
      (err) => cb(err),
    );
  }
}

function syncOp(kind) {
  return (buf, options) => {
    const id = ops.op_zlib_new(kind, levelOf(options));
    try {
      return asBuffer(ops.op_zlib_write(id, toBytes(buf), true));
    } finally {
      ops.op_zlib_close(id);
    }
  };
}

function callbackOp(kind) {
  return (buf, options, cb) => {
    if (typeof options === "function") {
      cb = options;
      options = undefined;
    }
    const promise = ops.op_zlib_oneshot(kind, levelOf(options), toBytes(buf)).then(asBuffer);
    if (typeof cb === "function") {
      promise.then(
        (value) => queueMicrotask(() => cb(null, value)),
        (err) => queueMicrotask(() => cb(err)),
      );
      return undefined;
    }
    return promise;
  };
}

function factory(kind) {
  return (options) => new ZlibTransform(kind, options);
}

export const gzipSync = syncOp(0);
export const gunzipSync = syncOp(1);
export const deflateSync = syncOp(2);
export const inflateSync = syncOp(3);
export const deflateRawSync = syncOp(4);
export const inflateRawSync = syncOp(5);

export const gzip = callbackOp(0);
export const gunzip = callbackOp(1);
export const deflate = callbackOp(2);
export const inflate = callbackOp(3);
export const deflateRaw = callbackOp(4);
export const inflateRaw = callbackOp(5);

export const createGzip = factory(0);
export const createGunzip = factory(1);
export const createDeflate = factory(2);
export const createInflate = factory(3);
export const createDeflateRaw = factory(4);
export const createInflateRaw = factory(5);

export const createBrotliCompress = factory(6);
export const createBrotliDecompress = factory(7);
export const brotliCompressSync = syncOp(6);
export const brotliDecompressSync = syncOp(7);
export const brotliCompress = callbackOp(6);
export const brotliDecompress = callbackOp(7);

export function unzipSync(buf, options) {
  const bytes = toBytes(buf);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes, options);
  }
  return inflateSync(bytes, options);
}

export function unzip(buf, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  const bytes = toBytes(buf);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzip(bytes, options, cb);
  }
  return inflate(bytes, options, cb);
}

class UnzipTransform extends Transform {
  constructor(options) {
    super();
    this._options = options;
    this._inner = null;
  }

  _transform(chunk, encoding, cb) {
    if (!this._inner) {
      const b = toBytes(chunk);
      const isGzip = b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
      this._inner = isGzip ? createGunzip(this._options) : createInflate(this._options);
      this._inner.on("data", (data) => this.push(data));
      this._inner.on("error", (err) => this.emit("error", err));
    }
    this._inner.write(chunk, encoding, cb);
  }

  _flush(cb) {
    if (this._inner) {
      this._inner.end(cb);
    } else {
      cb();
    }
  }
}

export function createUnzip(options) {
  return new UnzipTransform(options);
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(data, value = 0) {
  const bytes = toBytes(data);
  let crc = (value ^ -1) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  BROTLI_DECODE: 1,
  BROTLI_ENCODE: 2,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
};

export default {
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  gzip,
  gunzip,
  deflate,
  inflate,
  deflateRaw,
  inflateRaw,
  createGzip,
  createGunzip,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createBrotliCompress,
  createBrotliDecompress,
  brotliCompressSync,
  brotliDecompressSync,
  brotliCompress,
  brotliDecompress,
  unzipSync,
  unzip,
  createUnzip,
  crc32,
  constants,
};
