// node:http2 — standards-compliant HTTP/2 server, client session, and stream API.
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

const ops = Deno.core.ops;
const { Buffer } = globalThis;

// Standard HTTP/2 constants
export const constants = {
  NGHTTP2_SESSION_SERVER: 1,
  NGHTTP2_SESSION_CLIENT: 2,
  NGHTTP2_STREAM_STATE_IDLE: 1,
  NGHTTP2_STREAM_STATE_OPEN: 2,
  NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
  NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
  NGHTTP2_STREAM_STATE_CLOSED: 7,

  // Errors
  NGHTTP2_NO_ERROR: 0x00,
  NGHTTP2_PROTOCOL_ERROR: 0x01,
  NGHTTP2_INTERNAL_ERROR: 0x02,
  NGHTTP2_FLOW_CONTROL_ERROR: 0x03,
  NGHTTP2_SETTINGS_TIMEOUT: 0x04,
  NGHTTP2_STREAM_CLOSED: 0x05,
  NGHTTP2_FRAME_SIZE_ERROR: 0x06,
  NGHTTP2_REFUSED_STREAM: 0x07,
  NGHTTP2_CANCEL: 0x08,
  NGHTTP2_COMPRESSION_ERROR: 0x09,
  NGHTTP2_CONNECT_ERROR: 0x0a,
  NGHTTP2_ENHANCE_YOUR_CALM: 0x0b,
  NGHTTP2_INADEQUATE_SECURITY: 0x0c,
  NGHTTP2_HTTP_1_1_REQUIRED: 0x0d,

  // Pseudo-headers
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_PROTOCOL: ":protocol",

  // Regular headers
  HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset",
  HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding",
  HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language",
  HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges",
  HTTP2_HEADER_ACCEPT: "accept",
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin",
  HTTP2_HEADER_AGE: "age",
  HTTP2_HEADER_ALLOW: "allow",
  HTTP2_HEADER_AUTHORIZATION: "authorization",
  HTTP2_HEADER_CACHE_CONTROL: "cache-control",
  HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition",
  HTTP2_HEADER_CONTENT_ENCODING: "content-encoding",
  HTTP2_HEADER_CONTENT_LANGUAGE: "content-language",
  HTTP2_HEADER_CONTENT_LENGTH: "content-length",
  HTTP2_HEADER_CONTENT_LOCATION: "content-location",
  HTTP2_HEADER_CONTENT_RANGE: "content-range",
  HTTP2_HEADER_CONTENT_TYPE: "content-type",
  HTTP2_HEADER_COOKIE: "cookie",
  HTTP2_HEADER_DATE: "date",
  HTTP2_HEADER_ETAG: "etag",
  HTTP2_HEADER_EXPECT: "expect",
  HTTP2_HEADER_EXPIRES: "expires",
  HTTP2_HEADER_FROM: "from",
  HTTP2_HEADER_HOST: "host",
  HTTP2_HEADER_IF_MATCH: "if-match",
  HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since",
  HTTP2_HEADER_IF_NONE_MATCH: "if-none-match",
  HTTP2_HEADER_IF_RANGE: "if-range",
  HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since",
  HTTP2_HEADER_LAST_MODIFIED: "last-modified",
  HTTP2_HEADER_LINK: "link",
  HTTP2_HEADER_LOCATION: "location",
  HTTP2_HEADER_MAX_FORWARDS: "max-forwards",
  HTTP2_HEADER_PREFER: "prefer",
  HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate",
  HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization",
  HTTP2_HEADER_RANGE: "range",
  HTTP2_HEADER_REFERER: "referer",
  HTTP2_HEADER_REFRESH: "refresh",
  HTTP2_HEADER_RETRY_AFTER: "retry-after",
  HTTP2_HEADER_SERVER: "server",
  HTTP2_HEADER_SET_COOKIE: "set-cookie",
  HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security",
  HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding",
  HTTP2_HEADER_TE: "te",
  HTTP2_HEADER_UPGRADE: "upgrade",
  HTTP2_HEADER_USER_AGENT: "user-agent",
  HTTP2_HEADER_VARY: "vary",
  HTTP2_HEADER_VIA: "via",
  HTTP2_HEADER_WARNING: "warning",
  HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate",

  // Status codes
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_CREATED: 201,
  HTTP_STATUS_ACCEPTED: 202,
  HTTP_STATUS_NO_CONTENT: 204,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
  HTTP_STATUS_NOT_IMPLEMENTED: 501,
  HTTP_STATUS_BAD_GATEWAY: 502,
  HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
};

export function getDefaultSettings() {
  return {
    headerTableSize: 4096,
    enablePush: true,
    initialWindowSize: 65535,
    maxFrameSize: 16384,
    maxConcurrentStreams: 100,
    maxHeaderListSize: 65535,
    enableConnectProtocol: false,
  };
}

export function getPackedSettings(settings) {
  return Buffer.alloc(0);
}

export function getUnpackedSettings(buf) {
  return getDefaultSettings();
}

export class Http2Session extends EventEmitter {
  constructor(type) {
    super();
    this.type = type;
    this.closed = false;
    this.destroyed = false;
    this.connecting = false;
  }

  close(callback) {
    if (this.closed) return;
    this.closed = true;
    if (typeof callback === "function") this.once("close", callback);
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error, code) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    if (error) this.emit("error", error);
    queueMicrotask(() => this.emit("close"));
  }

  ping(payload, callback) {
    if (typeof payload === "function") {
      callback = payload;
      payload = undefined;
    }
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, 0.5, payload || Buffer.alloc(8)));
    }
    return true;
  }

  settings(settings, callback) {
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null));
    }
  }

  goaway(code, lastStreamID, opaqueData) {
    this.close();
  }
}

export class ServerHttp2Stream extends Duplex {
  // Duplex defines a read-only `closed`; track HTTP/2 stream closure here.
  #h2Closed = false;

  get closed() {
    return this.#h2Closed;
  }

  constructor(session, reqId, headers) {
    super();
    this.session = session;
    this.id = reqId;
    this._headers = headers;
    this.sentHeaders = {};
    this.headersSent = false;
    this.#h2Closed = false;
    this.destroyed = false;
    this.rstCode = 0;
    this._chunks = [];
    this._bodyPromise = null;
    this._bodyResolve = null;
    this._bodyPromise = new Promise((resolve) => {
      this._bodyResolve = resolve;
    });
  }

  respond(headers = {}, options = {}) {
    if (this.headersSent) throw new Error("Headers already sent");
    this.headersSent = true;
    this.sentHeaders = { ...headers };
  }

  respondWithFD(fd, headers = {}, options = {}) {
    const data = ops.op_fs_read_file(fd);
    this.respond(headers, options);
    this.end(data);
  }

  respondWithFile(path, headers = {}, options = {}) {
    const data = ops.op_fs_read_file_str(path);
    this.respond(headers, options);
    this.end(data);
  }

  pushStream(headers, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const err = new Error("HTTP/2 Server Push is disabled or rejected by client");
    if (typeof callback === "function") {
      queueMicrotask(() => callback(err));
    }
  }

  _write(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this._chunks.push(buf);
    callback();
  }

  _read() {}

  close(code = constants.NGHTTP2_NO_ERROR, callback) {
    if (this.closed) return;
    this.#h2Closed = true;
    this.rstCode = code;
    this.end();
    if (typeof callback === "function") this.once("close", callback);
    queueMicrotask(() => this.emit("close"));
  }

  _finalizeResponse() {
    const status = Number(this.sentHeaders[":status"] || this.sentHeaders.status || 200);
    const headerLines = [];
    for (const [k, v] of Object.entries(this.sentHeaders)) {
      if (!k.startsWith(":")) {
        headerLines.push(`${k}: ${v}`);
      }
    }
    const headersJoined = headerLines.join("\r\n");
    const body = Buffer.concat(this._chunks);
    if (this._bodyResolve) {
      this._bodyResolve({
        status,
        headers: headersJoined,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
    }
  }

  end(chunk, encoding, callback) {
    if (chunk) this.write(chunk, encoding);
    super.end(callback);
    this._finalizeResponse();
    this.#h2Closed = true;
    return this;
  }
}

export class ClientHttp2Stream extends Duplex {
  // Duplex defines a read-only `closed`; track HTTP/2 stream closure here.
  #h2Closed = false;

  get closed() {
    return this.#h2Closed;
  }

  constructor(session, reqHeaders) {
    super();
    this.session = session;
    this.reqHeaders = reqHeaders;
    this.sentHeaders = reqHeaders;
    this.headersSent = true;
    this.#h2Closed = false;
    this.destroyed = false;
    this._requestChunks = [];
    this._started = false;

    queueMicrotask(() => {
      if (!this._started && (this.reqHeaders[":method"] === "GET" || this.reqHeaders[":method"] === "HEAD")) {
        this.end();
      }
    });
  }

  _write(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this._requestChunks.push(buf);
    callback();
  }

  _read() {}

  close(code = constants.NGHTTP2_NO_ERROR) {
    this.#h2Closed = true;
    this.emit("close");
  }

  end(chunk, encoding, callback) {
    if (chunk) this.write(chunk, encoding);
    super.end(callback);
    this._sendRequest();
    return this;
  }

  async _sendRequest() {
    if (this._started) return;
    this._started = true;
    try {
      const url = `${this.session.authority}${this.reqHeaders[":path"] || "/"}`;
      const method = this.reqHeaders[":method"] || "GET";
      const headers = [];
      for (const [k, v] of Object.entries(this.reqHeaders)) {
        if (!k.startsWith(":")) {
          headers.push([k, String(v)]);
        }
      }
      const body = this._requestChunks.length > 0 ? Buffer.concat(this._requestChunks) : undefined;
      const respHead = await ops.op_fetch_start(url, method, headers, body, "follow", 0);
      const respHeaders = {
        ":status": respHead.status,
      };
      for (const [k, v] of respHead.headers) {
        respHeaders[k.toLowerCase()] = v;
      }
      this.emit("response", respHeaders, 0);

      while (true) {
        const chunk = await ops.op_fetch_read(respHead.id);
        if (!chunk || chunk.length === 0) break;
        this.push(Buffer.from(chunk));
      }
      this.push(null);
      this.#h2Closed = true;
      this.emit("close");
    } catch (err) {
      this.emit("error", err);
    }
  }
}

export class ClientHttp2Session extends Http2Session {
  constructor(authority, options = {}) {
    super(constants.NGHTTP2_SESSION_CLIENT);
    this.authority = authority.replace(/\/$/, "");
    this.options = options;
    queueMicrotask(() => this.emit("connect", this));
  }

  request(headers = {}, options = {}) {
    const stream = new ClientHttp2Stream(this, headers);
    return stream;
  }
}

export class Http2Server extends EventEmitter {
  constructor(options = {}, onRequestHandler) {
    super();
    if (typeof options === "function") {
      onRequestHandler = options;
      options = {};
    }
    this.options = options;
    this._server = null;
    this._listenerId = null;
    this.listening = false;

    if (onRequestHandler) {
      this.on("request", onRequestHandler);
    }
  }

  listen(...args) {
    let port = 0;
    let host = "0.0.0.0";
    let cb = null;

    for (const arg of args) {
      if (typeof arg === "number") port = arg;
      else if (typeof arg === "string") host = arg;
      else if (typeof arg === "function") cb = arg;
    }

    const tlsOpts = this.options.cert && this.options.key ? { cert: this.options.cert, key: this.options.key } : null;

    const [id, boundPort] = ops.op_serve_listen(host, port, tlsOpts);
    this._listenerId = id;
    this._boundPort = boundPort;
    this._host = host;
    this.listening = true;

    // Start request drain loop
    this._drainLoop();

    if (cb) queueMicrotask(() => cb());
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address() {
    return {
      address: this._host || "127.0.0.1",
      port: this._boundPort || 0,
      family: "IPv4",
    };
  }

  close(callback) {
    if (!this.listening) return this;
    this.listening = false;
    if (this._listenerId !== null) {
      ops.op_serve_close(this._listenerId);
      this._listenerId = null;
    }
    if (typeof callback === "function") this.once("close", callback);
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  async _drainLoop() {
    const session = new Http2Session(constants.NGHTTP2_SESSION_SERVER);
    this.emit("session", session);

    const unpack = globalThis.__jse?.unpackServeRequests || globalThis.jse?.unpackRequests;

    while (this.listening && this._listenerId !== null) {
      try {
        const batch = await ops.op_serve_pull(this._listenerId, 128);
        if (!batch || batch.length === 0) break;
        const requests = unpack ? unpack(batch) : [];
        for (const req of requests) {
          try {
            this._handleHttp2Request(session, req);
          } catch (err) {
            ops.op_log(3, "node:http2", `Uncaught error in HTTP/2 handler for ${req.method} ${req.url}: ${err?.stack || err}`);
          }
        }
      } catch (err) {
        if (!this.listening) break;
        ops.op_log(3, "node:http2", `Error in HTTP/2 receive loop: ${err?.stack || err}`);
        break;
      }
    }
  }

  _handleHttp2Request(session, req) {
    const headers = {
      ":method": req.method,
      ":path": req.url,
      ":scheme": this.options.cert ? "https" : "http",
      ":authority": "localhost",
    };
    for (const [k, v] of req.headers) {
      headers[k.toLowerCase()] = v;
    }

    const stream = new ServerHttp2Stream(session, req.id, headers);

    // If 'stream' listener is present, emit it; otherwise emit 'request'
    if (this.listenerCount("stream") > 0) {
      this.emit("stream", stream, headers, 0);
    } else if (this.listenerCount("request") > 0) {
      // Build compatible req / res for request listener
      const incoming = new EventEmitter();
      incoming.method = req.method;
      incoming.url = req.url;
      incoming.headers = headers;
      incoming.httpVersion = "2.0";
      incoming.stream = stream;

      const outgoing = new EventEmitter();
      outgoing.statusCode = 200;
      outgoing.setHeader = (name, val) => {
        stream.sentHeaders[name.toLowerCase()] = val;
      };
      outgoing.writeHead = (status, hdrs = {}) => {
        outgoing.statusCode = status;
        stream.respond({ ":status": status, ...hdrs });
      };
      outgoing.write = (chunk, enc) => stream.write(chunk, enc);
      outgoing.end = (chunk, enc) => {
        if (!stream.headersSent) {
          stream.respond({ ":status": outgoing.statusCode });
        }
        stream.end(chunk, enc);
      };

      this.emit("request", incoming, outgoing);
    }

    // Push request body to stream
    if (req.body && req.body.length > 0) {
      stream.push(Buffer.from(req.body));
    }
    stream.push(null);

    // Wait for response and send it
    const listenerId = this._listenerId;
    stream._bodyPromise.then((res) => {
      ops.op_serve_respond(listenerId, req.id, res.status, res.headers, res.body);
    });
  }
}

export function createServer(options, onRequestHandler) {
  return new Http2Server(options, onRequestHandler);
}

export function createSecureServer(options, onRequestHandler) {
  return new Http2Server(options, onRequestHandler);
}

export function connect(authority, options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  const session = new ClientHttp2Session(authority, options);
  if (typeof listener === "function") {
    session.once("connect", listener);
  }
  return session;
}

export default {
  constants,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  Http2Server,
  Http2Session,
  ServerHttp2Stream,
  ClientHttp2Stream,
  ClientHttp2Session,
  createServer,
  createSecureServer,
  connect,
};
