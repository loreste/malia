// Buffer: Uint8Array-based Node Buffer shim, plus atob/btoa globals.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  // TextEncoder/TextDecoder backed by Rust UTF-8 ops (V8 does not bundle
  // them, and a pure-JS implementation is 10-50x slower on hot paths like
  // Buffer.from/Buffer.prototype.toString).
  globalThis.TextEncoder = class TextEncoder {
    encode(str) {
      return ops.op_text_encode(String(str));
    }
  };
  const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8"]);
  const UTF16LE_LABELS = new Set(["utf-16le", "utf-16"]);
  const LATIN1_LABELS = new Set(["latin1", "iso-8859-1", "ascii", "us-ascii", "windows-1252"]);

  // Length of a trailing UTF-8 sequence that is cut off at the end of
  // `bytes` (0 if the buffer ends on a character boundary).
  function incompleteUtf8Tail(bytes) {
    const n = bytes.length;
    for (let back = 1; back <= 3 && back <= n; back++) {
      const b = bytes[n - back];
      if ((b & 0xc0) !== 0x80) {
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        return need > back ? back : 0;
      }
    }
    return 0;
  }

  function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    return ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
  }

  globalThis.TextDecoder = class TextDecoder {
    #fatal;
    #ignoreBOM;
    #encoding;
    #pending = null; // bytes held back from the previous { stream: true } call
    #bomSeen = false;

    constructor(label = "utf-8", options = {}) {
      const name = String(label).trim().toLowerCase();
      if (UTF8_LABELS.has(name)) this.#encoding = "utf-8";
      else if (UTF16LE_LABELS.has(name)) this.#encoding = "utf-16le";
      else if (LATIN1_LABELS.has(name)) this.#encoding = "windows-1252";
      else {
        const err = new RangeError(`The "${label}" encoding is not supported`);
        err.code = "ERR_ENCODING_NOT_SUPPORTED";
        throw err;
      }
      this.#fatal = Boolean(options?.fatal);
      this.#ignoreBOM = Boolean(options?.ignoreBOM);
    }

    get encoding() {
      return this.#encoding;
    }

    get fatal() {
      return this.#fatal;
    }

    get ignoreBOM() {
      return this.#ignoreBOM;
    }

    decode(input, options) {
      const stream = Boolean(options?.stream);
      // Hot path: one-shot UTF-8 decode with nothing buffered.
      if (!stream && this.#pending === null && this.#encoding === "utf-8" && !this.#fatal) {
        if (!input) return "";
        const bytes = toUint8(input);
        if (!this.#ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          return ops.op_text_decode(bytes.subarray(3));
        }
        return ops.op_text_decode(bytes);
      }

      let bytes = input ? toUint8(input) : new Uint8Array(0);
      if (this.#pending !== null) {
        const joined = new Uint8Array(this.#pending.length + bytes.length);
        joined.set(this.#pending);
        joined.set(bytes, this.#pending.length);
        bytes = joined;
        this.#pending = null;
      }
      if (stream) {
        const keep = this.#encoding === "utf-8"
          ? incompleteUtf8Tail(bytes)
          : this.#encoding === "utf-16le" ? bytes.length % 2 : 0;
        if (keep) {
          this.#pending = bytes.slice(bytes.length - keep);
          bytes = bytes.subarray(0, bytes.length - keep);
        }
      }

      let text = this.#encoding === "utf-8"
        ? ops.op_text_decode(bytes)
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .toString(this.#encoding === "utf-16le" ? "utf16le" : "latin1");
      if (this.#fatal && this.#encoding === "utf-8" && text.includes("\uFFFD") && !validUtf8(bytes)) {
        this.#pending = null;
        this.#bomSeen = false;
        const err = new TypeError("The encoded data was not valid for encoding utf-8");
        err.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
        throw err;
      }
      if (!this.#bomSeen && text.length > 0) {
        this.#bomSeen = true;
        if (!this.#ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (!stream) this.#bomSeen = false;
      return text;
    }
  };

  // Strict UTF-8 validation (only used when fatal is set and U+FFFD appears).
  function validUtf8(bytes) {
    try {
      decodeURIComponent(Array.prototype.map.call(bytes, (b) => "%" + b.toString(16).padStart(2, "0")).join(""));
      return true;
    } catch {
      return false;
    }
  }

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_LOOKUP = new Map([...B64_CHARS].map((c, i) => [c, i]));

  function base64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
      out += B64_CHARS[b0 >> 2];
      out += B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
      out += b1 === undefined ? "=" : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
      out += b2 === undefined ? "=" : B64_CHARS[b2 & 63];
    }
    return out;
  }

  function base64Decode(str) {
    const clean = String(str).replace(/[\s=]+$/g, "").replace(/=/g, "");
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (const ch of clean) {
      const v = B64_LOOKUP.get(ch);
      if (v === undefined) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }

  function hexEncode(bytes) {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  function hexDecode(str) {
    const clean = String(str).replace(/[^0-9a-fA-F]/g, "");
    const bytes = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function normEnc(encoding) {
    const enc = String(encoding || "utf8").toLowerCase();
    if (enc === "utf-8") return "utf8";
    if (enc === "binary") return "latin1";
    if (enc === "ucs2" || enc === "ucs-2" || enc === "utf-16le") return "utf16le";
    return enc;
  }

  function encodeString(str, encoding) {
    const enc = normEnc(encoding);
    if (enc === "base64") return base64Decode(str);
    if (enc === "hex") return hexDecode(str);
    if (enc === "latin1") {
      const bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
      return bytes;
    }
    if (enc === "ascii") {
      const bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0x7f;
      return bytes;
    }
    if (enc === "utf16le") {
      const bytes = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        bytes[i * 2] = c & 0xff;
        bytes[i * 2 + 1] = c >> 8;
      }
      return bytes;
    }
    return ops.op_text_encode(str);
  }

  function decodeBytes(bytes, encoding) {
    const enc = normEnc(encoding);
    if (enc === "base64") return base64Encode(bytes);
    if (enc === "hex") return hexEncode(bytes);
    if (enc === "latin1") return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    if (enc === "ascii") return Array.from(bytes, (b) => String.fromCharCode(b & 0x7f)).join("");
    if (enc === "utf16le") {
      let out = "";
      const n = bytes.length - (bytes.length % 2);
      for (let i = 0; i < n; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return out;
    }
    return ops.op_text_decode(bytes);
  }

  function dataView(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function needleOf(value, encoding) {
    if (typeof value === "number") return Uint8Array.of(value & 0xff);
    if (typeof value === "string") return encodeString(value, encoding || "utf8");
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return encodeString(String(value), encoding || "utf8");
  }

  function searchBytes(buf, value, byteOffset, encoding, last) {
    const needle = needleOf(value, encoding);
    let start = byteOffset >> 0;
    if (start < 0) start = buf.length + start;
    if (needle.length === 0) {
      if (start < 0) return 0;
      if (start > buf.length) return buf.length;
      return start;
    }
    if (last) {
      let max = Math.min(start, buf.length - needle.length);
      if (byteOffset === undefined) max = buf.length - needle.length;
      for (let i = max; i >= 0; i--) {
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
          if (buf[i + j] !== needle[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      return -1;
    }
    const from = Math.max(0, start);
    const end = buf.length - needle.length;
    for (let i = from; i <= end; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (buf[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }

  // Fast internal constructors. `new Buffer(...)` goes through the custom
  // derived-class constructor (~120ns of V8 dispatch overhead); these are
  // the same Reflect.construct pattern subarray uses, which V8 optimizes
  // down to a direct typed-array allocation in method context.
  function allocOf(length) {
    return Reflect.construct(Uint8Array, [length], Buffer);
  }

  function copyOf(view) {
    return Reflect.construct(Uint8Array, [view], Buffer);
  }

  // Small-buffer pool, same as Node: buffers up to poolSize/2 are carved out
  // of a shared 8KB slab as views (~30ns) instead of paying for a fresh
  // ArrayBuffer allocation (~110ns). Callers must overwrite every byte
  // (from/concat do; allocUnsafe intentionally may not, like Node).
  const POOL_SIZE = 8192;
  let poolBuf = null;
  let poolOffset = 0;

  function pooled(length) {
    if (length > POOL_SIZE / 2) return allocOf(length);
    if (poolBuf === null || poolOffset + length > POOL_SIZE) {
      poolBuf = allocOf(POOL_SIZE);
      poolOffset = 0;
    }
    const out = poolBuf.subarray(poolOffset, poolOffset + length);
    poolOffset += (length + 7) & ~7; // 8-byte alignment, like Node
    return out;
  }

  class Buffer extends Uint8Array {
    constructor(arg, encoding) {
      if (typeof arg === "number") {
        super(arg);
      } else if (typeof arg === "string") {
        super(encodeString(arg, encoding || "utf8"));
      } else if (arg instanceof ArrayBuffer) {
        super(arg);
      } else if (ArrayBuffer.isView(arg)) {
        super(arg.buffer.slice(arg.byteOffset, arg.byteOffset + arg.byteLength));
      } else if (Array.isArray(arg)) {
        super(arg);
      } else {
        super(0);
      }
    }

    toString(encoding = "utf8", start = 0, end = this.length) {
      // Hot path: full-range utf8 decode goes straight to the op without
      // materializing a subarray view.
      if ((encoding === "utf8" || encoding === "utf-8") && start === 0 && end === this.length) {
        return ops.op_text_decode(this);
      }
      return decodeBytes(this.subarray(start, end), encoding);
    }

    toJSON() {
      return { type: "Buffer", data: Array.from(this) };
    }

    // Both return live views over the same memory (Node semantics), typed as
    // Buffer. Reflect.construct skips the copying constructor; the view is
    // built on the underlying ArrayBuffer with adjusted offsets.
    subarray(start = 0, end = this.length) {
      const len = this.length;
      const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      const e = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
      return Reflect.construct(
        Uint8Array,
        [this.buffer, this.byteOffset + s, Math.max(e - s, 0)],
        Buffer,
      );
    }

    slice(start, end) {
      return this.subarray(start, end);
    }

    write(string, offset = 0, length, encoding) {
      if (typeof offset === "string") {
        encoding = offset;
        offset = 0;
        length = this.length;
      } else if (typeof length === "string") {
        encoding = length;
        length = this.length - offset;
      }
      encoding = encoding || "utf8";
      const bytes = Buffer.from(string, encoding);
      const maxLen = length !== undefined ? Math.min(length, this.length - offset) : this.length - offset;
      const toWrite = Math.min(bytes.length, Math.max(0, maxLen));
      this.set(bytes.subarray(0, toWrite), offset);
      return toWrite;
    }

    equals(other) {
      if (this.length !== other.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }

    indexOf(value, byteOffset, encoding) {
      if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = 0;
      }
      return searchBytes(this, value, byteOffset ?? 0, encoding, false);
    }

    lastIndexOf(value, byteOffset, encoding) {
      if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = undefined;
      }
      return searchBytes(this, value, byteOffset ?? this.length, encoding, true);
    }

    includes(value, byteOffset, encoding) {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      const src = this.subarray(sourceStart, sourceEnd);
      const n = Math.min(src.length, Math.max(target.length - targetStart, 0));
      if (n > 0) target.set(src.subarray(0, n), targetStart);
      return n;
    }

    compare(other) {
      return Buffer.compare(this, other);
    }

    swap16() {
      if (this.length % 2 !== 0) throw new RangeError("Buffer size must be a multiple of 16-bits");
      for (let i = 0; i < this.length; i += 2) {
        const a = this[i];
        this[i] = this[i + 1];
        this[i + 1] = a;
      }
      return this;
    }

    swap32() {
      if (this.length % 4 !== 0) throw new RangeError("Buffer size must be a multiple of 32-bits");
      for (let i = 0; i < this.length; i += 4) {
        const a = this[i];
        const b = this[i + 1];
        this[i] = this[i + 3];
        this[i + 1] = this[i + 2];
        this[i + 2] = b;
        this[i + 3] = a;
      }
      return this;
    }

    readUInt8(offset = 0) { return dataView(this).getUint8(offset); }
    readUInt16LE(offset = 0) { return dataView(this).getUint16(offset, true); }
    readUInt16BE(offset = 0) { return dataView(this).getUint16(offset, false); }
    readUInt32LE(offset = 0) { return dataView(this).getUint32(offset, true); }
    readUInt32BE(offset = 0) { return dataView(this).getUint32(offset, false); }
    readInt8(offset = 0) { return dataView(this).getInt8(offset); }
    readInt16LE(offset = 0) { return dataView(this).getInt16(offset, true); }
    readInt16BE(offset = 0) { return dataView(this).getInt16(offset, false); }
    readInt32LE(offset = 0) { return dataView(this).getInt32(offset, true); }
    readInt32BE(offset = 0) { return dataView(this).getInt32(offset, false); }
    readFloatLE(offset = 0) { return dataView(this).getFloat32(offset, true); }
    readFloatBE(offset = 0) { return dataView(this).getFloat32(offset, false); }
    readDoubleLE(offset = 0) { return dataView(this).getFloat64(offset, true); }
    readDoubleBE(offset = 0) { return dataView(this).getFloat64(offset, false); }

    writeUInt8(value, offset = 0) { dataView(this).setUint8(offset, value); return offset + 1; }
    writeUInt16LE(value, offset = 0) { dataView(this).setUint16(offset, value, true); return offset + 2; }
    writeUInt16BE(value, offset = 0) { dataView(this).setUint16(offset, value, false); return offset + 2; }
    writeUInt32LE(value, offset = 0) { dataView(this).setUint32(offset, value, true); return offset + 4; }
    writeUInt32BE(value, offset = 0) { dataView(this).setUint32(offset, value, false); return offset + 4; }
    writeInt8(value, offset = 0) { dataView(this).setInt8(offset, value); return offset + 1; }
    writeInt16LE(value, offset = 0) { dataView(this).setInt16(offset, value, true); return offset + 2; }
    writeInt16BE(value, offset = 0) { dataView(this).setInt16(offset, value, false); return offset + 2; }
    writeInt32LE(value, offset = 0) { dataView(this).setInt32(offset, value, true); return offset + 4; }
    writeInt32BE(value, offset = 0) { dataView(this).setInt32(offset, value, false); return offset + 4; }
    writeFloatLE(value, offset = 0) { dataView(this).setFloat32(offset, value, true); return offset + 4; }
    writeFloatBE(value, offset = 0) { dataView(this).setFloat32(offset, value, false); return offset + 4; }
    writeDoubleLE(value, offset = 0) { dataView(this).setFloat64(offset, value, true); return offset + 8; }
    writeDoubleBE(value, offset = 0) { dataView(this).setFloat64(offset, value, false); return offset + 8; }

    readBigInt64LE(offset = 0) { return dataView(this).getBigInt64(offset, true); }
    readBigInt64BE(offset = 0) { return dataView(this).getBigInt64(offset, false); }
    readBigUInt64LE(offset = 0) { return dataView(this).getBigUint64(offset, true); }
    readBigUInt64BE(offset = 0) { return dataView(this).getBigUint64(offset, false); }

    writeBigInt64LE(value, offset = 0) { dataView(this).setBigInt64(offset, BigInt(value), true); return offset + 8; }
    writeBigInt64BE(value, offset = 0) { dataView(this).setBigInt64(offset, BigInt(value), false); return offset + 8; }
    writeBigUInt64LE(value, offset = 0) { dataView(this).setBigUint64(offset, BigInt(value), true); return offset + 8; }
    writeBigUInt64BE(value, offset = 0) { dataView(this).setBigUint64(offset, BigInt(value), false); return offset + 8; }

    utf8Slice(start, end) { return this.toString("utf8", start, end); }
    latin1Slice(start, end) { return this.toString("latin1", start, end); }
    asciiSlice(start, end) { return this.toString("ascii", start, end); }
    hexSlice(start, end) { return this.toString("hex", start, end); }
    base64Slice(start, end) { return this.toString("base64", start, end); }

    utf8Write(string, offset = 0, length = this.length - offset) {
      return this.write(string, offset, length, "utf8");
    }
    latin1Write(string, offset = 0, length = this.length - offset) {
      return this.write(string, offset, length, "latin1");
    }
    asciiWrite(string, offset = 0, length = this.length - offset) {
      return this.write(string, offset, length, "ascii");
    }
  }

Buffer.from = function (value, offsetOrEncoding, length) {
      // from(arraybuffer, byteOffset, length) shares memory (Node semantics).
      if (value instanceof ArrayBuffer && (offsetOrEncoding !== undefined || length !== undefined)) {
        const offset = offsetOrEncoding ?? 0;
        const len = length ?? value.byteLength - offset;
        return Reflect.construct(Uint8Array, [value, offset, len], Buffer);
      }
      // Fast path: from(string, utf8) wraps the freshly-encoded buffer
      // without a second copy (nothing else references it). Short ASCII
      // strings are encoded inline in JS (cheaper than an op round-trip).
      if (typeof value === "string") {
        const enc = offsetOrEncoding ?? "utf8";
        if (enc === "utf8" || enc === "utf-8") {
          const n = value.length;
          if (n <= 64) {
            // Pooled single-allocation path: build the Buffer view up front.
            const buf = pooled(n);
            let ascii = true;
            for (let i = 0; i < n; i++) {
              const c = value.charCodeAt(i);
              if (c > 127) {
                ascii = false;
                break;
              }
              buf[i] = c;
            }
            if (ascii) return buf;
          }
          const bytes = ops.op_text_encode(value);
          return Reflect.construct(Uint8Array, [bytes.buffer], Buffer);
        }
        return new Buffer(value, enc);
      }
      if (value instanceof Buffer) return copyOf(value);
      if (ArrayBuffer.isView(value)) return copyOf(value);
      if (Array.isArray(value)) return copyOf(value);
      return new Buffer(value, offsetOrEncoding);
    }


  Buffer.isEncoding = function (encoding) {
      return [
        "utf8", "utf-8", "base64", "hex", "latin1", "binary",
        "ascii", "utf16le", "ucs2", "ucs-2", "utf-16le",
      ].includes(String(encoding).toLowerCase());
    }

  Buffer.compare = function (a, b) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      if (a.length === b.length) return 0;
      return a.length < b.length ? -1 : 1;
    }


  Buffer.alloc = function (size, fill = 0) {
      const buf = allocOf(size);
      if (fill) buf.fill(fill);
      return buf;
    }


  Buffer.allocUnsafe = function (size) {
      return pooled(size);
    }


  Buffer.concat = function (list, totalLength) {
      let length = totalLength;
      if (length === undefined) {
        length = 0;
        for (const b of list) length += b.length;
      }
      const out = pooled(length);
      let offset = 0;
      for (const b of list) {
        const remaining = length - offset;
        if (remaining <= 0) break;
        if (b.length > remaining) {
          out.set(b.subarray(0, remaining), offset);
          offset = length;
          break;
        }
        out.set(b, offset);
        offset += b.length;
      }
      // Node zero-fills the tail when totalLength exceeds the sum of parts;
      // pool memory is not zeroed, so scrub it.
      if (offset < length) out.fill(0, offset);
      return out;
    }


  Buffer.isBuffer = function (value) {
      return value instanceof Buffer;
    }


  Buffer.byteLength = function (value, encoding = "utf8") {
      if (typeof value !== "string") return value.byteLength ?? value.length;
      return Buffer.from(value, encoding).length;
    }

  globalThis.Buffer = Buffer;
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
  globalThis.btoa = (s) => {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return base64Encode(bytes);
  };
})(globalThis);
