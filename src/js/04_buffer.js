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
  // Decoding accepts both the standard and URL-safe alphabets, as Node does.
  const B64_LOOKUP = new Map([...B64_CHARS].map((c, i) => [c, i]).concat([["-", 62], ["_", 63]]));

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

  function hexValue(code) {
    if (code >= 48 && code <= 57) return code - 48; // 0-9
    code |= 0x20; // lowercase
    return code >= 97 && code <= 102 ? code - 87 : -1; // a-f
  }

  // Like Node: decode pairs up to the first invalid one, drop an odd tail.
  function hexDecode(str) {
    str = String(str);
    const n = str.length >>> 1;
    const bytes = new Uint8Array(n);
    let i = 0;
    for (; i < n; i++) {
      const hi = hexValue(str.charCodeAt(i * 2));
      const lo = hexValue(str.charCodeAt(i * 2 + 1));
      if (hi < 0 || lo < 0) break;
      bytes[i] = hi * 16 + lo;
    }
    return i === n ? bytes : bytes.slice(0, i);
  }

  function normEnc(encoding) {
    const enc = String(encoding || "utf8").toLowerCase();
    if (enc === "utf-8") return "utf8";
    if (enc === "binary") return "latin1";
    if (enc === "ucs2" || enc === "ucs-2" || enc === "utf-16le") return "utf16le";
    return enc;
  }

  const ENCODINGS = new Set(["utf8", "base64", "base64url", "hex", "latin1", "ascii", "utf16le"]);

  function base64UrlEncode(bytes) {
    return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function encodeString(str, encoding) {
    const enc = normEnc(encoding);
    if (enc === "base64" || enc === "base64url") return base64Decode(str);
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
    if (enc === "base64url") return base64UrlEncode(bytes);
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

  // ---- Bounds/range errors (Node's messages and codes) ----------------------

  function rangeError(code, message) {
    const err = new RangeError(message);
    err.code = code;
    return err;
  }

  // 1234567890 -> "1_234_567_890", as Node prints large received values.
  function addNumericalSeparator(val) {
    let res = "";
    let i = val.length;
    const start = val[0] === "-" ? 1 : 0;
    for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
    return `${val.slice(0, i)}${res}`;
  }

  function outOfRange(name, range, value) {
    let received;
    if (typeof value === "bigint") {
      received = String(value);
      if (value > 2n ** 32n || value < -(2n ** 32n)) received = addNumericalSeparator(received);
      received += "n";
    } else if (Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
      received = addNumericalSeparator(String(value));
    } else {
      received = __jse.inspect(value);
    }
    return rangeError("ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be ${range}. Received ${received}`);
  }

  function checkOffset(buf, offset, size) {
    if (typeof offset !== "number") throw __jse.invalidArgType("offset", "number", offset);
    const last = buf.length - size;
    if (offset >= 0 && offset <= last && Math.floor(offset) === offset) return;
    if (Math.floor(offset) !== offset) throw outOfRange("offset", "an integer", offset);
    if (last < 0) throw rangeError("ERR_BUFFER_OUT_OF_BOUNDS", "Attempt to access memory outside buffer bounds");
    throw outOfRange("offset", `>= 0 and <= ${last}`, offset);
  }

  function checkInt(value, min, max, buf, offset, size) {
    if (value > max || value < min) {
      const range = size > 4
        ? `>= ${min === 0 ? "0" : `-(2 ** ${size * 8 - 1})`} and < 2 ** ${min === 0 ? size * 8 : size * 8 - 1}`
        : `>= ${min} and <= ${max}`;
      throw outOfRange("value", range, value);
    }
    checkOffset(buf, offset, size);
  }

  function checkByteLength(byteLength) {
    if (!(byteLength >= 1 && byteLength <= 6) || Math.floor(byteLength) !== byteLength) {
      throw outOfRange("byteLength", ">= 1 and <= 6", byteLength);
    }
  }

  // Scratch space for float conversions; bytes are copied in host order and
  // reversed for the other endianness.
  const f32 = new Float32Array(1);
  const f32u8 = new Uint8Array(f32.buffer);
  const f64 = new Float64Array(1);
  const f64u8 = new Uint8Array(f64.buffer);
  const hostLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function readFloat(buf, offset, scratchU8, scratch, littleEndian) {
    const n = scratchU8.length;
    checkOffset(buf, offset, n);
    const same = littleEndian === hostLE;
    for (let i = 0; i < n; i++) scratchU8[same ? i : n - 1 - i] = buf[offset + i];
    return scratch[0];
  }

  function writeFloat(buf, value, offset, scratchU8, scratch, littleEndian) {
    const n = scratchU8.length;
    checkOffset(buf, offset, n);
    scratch[0] = +value;
    const same = littleEndian === hostLE;
    for (let i = 0; i < n; i++) buf[offset + i] = scratchU8[same ? i : n - 1 - i];
    return offset + n;
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

    fill(value, offset = 0, end = this.length, encoding) {
      if (typeof offset === "string") {
        encoding = offset;
        offset = 0;
        end = this.length;
      } else if (typeof end === "string") {
        encoding = end;
        end = this.length;
      }
      if (offset < 0 || offset > this.length) throw outOfRange("offset", `>= 0 && <= ${this.length}`, offset);
      if (end < 0 || end > this.length) throw outOfRange("end", `>= 0 && <= ${this.length}`, end);
      if (end <= offset) return this;
      let pattern;
      if (typeof value === "string") {
        if (encoding !== undefined && !ENCODINGS.has(normEnc(encoding))) {
          const err = new TypeError(`Unknown encoding: ${encoding}`);
          err.code = "ERR_UNKNOWN_ENCODING";
          throw err;
        }
        pattern = encodeString(value, encoding);
        if (pattern.length === 0) {
          if (value !== "") {
            const err = new TypeError(`The argument 'value' is invalid. Received '${value}'`);
            err.code = "ERR_INVALID_ARG_VALUE";
            throw err;
          }
          return super.fill(0, offset, end);
        }
      } else if (ArrayBuffer.isView(value)) {
        pattern = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else {
        return super.fill(Number(value) & 255, offset, end);
      }
      if (pattern.length === 1) return super.fill(pattern[0], offset, end);
      for (let pos = offset; pos < end; pos += pattern.length) {
        this.set(end - pos < pattern.length ? pattern.subarray(0, end - pos) : pattern, pos);
      }
      return this;
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
      const max = 50;
      let str = "";
      for (let i = 0; i < Math.min(max, this.length); i++) str += (i ? " " : "") + this[i].toString(16).padStart(2, "0");
      if (this.length > max) str += ` ... ${this.length - max} more byte${this.length - max > 1 ? "s" : ""}`;
      return `<${this.constructor.name} ${str}>`;
    }

    // Integer reads/writes use byte arithmetic (as Node does) instead of a
    // DataView per call.
    readUInt8(offset = 0) {
      checkOffset(this, offset, 1);
      return this[offset];
    }
    readUInt16LE(offset = 0) {
      checkOffset(this, offset, 2);
      return this[offset] + this[offset + 1] * 2 ** 8;
    }
    readUInt16BE(offset = 0) {
      checkOffset(this, offset, 2);
      return this[offset] * 2 ** 8 + this[offset + 1];
    }
    readUInt32LE(offset = 0) {
      checkOffset(this, offset, 4);
      return this[offset] + this[offset + 1] * 2 ** 8 + this[offset + 2] * 2 ** 16 + this[offset + 3] * 2 ** 24;
    }
    readUInt32BE(offset = 0) {
      checkOffset(this, offset, 4);
      return this[offset] * 2 ** 24 + this[offset + 1] * 2 ** 16 + this[offset + 2] * 2 ** 8 + this[offset + 3];
    }
    readInt8(offset = 0) {
      checkOffset(this, offset, 1);
      const v = this[offset];
      return v | ((v & 2 ** 7) * 0x1fffffe);
    }
    readInt16LE(offset = 0) {
      checkOffset(this, offset, 2);
      const v = this[offset] + this[offset + 1] * 2 ** 8;
      return v | ((v & 2 ** 15) * 0x1fffe);
    }
    readInt16BE(offset = 0) {
      checkOffset(this, offset, 2);
      const v = this[offset] * 2 ** 8 + this[offset + 1];
      return v | ((v & 2 ** 15) * 0x1fffe);
    }
    readInt32LE(offset = 0) {
      checkOffset(this, offset, 4);
      return this[offset] + this[offset + 1] * 2 ** 8 + this[offset + 2] * 2 ** 16 + (this[offset + 3] << 24);
    }
    readInt32BE(offset = 0) {
      checkOffset(this, offset, 4);
      return (this[offset] << 24) + this[offset + 1] * 2 ** 16 + this[offset + 2] * 2 ** 8 + this[offset + 3];
    }
    readUIntLE(offset, byteLength) {
      checkByteLength(byteLength);
      checkOffset(this, offset, byteLength);
      let val = 0;
      for (let i = byteLength - 1; i >= 0; i--) val = val * 2 ** 8 + this[offset + i];
      return val;
    }
    readUIntBE(offset, byteLength) {
      checkByteLength(byteLength);
      checkOffset(this, offset, byteLength);
      let val = 0;
      for (let i = 0; i < byteLength; i++) val = val * 2 ** 8 + this[offset + i];
      return val;
    }
    readIntLE(offset, byteLength) {
      const val = this.readUIntLE(offset, byteLength);
      return val >= 2 ** (byteLength * 8 - 1) ? val - 2 ** (byteLength * 8) : val;
    }
    readIntBE(offset, byteLength) {
      const val = this.readUIntBE(offset, byteLength);
      return val >= 2 ** (byteLength * 8 - 1) ? val - 2 ** (byteLength * 8) : val;
    }
    readFloatLE(offset = 0) { return readFloat(this, offset, f32u8, f32, true); }
    readFloatBE(offset = 0) { return readFloat(this, offset, f32u8, f32, false); }
    readDoubleLE(offset = 0) { return readFloat(this, offset, f64u8, f64, true); }
    readDoubleBE(offset = 0) { return readFloat(this, offset, f64u8, f64, false); }

    writeUInt8(value, offset = 0) {
      checkInt((value = +value), 0, 0xff, this, offset, 1);
      this[offset] = value;
      return offset + 1;
    }
    writeUInt16LE(value, offset = 0) {
      checkInt((value = +value), 0, 0xffff, this, offset, 2);
      this[offset] = value;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    }
    writeUInt16BE(value, offset = 0) {
      checkInt((value = +value), 0, 0xffff, this, offset, 2);
      this[offset] = value >>> 8;
      this[offset + 1] = value;
      return offset + 2;
    }
    writeUInt32LE(value, offset = 0) {
      checkInt((value = +value), 0, 0xffffffff, this, offset, 4);
      this[offset] = value;
      this[offset + 1] = value >>> 8;
      this[offset + 2] = value >>> 16;
      this[offset + 3] = value >>> 24;
      return offset + 4;
    }
    writeUInt32BE(value, offset = 0) {
      checkInt((value = +value), 0, 0xffffffff, this, offset, 4);
      this[offset] = value >>> 24;
      this[offset + 1] = value >>> 16;
      this[offset + 2] = value >>> 8;
      this[offset + 3] = value;
      return offset + 4;
    }
    writeInt8(value, offset = 0) {
      checkInt((value = +value), -0x80, 0x7f, this, offset, 1);
      this[offset] = value;
      return offset + 1;
    }
    writeInt16LE(value, offset = 0) {
      checkInt((value = +value), -0x8000, 0x7fff, this, offset, 2);
      this[offset] = value;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    }
    writeInt16BE(value, offset = 0) {
      checkInt((value = +value), -0x8000, 0x7fff, this, offset, 2);
      this[offset] = value >>> 8;
      this[offset + 1] = value;
      return offset + 2;
    }
    writeInt32LE(value, offset = 0) {
      checkInt((value = +value), -0x80000000, 0x7fffffff, this, offset, 4);
      this[offset] = value;
      this[offset + 1] = value >>> 8;
      this[offset + 2] = value >>> 16;
      this[offset + 3] = value >>> 24;
      return offset + 4;
    }
    writeInt32BE(value, offset = 0) {
      checkInt((value = +value), -0x80000000, 0x7fffffff, this, offset, 4);
      this[offset] = value >>> 24;
      this[offset + 1] = value >>> 16;
      this[offset + 2] = value >>> 8;
      this[offset + 3] = value;
      return offset + 4;
    }
    writeUIntLE(value, offset, byteLength) {
      checkByteLength(byteLength);
      checkInt((value = +value), 0, 2 ** (byteLength * 8) - 1, this, offset, byteLength);
      for (let i = 0; i < byteLength; i++) {
        this[offset + i] = value % 256;
        value = Math.floor(value / 256);
      }
      return offset + byteLength;
    }
    writeUIntBE(value, offset, byteLength) {
      checkByteLength(byteLength);
      checkInt((value = +value), 0, 2 ** (byteLength * 8) - 1, this, offset, byteLength);
      for (let i = byteLength - 1; i >= 0; i--) {
        this[offset + i] = value % 256;
        value = Math.floor(value / 256);
      }
      return offset + byteLength;
    }
    writeIntLE(value, offset, byteLength) {
      checkByteLength(byteLength);
      const bits = byteLength * 8 - 1;
      checkInt((value = +value), -(2 ** bits), 2 ** bits - 1, this, offset, byteLength);
      return this.writeUIntLE(value < 0 ? value + 2 ** (bits + 1) : value, offset, byteLength);
    }
    writeIntBE(value, offset, byteLength) {
      checkByteLength(byteLength);
      const bits = byteLength * 8 - 1;
      checkInt((value = +value), -(2 ** bits), 2 ** bits - 1, this, offset, byteLength);
      return this.writeUIntBE(value < 0 ? value + 2 ** (bits + 1) : value, offset, byteLength);
    }
    writeFloatLE(value, offset = 0) { return writeFloat(this, value, offset, f32u8, f32, true); }
    writeFloatBE(value, offset = 0) { return writeFloat(this, value, offset, f32u8, f32, false); }
    writeDoubleLE(value, offset = 0) { return writeFloat(this, value, offset, f64u8, f64, true); }
    writeDoubleBE(value, offset = 0) { return writeFloat(this, value, offset, f64u8, f64, false); }

    readBigInt64LE(offset = 0) { checkOffset(this, offset, 8); return dataView(this).getBigInt64(offset, true); }
    readBigInt64BE(offset = 0) { checkOffset(this, offset, 8); return dataView(this).getBigInt64(offset, false); }
    readBigUInt64LE(offset = 0) { checkOffset(this, offset, 8); return dataView(this).getBigUint64(offset, true); }
    readBigUInt64BE(offset = 0) { checkOffset(this, offset, 8); return dataView(this).getBigUint64(offset, false); }

    writeBigInt64LE(value, offset = 0) {
      if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) throw outOfRange("value", ">= -(2n ** 63n) and < 2n ** 63n", value);
      checkOffset(this, offset, 8);
      dataView(this).setBigInt64(offset, BigInt(value), true);
      return offset + 8;
    }
    writeBigInt64BE(value, offset = 0) {
      if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) throw outOfRange("value", ">= -(2n ** 63n) and < 2n ** 63n", value);
      checkOffset(this, offset, 8);
      dataView(this).setBigInt64(offset, BigInt(value), false);
      return offset + 8;
    }
    writeBigUInt64LE(value, offset = 0) {
      if (value < 0n || value > 2n ** 64n - 1n) throw outOfRange("value", ">= 0n and < 2n ** 64n", value);
      checkOffset(this, offset, 8);
      dataView(this).setBigUint64(offset, BigInt(value), true);
      return offset + 8;
    }
    writeBigUInt64BE(value, offset = 0) {
      if (value < 0n || value > 2n ** 64n - 1n) throw outOfRange("value", ">= 0n and < 2n ** 64n", value);
      checkOffset(this, offset, 8);
      dataView(this).setBigUint64(offset, BigInt(value), false);
      return offset + 8;
    }

    utf8Slice(start, end) { return this.toString("utf8", start, end); }
    latin1Slice(start, end) { return this.toString("latin1", start, end); }
    asciiSlice(start, end) { return this.toString("ascii", start, end); }
    hexSlice(start, end) { return this.toString("hex", start, end); }
    base64Slice(start, end) { return this.toString("base64", start, end); }
    base64urlSlice(start, end) { return this.toString("base64url", start, end); }
    ucs2Slice(start, end) { return this.toString("utf16le", start, end); }

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
      return typeof encoding === "string" && encoding !== "" && ENCODINGS.has(normEnc(encoding));
    }

  // Node's lowercase "Uint" aliases (readUint8, writeUint32LE, ...).
  for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
    if (name.includes("UInt")) Buffer.prototype[name.replace("UInt", "Uint")] = Buffer.prototype[name];
  }

  Buffer.compare = function (a, b) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      if (a.length === b.length) return 0;
      return a.length < b.length ? -1 : 1;
    }


  Buffer.alloc = function (size, fill, encoding) {
      if (typeof size !== "number") throw __jse.invalidArgType("size", "number", size);
      if (!(size >= 0 && size <= 2 ** 53 - 1)) throw outOfRange("size", ">= 0 && <= 9007199254740991", size);
      const buf = allocOf(size);
      if (fill !== undefined && fill !== 0 && size > 0) buf.fill(fill, encoding);
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
  // DOMException is defined later in the bootstrap (12_websocket.js); these
  // only run after startup.
  const invalidCharacter = (message) => new DOMException(message, "InvalidCharacterError");

  globalThis.atob = (data) => {
    data = String(data).replace(/[\t\n\f\r ]/g, "");
    if (data.length % 4 === 0) data = data.replace(/==?$/, "");
    if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) {
      throw invalidCharacter("The string to be decoded is not correctly encoded.");
    }
    return decodeBytes(base64Decode(data), "latin1");
  };
  globalThis.btoa = (data) => {
    data = String(data);
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c > 0xff) throw invalidCharacter("Invalid character");
      bytes[i] = c;
    }
    return base64Encode(bytes);
  };
})(globalThis);
