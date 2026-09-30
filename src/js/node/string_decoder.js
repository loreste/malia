// node:string_decoder: decodes Buffers to strings for every Buffer encoding,
// holding back what cannot be decoded yet (a split UTF-8 or UTF-16
// character, or a partial base64 group) until the next write() or end().
const ops = Deno.core.ops;

const ENCODINGS = {
  "utf8": "utf8", "utf-8": "utf8",
  "utf16le": "utf16le", "utf-16le": "utf16le", "ucs2": "utf16le", "ucs-2": "utf16le",
  "base64": "base64", "base64url": "base64url",
  "hex": "hex",
  "latin1": "latin1", "binary": "latin1",
  "ascii": "ascii",
};

function normalizeEncoding(encoding) {
  const enc = ENCODINGS[String(encoding ?? "utf8").toLowerCase()];
  if (!enc) {
    const err = new TypeError(`Unknown encoding: ${encoding}`);
    err.code = "ERR_UNKNOWN_ENCODING";
    throw err;
  }
  return enc;
}

// Length of the longest prefix of `bytes` that ends on a UTF-8 character
// boundary.
function utf8Boundary(bytes) {
  const len = bytes.length;
  for (let i = len - 1; i >= Math.max(0, len - 4); i--) {
    const b = bytes[i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    return i + need <= len ? len : i;
  }
  return len;
}

// Bytes that can be decoded now; the rest waits for more input.
function completeLength(encoding, bytes) {
  switch (encoding) {
    case "utf8":
      return utf8Boundary(bytes);
    case "utf16le": {
      let n = bytes.length - (bytes.length % 2);
      // Keep a trailing high surrogate for its low half.
      if (n >= 2 && bytes[n - 1] >= 0xd8 && bytes[n - 1] <= 0xdb) n -= 2;
      return n;
    }
    case "base64":
    case "base64url":
      return bytes.length - (bytes.length % 3);
    default:
      return bytes.length;
  }
}

const toBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

class StringDecoder {
  constructor(encoding = "utf8") {
    this.encoding = normalizeEncoding(encoding);
    this._pending = new Uint8Array(0);
  }

  write(buffer) {
    if (typeof buffer === "string") return buffer;
    const input = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    let bytes = input;
    if (this._pending.length > 0) {
      bytes = new Uint8Array(this._pending.length + input.length);
      bytes.set(this._pending, 0);
      bytes.set(input, this._pending.length);
    }
    const n = completeLength(this.encoding, bytes);
    this._pending = bytes.slice(n);
    const complete = bytes.subarray(0, n);
    return this.encoding === "utf8" ? ops.op_text_decode(complete) : toBuffer(complete).toString(this.encoding);
  }

  // Flush: an incomplete UTF-8/UTF-16 character decodes lossily, and a
  // partial base64 group is encoded with padding, as in Node.
  end(buffer) {
    let out = buffer !== undefined && buffer !== null ? this.write(buffer) : "";
    if (this._pending.length > 0) {
      const rest = this._pending;
      this._pending = new Uint8Array(0);
      out += this.encoding === "utf8" ? ops.op_text_decode(rest) : toBuffer(rest).toString(this.encoding);
    }
    return out;
  }

  text(buffer, offset) {
    return this.write(buffer.subarray(offset));
  }
}

export { StringDecoder };
export default { StringDecoder };
