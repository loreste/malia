// node:http shim: createServer over the same hyper engine as jse.serve.
// Request bodies arrive whole (streamed to the 'data' listener as one
// chunk); responses can be written whole via end() or streamed via write().
import { EventEmitter } from "node:events";
import net from "node:net";
import { Writable } from "node:stream";

const ops = Deno.core.ops;
const { Buffer } = globalThis;

// Minimal socket stand-in: enough for on-finished/ee-first (event target)
// and for packages that read req.socket.remoteAddress.
function makeSocket() {
  const socket = new EventEmitter();
  socket.readable = true;
  socket.writable = true;
  socket.destroyed = false;
  socket.remoteAddress = "127.0.0.1";
  socket.remotePort = 0;
  socket.localAddress = "127.0.0.1";
  socket.localPort = 0;
  socket.destroy = () => {
    socket.destroyed = true;
    socket.readable = false;
    socket.writable = false;
  };
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  return socket;
}

function IncomingMessage(rawOrSocket) {
  EventEmitter.call(this);
  if (rawOrSocket && (rawOrSocket.method !== undefined || rawOrSocket.url !== undefined)) {
    const raw = rawOrSocket;
    this.method = raw.method;
    this.url = raw.url;
    this.httpVersion = "1.1";
    this.complete = false;
    this.readable = true;
    this.socket = makeSocket();
    this.connection = this.socket;
    this.headers = {};
    if (raw.headers) {
      for (const [name, value] of (Array.isArray(raw.headers) ? raw.headers : Object.entries(raw.headers))) {
        this.headers[name.toLowerCase()] = value;
      }
    }
    const body = raw.body instanceof Uint8Array ? raw.body : new Uint8Array(raw.body ?? 0);
    this._rawBody = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  } else {
    this.socket = rawOrSocket || makeSocket();
    this.connection = this.socket;
    this.method = "GET";
    this.url = "/";
    this.httpVersion = "1.1";
    this.complete = false;
    this.readable = true;
    this.headers = {};
    this._rawBody = Buffer.alloc(0);
  }
  this._encoding = null;
  this.destroyed = false;
  this._bodyEmitted = false;
  this._emitScheduled = false;
}
Object.setPrototypeOf(IncomingMessage.prototype, EventEmitter.prototype);
Object.assign(IncomingMessage.prototype, {
  setEncoding(enc) {
    this._encoding = enc;
    return this;
  },

  pause() {
    return this;
  },

  pipe(dest, options) {
    this.on("data", (chunk) => dest.write(chunk));
    this.on("end", () => dest.end());
    return dest;
  },

  unpipe() {
    return this;
  },

  destroy(err) {
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
    return this;
  },

  on(type, listener) {
    EventEmitter.prototype.on.call(this, type, listener);
    if (type === "data") this._maybeEmitBody();
    return this;
  },

  resume() {
    this._maybeEmitBody();
    return this;
  },

  read() {
    if (this._bodyEmitted) return null;
    this._bodyEmitted = true;
    queueMicrotask(() => this._emitEnd());
    return this._encoding ? this._rawBody.toString(this._encoding) : this._rawBody;
  },

  _emitEnd() {
    this.complete = true;
    this.readable = false;
    this.emit("end");
  },

  _maybeEmitBody() {
    if (this._bodyEmitted || this._emitScheduled) return;
    if (this.listenerCount("data") === 0) return;
    this._emitScheduled = true;
    queueMicrotask(() => {
      if (this._bodyEmitted) return;
      this._bodyEmitted = true;
      if (this._rawBody.length > 0) {
        const chunk = this._encoding ? this._rawBody.toString(this._encoding) : this._rawBody;
        this.emit("data", chunk);
      }
      this._emitEnd();
    });
  }
});

function toChunkBytes(chunk, encoding) {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  return chunk;
}

function ServerResponse(reqOrListenerId, reqId) {
  EventEmitter.call(this);
  if (typeof reqOrListenerId === "number" || typeof reqOrListenerId === "bigint" || typeof reqOrListenerId === "string") {
    this._listenerId = reqOrListenerId;
    this._reqId = reqId;
  } else {
    this.req = reqOrListenerId;
    this._listenerId = null;
    this._reqId = null;
  }
  this._started = false;
  this._ended = false;
  this._headers = {};
  this.statusCode = 200;
  this.statusMessage = "OK";
  this.socket = makeSocket();
  this.connection = this.socket;
}
Object.setPrototypeOf(ServerResponse.prototype, EventEmitter.prototype);
Object.defineProperties(ServerResponse.prototype, {
  headersSent: {
    get() {
      return this._started;
    },
    configurable: true,
  },
  finished: {
    get() {
      return this._ended;
    },
    configurable: true,
  }
});
Object.assign(ServerResponse.prototype, {
  setHeader(name, value) {
    this._headers[String(name).toLowerCase()] = String(value);
    return this;
  },

  getHeader(name) {
    return this._headers[String(name).toLowerCase()];
  },

  getHeaders() {
    return { ...this._headers };
  },

  getHeaderNames() {
    return Object.keys(this._headers);
  },

  hasHeader(name) {
    return Object.prototype.hasOwnProperty.call(this._headers, String(name).toLowerCase());
  },

  removeHeader(name) {
    delete this._headers[String(name).toLowerCase()];
    return this;
  },

  writeHead(statusCode, reasonOrHeaders, maybeHeaders) {
    this.statusCode = statusCode;
    let headers = maybeHeaders;
    if (typeof reasonOrHeaders === "string") {
      this.statusMessage = reasonOrHeaders;
    } else if (reasonOrHeaders && typeof reasonOrHeaders === "object") {
      headers = reasonOrHeaders;
    }
    if (headers) {
      if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i += 2) {
          this.setHeader(headers[i], headers[i + 1]);
        }
      } else {
        for (const name of Object.keys(headers)) this.setHeader(name, headers[name]);
      }
    }
    return this;
  },

  assignSocket(socket) {
    this.socket = socket;
    this.connection = socket;
    this.emit("socket", socket);
  },

  detachSocket() {},

  flushHeaders() {},

  _headerPairs() {
    return Object.entries(this._headers)
      .map(([name, value]) => name + ": " + value)
      .join("\r\n");
  },

  write(chunk, encoding, cb) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = "utf8";
    }
    if (this._ended) {
      const err = new Error("write after end");
      if (cb) queueMicrotask(() => cb(err));
      else this.emit("error", err);
      return false;
    }
    if (!this._started) {
      this._started = true;
      if (this._listenerId !== null && this._reqId !== null) {
        ops.op_serve_respond_start(this._listenerId, this._reqId, this.statusCode, this._headerPairs());
      }
    }
    if (this._reqId !== null) {
      ops.op_serve_respond_chunk(this._reqId, toChunkBytes(chunk, encoding));
    }
    if (cb) cb();
    return true;
  },

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = "utf8";
    }
    if (this._ended) {
      if (cb) queueMicrotask(cb);
      return this;
    }
    if (!this._started) {
      const body = chunk === undefined || chunk === null
        ? new Uint8Array(0)
        : toChunkBytes(chunk, encoding);
      this._started = true;
      if (this._listenerId !== null && this._reqId !== null) {
        ops.op_serve_respond(this._listenerId, this._reqId, this.statusCode, this._headerPairs(), body);
      }
    } else {
      if (chunk !== undefined && chunk !== null && this._reqId !== null) {
        ops.op_serve_respond_chunk(this._reqId, toChunkBytes(chunk, encoding));
      }
      if (this._reqId !== null) {
        ops.op_serve_respond_end(this._reqId);
      }
    }
    this._ended = true;
    if (cb) cb();
    this.emit("finish");
    return this;
  },
});

class Server extends EventEmitter {
  #listenerId = null;
  #port = 0;
  #httpReqCount = 0;
  _tls; // set by node:https subclass


  constructor(requestListener) {
    super();
    if (requestListener) this.on("request", requestListener);
  }

  listen(port, hostname, cb) {
    if (typeof port === "function") {
      cb = port;
      port = undefined;
      hostname = undefined;
    } else if (typeof hostname === "function") {
      cb = hostname;
      hostname = undefined;
    }
    if (port === undefined) {
      const envPort = globalThis.process?.env?.PORT ? Number(globalThis.process.env.PORT) : NaN;
      port = !isNaN(envPort) && envPort >= 0 ? envPort : 0;
    }
    const [id, boundPort] = ops.op_serve_listen(hostname ?? "0.0.0.0", port, this._tls);
    this.#listenerId = id;
    this.#port = boundPort;
    if (cb) this.once("listening", cb);
    queueMicrotask(() => {
      this.emit("listening");
      if (globalThis.process?.send && globalThis.process?.env?.NODE_UNIQUE_ID) {
        globalThis.process.send({
          cmd: "NODE_CLUSTER",
          act: "listening",
          address: hostname ?? "0.0.0.0",
          port: boundPort,
        });
      }
    });
    this.#pump();
    return this;
  }

  async #pump() {
    for (;;) {
      const blob = await ops.op_serve_pull(this.#listenerId, 64);
      if (blob.length === 0) break;
      for (const raw of __jse.unpackServeRequests(blob)) {
        this.#httpReqCount++;
        if (this.#httpReqCount % 500 === 0 && globalThis.jse?.optimizer) {
          globalThis.jse.optimizer.optimize();
        }

        try {
          const req = new IncomingMessage(raw);
          const res = new ServerResponse(this.#listenerId, raw.id);
          this.emit("request", req, res);
        } catch (err) {
          ops.op_log(3, "node:http", `Uncaught error in request listener for ${raw.method} ${raw.url}: ${err?.stack || err}`);
          try {
            ops.op_serve_respond(this.#listenerId, raw.id, 500, "content-type: text/plain\r\n", new TextEncoder().encode("Internal Server Error\n"));
          } catch (_) {}
        }
      }
    }
  }


  timeout = 0;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  maxHeadersCount = null;
  maxRequestsPerSocket = 0;

  setTimeout(msecs, cb) {
    this.timeout = msecs;
    if (cb) this.on("timeout", cb);
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  closeAllConnections() {
    return this;
  }

  closeIdleConnections() {
    return this;
  }

  address() {
    return { address: "0.0.0.0", family: "IPv4", port: this.#port };
  }

  close(cb) {
    if (this.#listenerId !== null) {
      ops.op_serve_close(this.#listenerId);
      this.#listenerId = null;
    }
    if (cb) queueMicrotask(cb);
    return this;
  }
}

function createServer(requestListener) {
  return new Server(requestListener);
}

class ClientResponse extends EventEmitter {
  constructor(statusCode, statusMessage, headers) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    this.httpVersion = "1.1";
    this.complete = false;
  }
}

function parseHead(text) {
  const lines = text.split("\r\n");
  const match = /HTTP\/\d\.\d (\d{3})(?: (.*))?/.exec(lines[0] || "");
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = headers[name] === undefined ? value : headers[name] + ", " + value;
  }
  return {
    statusCode: match ? Number(match[1]) : 0,
    statusMessage: match ? match[2] || "" : "",
    headers,
  };
}

// Reads a response off `sock`. Calls onResponse once headers are in, then
// emits data/end. Destroys the socket when the body is finished so a pending
// read cannot pin the event loop.
function readResponse(sock, method, onResponse, onError) {
  let buf = Buffer.alloc(0);
  let res = null;
  let mode = null;
  let expected = 0;
  let received = 0;
  let pending = Buffer.alloc(0);
  let failed = false;

  const fail = (err) => {
    if (failed || (res && res.complete)) return;
    failed = true;
    onError(err);
    sock.destroy();
  };

  const finish = () => {
    if (!res || res.complete) return;
    res.complete = true;
    res.emit("end");
    sock.destroy();
  };

  const pushBody = (chunk) => {
    if (!res || res.complete) return;
    if (mode === "none") {
      finish();
      return;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (mode === "chunked") {
      for (;;) {
        const nl = pending.indexOf("\r\n");
        if (nl < 0) return;
        const size = parseInt(pending.subarray(0, nl).toString("latin1"), 16);
        if (!Number.isFinite(size)) {
          fail(new Error("invalid chunk size"));
          return;
        }
        if (pending.length < nl + 2 + size + 2) return;
        const data = pending.subarray(nl + 2, nl + 2 + size);
        pending = pending.subarray(nl + 2 + size + 2);
        if (size === 0) {
          finish();
          return;
        }
        if (data.length) res.emit("data", data);
      }
    }
    if (mode === "length") {
      const take = Math.min(pending.length, expected - received);
      if (take > 0) {
        res.emit("data", pending.subarray(0, take));
        received += take;
        pending = pending.subarray(take);
      }
      if (received >= expected) finish();
      return;
    }
    if (pending.length) {
      res.emit("data", pending);
      pending = Buffer.alloc(0);
    }
  };

  sock.on("error", (err) => {
    if (res && res.complete) return;
    fail(err);
  });
  sock.on("end", () => {
    if (!res || ((mode === "length" || mode === "chunked") && !res.complete)) {
      fail(new Error("socket hang up"));
      return;
    }
    finish();
  });
  sock.on("data", (chunk) => {
    if (failed || (res && res.complete)) return;
    if (!res) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const parsed = parseHead(buf.subarray(0, idx).toString("latin1"));
      const rest = buf.subarray(idx + 4);
      buf = Buffer.alloc(0);
      res = new ClientResponse(parsed.statusCode, parsed.statusMessage, parsed.headers);
      const noBody = method === "HEAD" || parsed.statusCode === 204 || parsed.statusCode === 304;
      if (noBody) mode = "none";
      else if ((parsed.headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) mode = "chunked";
      else if (parsed.headers["content-length"] !== undefined) {
        mode = "length";
        expected = Number(parsed.headers["content-length"]) || 0;
      } else mode = "eof";
      onResponse(res);
      if (rest.length) pushBody(rest);
      else if (mode === "none" || (mode === "length" && expected === 0)) finish();
      return;
    }
    pushBody(chunk);
  });
}

function normalizeRequest(input, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  let opts = {};
  if (typeof input === "string" || input instanceof URL) {
    const url = input instanceof URL ? input : new URL(input);
    opts.protocol = url.protocol;
    opts.hostname = url.hostname;
    opts.port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    opts.path = url.pathname + url.search;
    opts.method = "GET";
    opts.tls = url.protocol === "https:";
    if (url.username || url.password) {
      opts.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    }
  } else {
    opts = { ...input };
    if (typeof input === "object" && input !== null) cb = cb;
  }
  if (options && typeof options === "object") Object.assign(opts, options);
  opts.hostname = opts.hostname || opts.host || "localhost";
  if (!opts.port) opts.port = opts.tls || opts.protocol === "https:" ? 443 : 80;
  opts.method = String(opts.method || "GET").toUpperCase();
  opts.path = opts.path || "/";
  opts.headers = opts.headers || {};
  return { opts, cb };
}

// Header names are tokens; values and the request line must not contain
// CR/LF/NUL, which would let a caller inject headers or a second request.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const INVALID_VALUE_RE = /[\r\n\0]/;

function httpError(code, message) {
  const err = new TypeError(message);
  err.code = code;
  return err;
}

function validateHeader(name, value) {
  if (!TOKEN_RE.test(name)) {
    throw httpError("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token ["${name}"]`);
  }
  if (value === undefined) {
    throw httpError("ERR_HTTP_INVALID_HEADER_VALUE", `Invalid value "undefined" for header "${name}"`);
  }
  for (const v of Array.isArray(value) ? value : [value]) {
    if (INVALID_VALUE_RE.test(String(v))) {
      throw httpError("ERR_INVALID_CHAR", `Invalid character in header content ["${name}"]`);
    }
  }
}

class ClientRequest extends Writable {
  constructor(opts, cb) {
    // Finishing the request body must not destroy the request (and with it
    // the socket still waiting for the response).
    super({ autoDestroy: false });
    if (!TOKEN_RE.test(opts.method)) {
      throw httpError("ERR_INVALID_HTTP_TOKEN", `Method must be a valid HTTP token ["${opts.method}"]`);
    }
    if (/[\s\0]/.test(opts.path)) {
      throw httpError("ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters");
    }
    this._opts = opts;
    this._chunks = [];
    // lowercase name -> [original name, value]
    this._headers = new Map();
    for (const name of Object.keys(opts.headers)) this.setHeader(name, opts.headers[name]);
    if (opts.auth && !this._headers.has("authorization")) {
      this.setHeader("Authorization", "Basic " + Buffer.from(opts.auth).toString("base64"));
    }
    this.method = opts.method;
    this.path = opts.path;
    if (typeof cb === "function") this.once("response", cb);
    if (opts.timeout) this.setTimeout(opts.timeout);
  }

  setHeader(name, value) {
    validateHeader(name, value);
    this._headers.set(name.toLowerCase(), [name, value]);
    return this;
  }

  getHeader(name) {
    return this._headers.get(String(name).toLowerCase())?.[1];
  }

  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }

  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
  }

  getHeaders() {
    const out = {};
    for (const [key, [, value]] of this._headers) out[key] = value;
    return out;
  }

  getHeaderNames() {
    return [...this._headers.keys()];
  }

  // Emits "timeout" if no response has arrived after `ms`; like Node, the
  // request is only aborted if a listener calls destroy()/abort().
  setTimeout(ms, cb) {
    if (typeof cb === "function") this.once("timeout", cb);
    clearTimeout(this._timer);
    if (ms > 0) {
      this._timer = setTimeout(() => this.emit("timeout"), ms);
      this.once("response", () => clearTimeout(this._timer));
      this.once("close", () => clearTimeout(this._timer));
    }
    return this;
  }

  abort() {
    this.aborted = true;
    this.emit("abort");
    this.destroy();
  }

  destroy(err) {
    clearTimeout(this._timer);
    this._sock?.destroy();
    return super.destroy(err);
  }

  flushHeaders() {}
  setNoDelay() {}
  setSocketKeepAlive() {}

  _write(chunk, encoding, cb) {
    this._chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding ?? "utf8") : Buffer.from(chunk));
    cb();
  }

  _final(cb) {
    const opts = this._opts;
    const payload = Buffer.concat(this._chunks);
    const defaultPort = opts.tls ? 443 : 80;
    if (!this.hasHeader("host")) {
      const host = opts.hostname.includes(":") ? `[${opts.hostname}]` : opts.hostname;
      this.setHeader("Host", Number(opts.port) === defaultPort ? host : `${host}:${opts.port}`);
    }
    this.removeHeader("transfer-encoding");
    this.setHeader("Content-Length", String(payload.length));
    if (!this.hasHeader("connection")) this.setHeader("Connection", "close");
    let head = `${opts.method} ${opts.path} HTTP/1.1\r\n`;
    for (const [name, value] of this._headers.values()) {
      for (const v of Array.isArray(value) ? value : [value]) head += `${name}: ${v}\r\n`;
    }
    head += "\r\n";
    const bytes = Buffer.concat([Buffer.from(head), payload]);
    const sock = this._sock = net.connect({
      host: opts.hostname,
      port: opts.port,
      tls: !!opts.tls,
      servername: opts.servername || opts.hostname,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    });
    let settled = false;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      cb(err);
    };
    sock.on("error", (err) => {
      if (settled) return;
      settled = true;
      this.emit("error", err);
      finish(err);
    });
    sock.on("connect", () => {
      readResponse(
        sock,
        opts.method,
        (res) => {
          settled = true;
          this.emit("response", res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          this.emit("error", err);
          finish(err);
        },
      );
      // Content-Length ends the request. Shutting the write side down here
      // (socket.end) sends a FIN while the server is still answering, and
      // the response is dropped.
      sock.write(bytes, (err) => {
        if (err) {
          if (!settled) {
            settled = true;
            this.emit("error", err);
          }
          finish(err);
          sock.destroy(err);
          return;
        }
        finish();
      });
    });
  }
}

function request(input, options, cb) {
  const norm = normalizeRequest(input, options, cb);
  return new ClientRequest(norm.opts, norm.cb);
}

function get(input, options, cb) {
  const req = request(input, options, cb);
  req.end();
  return req;
}

// The standard HTTP method list (from http.METHODS).
export const METHODS = [
  "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK",
  "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE",
  "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT",
  "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND",
  "UNLINK", "LOCK", "UNSUBSCRIBE",
];

export { createServer, Server, IncomingMessage, ServerResponse, request, get, ClientRequest };
export default { createServer, Server, IncomingMessage, ServerResponse, request, get, ClientRequest, METHODS };
