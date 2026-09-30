// node:https shim: createServer({ cert, key }) over the same engine as
// node:http (TLS via rustls). PEM may be contents or a filesystem path.
import { Agent as HttpAgent, Server, request as httpRequest } from "node:http";

const ops = Deno.core.ops;

function readPem(value, what) {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new TypeError(`https: ${what} must be a PEM string, Buffer, or a path`);
  }
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  if (text.includes("-----BEGIN")) return text;
  return ops.op_read_text_file_sync(text);
}

class HttpsServer extends Server {
  constructor(options, requestListener) {
    super(requestListener);
    if (options?.cert !== undefined || options?.key !== undefined) {
      this._tls = {
        cert: readPem(options.cert, "cert"),
        key: readPem(options.key, "key"),
      };
    }
  }
}

function createServer(options, requestListener) {
  if (typeof options === "function") {
    requestListener = options;
    options = {};
  }
  return new HttpsServer(options ?? {}, requestListener);
}

function withTls(input, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  if (typeof input === "string" || input instanceof URL) {
    const url = input instanceof URL ? input : new URL(input);
    const opts = {
      protocol: "https:",
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: url.pathname + url.search,
      method: "GET",
      tls: true,
      rejectUnauthorized: true,
      ...(options && typeof options === "object" ? options : {}),
    };
    return { opts, cb };
  }
  const opts = {
    port: 443,
    rejectUnauthorized: true,
    ...(typeof input === "object" && input !== null ? input : {}),
    ...(options && typeof options === "object" ? options : {}),
    tls: true,
  };
  if (!opts.port) opts.port = 443;
  return { opts, cb };
}

function request(input, options, cb) {
  const norm = withTls(input, options, cb);
  return httpRequest(norm.opts, norm.cb);
}

function get(input, options, cb) {
  const req = request(input, options, cb);
  req.end();
  return req;
}

class Agent extends HttpAgent {
  constructor(options) {
    super(options);
    this.defaultPort = 443;
    this.protocol = "https:";
  }
}

const globalAgent = new Agent();

export { createServer, HttpsServer as Server, request, get, Agent, globalAgent };
export default { createServer, Server: HttpsServer, request, get, Agent, globalAgent };
