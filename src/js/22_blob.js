// Blob, File, and FormData globals (WHATWG File API / XHR FormData).
// Blob contents are held in memory as one Uint8Array.
"use strict";

((globalThis) => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const kBytes = Symbol("bytes");

  function partBytes(part) {
    if (part instanceof Blob) return part[kBytes];
    if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));
    if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
    return encoder.encode(String(part));
  }

  // Per the spec, a type with characters outside U+0020..U+007E is dropped.
  function normalizeType(type) {
    const t = String(type ?? "");
    return /^[\x20-\x7e]*$/.test(t) ? t.toLowerCase() : "";
  }

  class Blob {
    constructor(parts = [], options = {}) {
      if (parts === null || typeof parts !== "object" || typeof parts[Symbol.iterator] !== "function") {
        throw new TypeError("Failed to construct 'Blob': The provided value cannot be converted to a sequence.");
      }
      const chunks = Array.from(parts, partBytes);
      const size = chunks.reduce((n, c) => n + c.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this[kBytes] = bytes;
      this._type = normalizeType(options?.type);
    }

    get size() {
      return this[kBytes].byteLength;
    }

    get type() {
      return this._type;
    }

    slice(start = 0, end = this.size, contentType = "") {
      const size = this.size;
      const clamp = (n) => (n < 0 ? Math.max(size + n, 0) : Math.min(n, size));
      const from = clamp(Math.trunc(Number(start) || 0));
      const to = clamp(Math.trunc(Number(end ?? size)));
      const blob = new Blob([], { type: contentType });
      blob[kBytes] = this[kBytes].slice(from, Math.max(from, to));
      return blob;
    }

    async arrayBuffer() {
      return this[kBytes].slice().buffer;
    }

    async bytes() {
      return this[kBytes].slice();
    }

    async text() {
      return decoder.decode(this[kBytes]);
    }

    stream() {
      const bytes = this[kBytes];
      return new ReadableStream({
        start(controller) {
          if (bytes.byteLength) controller.enqueue(bytes.slice());
          controller.close();
        },
      });
    }

    get [Symbol.toStringTag]() {
      return "Blob";
    }
  }

  class File extends Blob {
    constructor(parts, name, options = {}) {
      if (arguments.length < 2) {
        throw new TypeError("Failed to construct 'File': 2 arguments required, but only " + arguments.length + " present.");
      }
      super(parts, options);
      this._name = String(name);
      this._lastModified = options?.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    }

    get name() {
      return this._name;
    }

    get lastModified() {
      return this._lastModified;
    }

    get webkitRelativePath() {
      return "";
    }

    get [Symbol.toStringTag]() {
      return "File";
    }
  }

  // FormData entry values are strings or Files; Blobs become Files.
  function entryValue(value, filename) {
    if (value instanceof Blob) {
      if (value instanceof File && filename === undefined) return value;
      const file = new File([], filename ?? (value instanceof File ? value.name : "blob"), {
        type: value.type,
        lastModified: value instanceof File ? value.lastModified : undefined,
      });
      file[kBytes] = value[kBytes];
      return file;
    }
    return String(value);
  }

  class FormData {
    #entries = [];

    append(name, value, filename) {
      this.#entries.push([String(name), entryValue(value, filename)]);
    }

    set(name, value, filename) {
      name = String(name);
      const entry = [name, entryValue(value, filename)];
      const first = this.#entries.findIndex(([n]) => n === name);
      if (first === -1) {
        this.#entries.push(entry);
        return;
      }
      this.#entries = this.#entries.filter(([n], i) => n !== name || i === first);
      this.#entries[first] = entry;
    }

    get(name) {
      return this.#entries.find(([n]) => n === String(name))?.[1] ?? null;
    }

    getAll(name) {
      return this.#entries.filter(([n]) => n === String(name)).map(([, v]) => v);
    }

    has(name) {
      return this.#entries.some(([n]) => n === String(name));
    }

    delete(name) {
      this.#entries = this.#entries.filter(([n]) => n !== String(name));
    }

    *entries() {
      for (const [name, value] of this.#entries) yield [name, value];
    }

    *keys() {
      for (const [name] of this.#entries) yield name;
    }

    *values() {
      for (const [, value] of this.#entries) yield value;
    }

    forEach(callback, thisArg) {
      for (const [name, value] of this.#entries) callback.call(thisArg, value, name, this);
    }

    [Symbol.iterator]() {
      return this.entries();
    }

    get [Symbol.toStringTag]() {
      return "FormData";
    }
  }

  // multipart/form-data body for fetch(): { bytes, type }.
  function encodeFormData(form) {
    const boundary = `----formdata-jse-${crypto.randomUUID().replaceAll("-", "")}`;
    const escape = (s) => s.replaceAll("\n", "%0A").replaceAll("\r", "%0D").replaceAll('"', "%22");
    const parts = [];
    for (const [name, value] of form) {
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"`;
      if (typeof value === "string") {
        parts.push(`${head}\r\n\r\n`, value.replace(/\r?\n|\r/g, "\r\n"), "\r\n");
      } else {
        head += `; filename="${escape(value.name)}"\r\nContent-Type: ${value.type || "application/octet-stream"}`;
        parts.push(`${head}\r\n\r\n`, value, "\r\n");
      }
    }
    parts.push(`--${boundary}--\r\n`);
    return { bytes: new Blob(parts)[kBytes], type: `multipart/form-data; boundary=${boundary}` };
  }

  globalThis.Blob = Blob;
  globalThis.File = File;
  globalThis.FormData = FormData;
  globalThis.__jse.blobBytes = (blob) => blob[kBytes];
  globalThis.__jse.encodeFormData = encodeFormData;
})(globalThis);
