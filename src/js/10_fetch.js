// fetch(), Request, Response and Headers, backed by reqwest (rustls)
// through streaming ops. Response bodies are read lazily as chunk streams
// (response.body is async-iterable); text()/json()/arrayBuffer() drain the
// same stream, so whole-body helpers and streaming coexist.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  // ---- Headers ---------------------------------------------------------------

  class Headers {
    #map = new Map(); // lowercase name -> { name, values: [] }
    #joinedCache = null;

    constructor(init) {
      if (init === undefined || init === null) return;
      if (init instanceof Headers) {
        for (const [name, value] of init) this.append(name, value);
      } else if (Array.isArray(init)) {
        for (const [name, value] of init) this.append(name, value);
      } else if (typeof init === "object") {
        for (const name of Object.keys(init)) this.append(name, init[name]);
      } else {
        throw new TypeError("Headers: unsupported init");
      }
    }

    append(name, value) {
      this.#joinedCache = null;
      name = String(name);
      const key = name.toLowerCase();
      const entry = this.#map.get(key);
      if (entry) {
        entry.values.push(String(value));
      } else {
        this.#map.set(key, { name, values: [String(value)] });
      }
    }

    set(name, value) {
      this.#joinedCache = null;
      name = String(name);
      this.#map.set(name.toLowerCase(), { name, values: [String(value)] });
    }

    get(name) {
      const entry = this.#map.get(String(name).toLowerCase());
      return entry ? entry.values.join(", ") : null;
    }

    getSetCookie() {
      const entry = this.#map.get("set-cookie");
      return entry ? [...entry.values] : [];
    }

    has(name) {
      return this.#map.has(String(name).toLowerCase());
    }

    delete(name) {
      this.#joinedCache = null;
      this.#map.delete(String(name).toLowerCase());
    }

    // Internal (serve path): CRLF-joined header block, cached.
    _joined() {
      if (this.#joinedCache === null) {
        const parts = [];
        for (const { name, values } of this.#map.values()) {
          parts.push(name + ": " + values.join(", "));
        }
        this.#joinedCache = parts.join("\r\n");
      }
      return this.#joinedCache;
    }

    *entries() {
      for (const { name, values } of this.#map.values()) {
        yield [name, values.join(", ")];
      }
    }

    *keys() {
      for (const { name } of this.#map.values()) yield name;
    }

    *values() {
      for (const { values } of this.#map.values()) yield values.join(", ");
    }

    forEach(cb, thisArg) {
      for (const { name, values } of this.#map.values()) {
        cb.call(thisArg, values.join(", "), name, this);
      }
    }

    [Symbol.iterator]() {
      return this.entries();
    }
  }

  const sharedEncoder = new TextEncoder();
  const sharedDecoder = new TextDecoder();

  function toBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === "string") return sharedEncoder.encode(chunk);
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    throw new TypeError("body chunk must be a string or typed array");
  }

  // Shared with jse.serve (11_serve.js).
  globalThis.__jse.toBytes = toBytes;

  // Request body init -> { bytes, type } (type = default content-type or
  // null). Streams and (async) iterables return null: use drainBody.
  function extractBody(body) {
    if (typeof body === "string") {
      return { bytes: sharedEncoder.encode(body), type: "text/plain;charset=UTF-8" };
    }
    if (body instanceof URLSearchParams) {
      return {
        bytes: sharedEncoder.encode(body.toString()),
        type: "application/x-www-form-urlencoded;charset=UTF-8",
      };
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return { bytes: toBytes(body), type: null };
    }
    if (body instanceof Blob) {
      return { bytes: __jse.blobBytes(body), type: body.type || null };
    }
    if (body instanceof FormData) return __jse.encodeFormData(body);
    return null;
  }

  // ponytail: stream bodies are buffered before sending; pipe them into
  // reqwest (Body::wrap_stream) if large uploads need to stream.
  async function drainBody(body) {
    if (typeof body.getReader === "function" && typeof body[Symbol.asyncIterator] !== "function") {
      const reader = body.getReader();
      body = (async function* () {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      })();
    }
    if (typeof body[Symbol.asyncIterator] !== "function" && typeof body[Symbol.iterator] !== "function") {
      throw new TypeError("unsupported request body type");
    }
    const parts = [];
    let length = 0;
    for await (const chunk of body) {
      const bytes = toBytes(chunk);
      parts.push(bytes);
      length += bytes.length;
    }
    return { bytes: concatBytes(parts, length), type: null };
  }

  function concatBytes(parts, length) {
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  // ---- Shared body state (Request and Response) ------------------------------
  // Three shapes: materialized bytes, a user-supplied iterable, or a live
  // streaming fetch id.

  class BodyMixin {
    _bodyBytes; // Uint8Array | null
    _bodyIter; // user async/sync iterable | null
    _fetchId; // streaming fetch id | null
    _bodyUsed = false;

    get bodyUsed() {
      return this._bodyUsed;
    }

    get body() {
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return self._chunkIterator();
        },
        getReader() {
          const it = self._chunkIterator();
          return {
            read: () => it.next(),
            cancel: () => self._cancelStream(),
          };
        },
      };
    }

    async *_chunkIterator() {
      if (this._bodyUsed) throw new TypeError("Body has already been consumed");
      this._bodyUsed = true;
      if (this._bodyBytes !== null && this._bodyBytes !== undefined) {
        if (this._bodyBytes.length > 0) yield this._bodyBytes;
        return;
      }
      if (this._bodyIter) {
        for await (const chunk of this._bodyIter) yield toBytes(chunk);
        return;
      }
      if (this._fetchId !== null && this._fetchId !== undefined) {
        const id = this._fetchId;
        try {
          for (;;) {
            const chunk = await ops.op_fetch_read(id);
            if (chunk.length === 0) break;
            yield chunk;
          }
        } finally {
          this._fetchId = null;
          ops.op_fetch_close(id);
        }
      }
    }

    _cancelStream() {
      if (this._fetchId !== null && this._fetchId !== undefined) {
        const id = this._fetchId;
        this._fetchId = null;
        this._bodyUsed = true;
        ops.op_fetch_close(id);
      }
    }

    async _drainBytes() {
      const parts = [];
      let length = 0;
      for await (const chunk of this._chunkIterator()) {
        parts.push(chunk);
        length += chunk.length;
      }
      return concatBytes(parts, length);
    }

    async text() {
      return sharedDecoder.decode(await this._drainBytes());
    }

    async json() {
      return JSON.parse(await this.text());
    }

    async arrayBuffer() {
      const bytes = await this._drainBytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    async bytes() {
      return this._drainBytes();
    }

    async blob() {
      return new Blob([await this._drainBytes()], { type: this.headers.get("content-type") ?? "" });
    }

    async formData() {
      const type = this.headers.get("content-type") ?? "";
      const bytes = await this._drainBytes();
      if (/^application\/x-www-form-urlencoded\b/i.test(type)) {
        const form = new FormData();
        for (const [name, value] of new URLSearchParams(sharedDecoder.decode(bytes))) form.append(name, value);
        return form;
      }
      const boundary = /^multipart\/form-data\b.*?;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
      if (!boundary) throw new TypeError(`Could not parse content as FormData (content-type: ${type || "none"})`);
      return parseMultipart(bytes, boundary[1] ?? boundary[2]);
    }
  }

  // multipart/form-data -> FormData. Headers are read as latin1 so byte
  // offsets line up; field names and text values are UTF-8.
  function parseMultipart(bytes, boundary) {
    const form = new FormData();
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    const delimiter = `--${boundary}`;
    let pos = text.indexOf(delimiter);
    if (pos === -1) throw new TypeError("Could not parse content as FormData (missing boundary)");
    for (;;) {
      pos += delimiter.length;
      if (text.startsWith("--", pos)) break; // closing delimiter
      pos = text.indexOf("\r\n", pos) + 2;
      const headerEnd = text.indexOf("\r\n\r\n", pos);
      const next = text.indexOf(`\r\n${delimiter}`, headerEnd);
      if (pos < 2 || headerEnd === -1 || next === -1) {
        throw new TypeError("Could not parse content as FormData (truncated part)");
      }
      const headers = text.slice(pos, headerEnd);
      const body = bytes.subarray(headerEnd + 4, next);
      const utf8 = (s) => Buffer.from(s, "latin1").toString("utf8");
      const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? "";
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
      const partType = /^content-type:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? "";
      if (name !== undefined) {
        if (filename !== undefined) {
          form.append(utf8(name), new File([body], utf8(filename), { type: partType }));
        } else {
          form.append(utf8(name), sharedDecoder.decode(body));
        }
      }
      pos = next + 2;
    }
    return form;
  }

  // ---- Request -----------------------------------------------------------------

  class Request extends BodyMixin {
    _rawHeaders; // serve path only: header pairs until first access
    _headersCache;

    get headers() {
      let headers = this._headersCache;
      if (!headers) {
        headers = new Headers(this._rawHeaders ?? []);
        this._rawHeaders = null;
        this._headersCache = headers;
      }
      return headers;
    }

    constructor(input, init = {}) {
      super();
      if (input instanceof Request) {
        this.url = input.url;
        this.method = init.method ?? input.method;
        this._headersCache = new Headers(init.headers ?? input.headers);
        this._bodyBytes = input._bodyBytes;
      } else {
        this.url = String(input?.href ?? input);
        this.method = String(init.method ?? "GET").toUpperCase();
        this._headersCache = new Headers(init.headers);
        this._bodyBytes = new Uint8Array(0);
        if (init.body !== undefined && init.body !== null) {
          const extracted = extractBody(init.body);
          if (!extracted) throw new TypeError("Request: stream bodies are only supported by fetch()");
          this._bodyBytes = extracted.bytes;
          if (extracted.type && !this._headersCache.has("content-type")) {
            this._headersCache.set("content-type", extracted.type);
          }
        }
      }
      this.redirect = init.redirect ?? (input instanceof Request ? input.redirect : "follow");
    }

    // Internal: build from a raw serve request { method, url, headers, body }.
    // Headers are built lazily on first access: hot handlers that never
    // look at them skip the Map construction entirely.
    static _fromServe(raw) {
      const req = Object.create(Request.prototype);
      req.url = raw.url;
      req.method = raw.method;
      req._rawHeaders = raw.headers;
      req._bodyBytes = raw.body instanceof Uint8Array ? raw.body : new Uint8Array(raw.body ?? 0);
      req._bodyIter = null;
      req._fetchId = null;
      req._bodyUsed = false;
      return req;
    }
  }

  // ---- Response ----------------------------------------------------------------

  class Response extends BodyMixin {
    constructor(body = null, init = {}) {
      super();
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? "";
      // Lazy: built as a Headers instance on first access. The serve hot
      // path never constructs it (it joins the raw init directly).
      this._responseHeadersInit = init.headers;
      this._responseHeadersCache = null;
      this.url = "";
      this.redirected = false;
      this.type = "basic";
      if (body === null || body === undefined) {
        this._bodyBytes = new Uint8Array(0);
      } else if (
        typeof body === "string" ||
        body instanceof Uint8Array ||
        body instanceof ArrayBuffer ||
        ArrayBuffer.isView(body)
      ) {
        // Check byte-like bodies before iterables: strings ARE iterable
        // (per character) and must never take the stream path.
        this._bodyBytes = toBytes(body);
      } else if (body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) {
        const { bytes, type } = extractBody(body);
        this._bodyBytes = bytes;
        if (type) {
          const headers = new Headers(init.headers);
          if (!headers.has("content-type")) headers.set("content-type", type);
          this._responseHeadersInit = headers;
        }
      } else if (
        typeof body[Symbol.asyncIterator] === "function" ||
        typeof body[Symbol.iterator] === "function"
      ) {
        this._bodyBytes = null;
        this._bodyIter = body;
      } else {
        throw new TypeError("Response: unsupported body type");
      }
    }

    // Internal: build from a raw fetch head { id, status, status_text,
    // headers, url }.
    static _fromFetch(head, originalUrl) {
      const resp = Object.create(Response.prototype);
      resp.status = head.status;
      resp.statusText = head.status_text;
      resp.url = head.url;
      resp.redirected = Boolean(originalUrl && head.url !== originalUrl);
      resp.type = "basic";
      resp._responseHeadersCache = new Headers(head.headers);
      resp._responseHeadersInit = null;
      resp._bodyBytes = null;
      resp._bodyIter = null;
      resp._fetchId = head.id;
      resp._bodyUsed = false;
      return resp;
    }

    get ok() {
      return this.status >= 200 && this.status < 300;
    }

    get headers() {
      let headers = this._responseHeadersCache;
      if (!headers) {
        headers = new Headers(this._responseHeadersInit);
        this._responseHeadersInit = null;
        this._responseHeadersCache = headers;
      }
      return headers;
    }

    // Internal (serve path): CRLF-joined header block without paying for a
    // Headers instance when one was never materialized.
    _headersJoined() {
      if (this._responseHeadersCache) return this._responseHeadersCache._joined();
      const init = this._responseHeadersInit;
      if (!init) return "";
      if (init instanceof Headers) return init._joined();
      if (Array.isArray(init)) {
        return init.map(([name, value]) => name + ": " + value).join("\r\n");
      }
      const parts = [];
      for (const name of Object.keys(init)) parts.push(name + ": " + init[name]);
      return parts.join("\r\n");
    }

    // Internal (jse.serve / node:http): hand the body to the server as
    // either whole bytes or an async iterator of chunks.
    _serveBody() {
      if (
        this._bodyIter ||
        (this._fetchId !== null && this._fetchId !== undefined)
      ) {
        return { iter: this._chunkIterator() };
      }
      this._bodyUsed = true;
      return { full: this._bodyBytes ?? new Uint8Array(0) };
    }
  }

  // ---- fetch -------------------------------------------------------------------

  async function fetch(input, init = {}) {
    const url = typeof input === "string" ? input : String(input?.url ?? input?.href ?? input);
    const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let headerPairs = [];
    const headerInit = init.headers ?? (input instanceof Request ? input.headers : undefined);
    if (headerInit !== undefined) {
      for (const [name, value] of new Headers(headerInit)) headerPairs.push([name, value]);
    }
    let bodyBytes;
    const bodyInit = init.body ?? (input instanceof Request ? input._bodyBytes : undefined);
    if (bodyInit !== undefined && bodyInit !== null) {
      const { bytes, type } = extractBody(bodyInit) ?? (await drainBody(bodyInit));
      if (type && !headerPairs.some(([name]) => name.toLowerCase() === "content-type")) {
        headerPairs.push(["content-type", type]);
      }
      if (bytes.length !== 0) bodyBytes = bytes;
    }
    const redirect = String(init.redirect ?? (input instanceof Request ? input.redirect : "follow"));
    const head = await ops.op_fetch_start(url, method, headerPairs, bodyBytes, redirect);
    return Response._fromFetch(head, url);
  }

  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
})(globalThis);
