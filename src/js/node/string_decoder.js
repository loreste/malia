// node:string_decoder shim: StringDecoder for utf8 (the dominant case),
// with correct multi-byte boundary handling across write() calls.
const ops = Deno.core.ops;

function normalizeEncoding(encoding) {
  const enc = String(encoding ?? "utf8").toLowerCase();
  if (["utf8", "utf-8", "latin1", "binary"].includes(enc)) return enc;
  return "utf8";
}

// Length of the longest prefix of `bytes` (starting at `from`) that ends on
// a UTF-8 character boundary.
function utf8Boundary(bytes, from) {
  const len = bytes.length;
  let i = len;
  const start = Math.max(from, len - 4);
  while (i > start) {
    i -= 1;
    const b = bytes[i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    return i + need <= len ? len : i;
  }
  return from;
}

class StringDecoder {
  constructor(encoding = "utf8") {
    this.encoding = normalizeEncoding(encoding);
    this._pending = new Uint8Array(0);
  }

  write(buffer) {
    const input = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let bytes;
    if (this._pending.length > 0) {
      bytes = new Uint8Array(this._pending.length + input.length);
      bytes.set(this._pending, 0);
      bytes.set(input, this._pending.length);
    } else {
      bytes = input;
    }
    if (this.encoding === "latin1" || this.encoding === "binary") {
      this._pending = new Uint8Array(0);
      return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    }
    const complete = utf8Boundary(bytes, 0);
    this._pending = bytes.slice(complete);
    return ops.op_text_decode(bytes.subarray(0, complete));
  }

  end(buffer) {
    let out = "";
    if (buffer !== undefined && buffer !== null) {
      out = this.write(buffer);
    }
    if (this._pending.length > 0) {
      // Lossy decode of the incomplete tail (U+FFFD), like Node.
      out += ops.op_text_decode(this._pending);
      this._pending = new Uint8Array(0);
    }
    return out;
  }
}

export { StringDecoder };
export default { StringDecoder };
