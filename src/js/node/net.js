// node:net — TCP sockets and servers, plus the IP helpers.
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

const ops = Deno.core.ops;

function isIPv4(input) {
  if (typeof input !== "string") return false;
  const parts = input.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return false;
    if (part.length > 1 && part[0] === "0") return false;
    return Number(part) <= 255;
  });
}

const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(([0-9a-fA-F]{1,4}:){1,7}|:)::(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?|::(ffff:)?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

function isIPv6(input) {
  if (typeof input !== "string") return false;
  return IPV6_RE.test(input);
}

function isIP(input) {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(chunk, encoding) {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(chunk ?? []);
}

// Like Node: a non-numeric string is a Unix socket or Windows pipe path.
function isPipePath(value) {
  return typeof value === "string" && value !== "" && !/^\d+$/.test(value);
}

function Socket(options = {}) {
  Duplex.call(this, options);
  this.connecting = false;
  this.destroyed = false;
  this.readable = true;
  this.writable = true;
  this.readyState = "closed";
  this.bytesRead = 0;
  this.bytesWritten = 0;
  this.bufferSize = 0;
  this._id = null;
  this._reading = false;
  this.allowHalfOpen = !!options.allowHalfOpen;
  this._tls = !!options.tls;
  this._rejectUnauthorized = options.rejectUnauthorized !== false;
  this.remoteAddress = null;
  this.remotePort = null;
  this.localAddress = null;
  this.localPort = null;
}
Socket.prototype = Object.create(Duplex.prototype);
Socket.prototype.constructor = Socket;

Socket.prototype._onConnect = function (info) {
  this._id = info.id;
  this.remoteAddress = info.remote_address;
  this.remotePort = info.remote_port;
  this.localAddress = info.local_address;
  this.localPort = info.local_port;
  this.connecting = false;
  this.readyState = "open";
  this.emit("connect");
  if (this.readableFlowing) this._read();
};

Socket.prototype.connect = function (port, host, cb) {
  let opts;
  if (isPipePath(port)) {
    opts = { path: port };
    cb = typeof host === "function" ? host : cb;
  } else if (typeof port === "object" && port !== null) {
    opts = port;
    cb = host;
  } else {
    if (typeof host === "function") {
      cb = host;
      host = "localhost";
    }
    opts = { port, host: host || "localhost" };
  }
  if (opts.path) {
    const path = String(opts.path);
    this.connecting = true;
    this.readyState = "opening";
    if (typeof cb === "function") this.once("connect", cb);
    ops.op_net_connect(path, 0).then(
      (info) => {
        if (this.destroyed) {
          ops.op_net_close(info.id);
          return;
        }
        this._onConnect(info);
      },
      (err) => this.destroy(err),
    );
    return this;
  }
  const hostname = opts.host || opts.hostname || "localhost";
  const tls = !!(opts.tls ?? this._tls);
  // Node accepts numeric strings ("5432") as ports.
  const portNum = Number(opts.port ?? (tls ? 443 : 0));
  if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) {
    const err = new RangeError(`Port should be >= 0 and < 65536. Received ${opts.port}.`);
    err.code = "ERR_SOCKET_BAD_PORT";
    throw err;
  }
  const servername = opts.servername || hostname;
  const insecure = (opts.rejectUnauthorized ?? this._rejectUnauthorized) === false;
  this.connecting = true;
  this.readyState = "opening";
  this._tls = tls;
  if (typeof cb === "function") this.once("connect", cb);
  const pending = tls
    ? ops.op_tls_connect(String(hostname), portNum, String(servername), insecure)
    : ops.op_net_connect(String(hostname), portNum);
  pending.then(
    (info) => {
      if (this.destroyed) {
        ops.op_net_close(info.id);
        return;
      }
      this._onConnect(info);
    },
    (err) => this.destroy(err),
  );
  return this;
};

// One in-flight read. The stream pump re-enters _read; don't chain it here.
Socket.prototype._read = function () {
  if (this._reading || this.destroyed) return;
  if (this._id === null) {
    this.once("connect", () => this._read());
    return;
  }
  this._reading = true;
  const id = this._id;
  ops.op_net_read(id).then(
    (chunk) => {
      this._reading = false;
      if (this.destroyed) return;
      if (!chunk || chunk.byteLength === 0) {
        this.push(null);
        // Node's default: the readable FIN closes the writable side too, so
        // a finished echo socket does not pin the event loop.
        if (!this.allowHalfOpen && !this.writableEnded) this.end();
        return;
      }
      this.bytesRead += chunk.byteLength;
      this.push(asBuffer(chunk));
    },
    (err) => {
      this._reading = false;
      if (this.destroyed) return;
      this.destroy(err);
    },
  );
};

Socket.prototype._write = function (chunk, encoding, cb) {
  const bytes = toBytes(chunk, encoding);
  const go = () => {
    this.bytesWritten += bytes.byteLength;
    ops.op_net_write(this._id, bytes).then(() => cb(), cb);
  };
  if (this._id === null) this.once("connect", go);
  else go();
};

Socket.prototype._final = function (cb) {
  if (this.readyState === "open") {
    this.readyState = "readOnly";
  }
  if (this._id === null) {
    cb();
    return;
  }
  ops.op_net_shutdown(this._id).then(() => cb(), cb);
};

// Stream destroy() hook: release the socket, then let the stream machinery
// emit 'error'/'close'.
Socket.prototype._destroy = function (err, cb) {
  this.readyState = "closed";
  if (this._timeoutId) {
    clearTimeout(this._timeoutId);
    this._timeoutId = null;
  }
  if (this._id !== null) {
    ops.op_net_close(this._id);
    this._id = null;
  }
  cb(err);
};

Socket.prototype.address = function () {
  return {
    port: this.localPort || 0,
    family: this.localAddress?.includes(":") ? "IPv6" : "IPv4",
    address: this.localAddress || "127.0.0.1",
  };
};

Socket.prototype.setNoDelay = function () {
  return this;
};
Socket.prototype.setKeepAlive = function () {
  return this;
};
Socket.prototype.setTimeout = function (msecs, cb) {
  if (typeof cb === "function") this.once("timeout", cb);
  if (this._timeoutId) clearTimeout(this._timeoutId);
  if (msecs > 0) {
    this._timeoutId = setTimeout(() => {
      this.emit("timeout");
    }, msecs);
    if (typeof this._timeoutId?.unref === "function") this._timeoutId.unref();
  }
  return this;
};
Socket.prototype.ref = function () {
  return this;
};
Socket.prototype.unref = function () {
  return this;
};

function attachAccepted(sock, info) {
  sock._id = info.id;
  sock.readyState = "open";
  sock.remoteAddress = info.remote_address;
  sock.remotePort = info.remote_port;
  sock.localAddress = info.local_address;
  sock.localPort = info.local_port;
  return sock;
}

function Server(options, listener) {
  EventEmitter.call(this);
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  this._options = options ?? {};
  this._id = null;
  this._port = 0;
  this._host = "0.0.0.0";
  this.listening = false;
  if (typeof listener === "function") this.on("connection", listener);
}
Server.prototype = Object.create(EventEmitter.prototype);
Server.prototype.constructor = Server;

Server.prototype.listen = function (port, host, backlog, cb) {
  let listenPath = null;
  if (isPipePath(port)) {
    listenPath = port;
    cb = typeof host === "function" ? host : cb;
  } else if (typeof port === "object" && port !== null && port.path) {
    listenPath = port.path;
    cb = typeof host === "function" ? host : cb;
  }

  if (listenPath) {
    // Bare Unix socket names are relative to the cwd, as in Node.
    listenPath = String(listenPath);
    if (process.platform !== "win32" && !/^[/.]/.test(listenPath)) listenPath = `./${listenPath}`;
    ops.op_net_listen(listenPath, 0).then(
      (info) => {
        this._id = info.id;
        this._port = 0;
        this._host = info.host;
        this.listening = true;
        if (typeof cb === "function") this.once("listening", cb);
        this.emit("listening");
        this._accept();
      },
      (err) => this.emit("error", err),
    );
    return this;
  }

  if (typeof port === "function") {
    cb = port;
    port = 0;
    host = "0.0.0.0";
  } else if (typeof port === "object" && port !== null) {
    cb = typeof host === "function" ? host : undefined;
    host = port.host || port.hostname || "0.0.0.0";
    port = port.port ?? 0;
  } else {
    if (typeof host === "function") {
      cb = host;
      host = "0.0.0.0";
    } else if (typeof backlog === "function") {
      cb = backlog;
    }
    if (host === undefined) host = "0.0.0.0";
    if (port === undefined) port = 0;
  }
  ops.op_net_listen(String(host), port).then(
    (info) => {
      this._id = info.id;
      this._port = info.port;
      this._host = info.host;
      this.listening = true;
      if (typeof cb === "function") this.once("listening", cb);
      this.emit("listening");
      if (globalThis.process?.send && globalThis.process?.env?.NODE_UNIQUE_ID) {
        globalThis.process.send({
          cmd: "NODE_CLUSTER",
          act: "listening",
          address: info.host,
          port: info.port,
        });
      }
      this._accept();
    },
    (err) => this.emit("error", err),
  );
  return this;
};

Server.prototype._accept = async function () {
  const id = this._id;
  while (this._id !== null) {
    let info;
    try {
      info = await ops.op_net_accept(id);
    } catch (err) {
      if (this._id !== null) this.emit("error", err);
      break;
    }
    if (!info) break;
    const sock = attachAccepted(new Socket({ allowHalfOpen: !!this._options.allowHalfOpen }), info);
    this.emit("connection", sock);
  }
};

Server.prototype.address = function () {
  if (!this.listening) return null;
  return { address: this._host, family: "IPv4", port: this._port };
};

Server.prototype.close = function (cb) {
  if (this._id !== null) {
    ops.op_net_close_server(this._id);
    this._id = null;
  }
  this.listening = false;
  if (typeof cb === "function") this.once("close", cb);
  queueMicrotask(() => this.emit("close"));
  return this;
};

Server.prototype.ref = function () {
  return this;
};
Server.prototype.unref = function () {
  return this;
};

function createServer(options, listener) {
  return new Server(options, listener);
}

function connect(...args) {
  const sock = new Socket();
  return sock.connect(...args);
}

const createConnection = connect;

class SocketAddress {
  constructor(options = {}) {
    this.address = options.address || "127.0.0.1";
    this.family = options.family || (isIPv6(this.address) ? "ipv6" : "ipv4");
    this.port = options.port || 0;
    this.flowlabel = options.flowlabel || 0;
  }
}

class BlockList {
  constructor() {
    this._rules = [];
  }
  addAddress(address, type = "ipv4") {
    this._rules.push({ type: "address", address, family: type });
  }
  addRange(start, end, type = "ipv4") {
    this._rules.push({ type: "range", start, end, family: type });
  }
  addSubnet(net, prefix, type = "ipv4") {
    this._rules.push({ type: "subnet", net, prefix, family: type });
  }
  check(address, type = "ipv4") {
    return this._rules.some((r) => r.address === address);
  }
}

export {
  isIP,
  isIPv4,
  isIPv6,
  Socket,
  Server,
  createServer,
  connect,
  createConnection,
  SocketAddress,
  BlockList,
};
export default {
  isIP,
  isIPv4,
  isIPv6,
  Socket,
  Server,
  createServer,
  connect,
  createConnection,
  SocketAddress,
  BlockList,
};

