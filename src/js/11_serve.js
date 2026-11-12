// jse.serve: Deno-style HTTP server over the hyper engine (src/serve.rs).
// handler(req: Request) -> Response (or a promise of one). Responses with
// string/typed-array bodies go out whole; async-iterable bodies stream as
// chunked transfer-encoding.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  const sharedDecoder = new TextDecoder();
  const EMPTY_U8 = new Uint8Array(0);

  // Decode a batch blob from op_serve_pull (see src/serve.rs pack_requests).
  // Headers are parsed lazily -- most handlers only check 1-2 headers,
  // so parsing all of them upfront wastes cycles on the hot path.
  function unpackServeRequests(blob) {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const requests = [];
    let pos = 0;
    const count = view.getUint32(pos, true);
    pos += 4;
    for (let i = 0; i < count; i++) {
      const id = view.getUint32(pos, true);
      pos += 4;
      const methodLen = view.getUint32(pos, true);
      pos += 4;
      const method = sharedDecoder.decode(blob.subarray(pos, pos + methodLen));
      pos += methodLen;
      const urlLen = view.getUint32(pos, true);
      pos += 4;
      const url = sharedDecoder.decode(blob.subarray(pos, pos + urlLen));
      pos += urlLen;
      const headersLen = view.getUint32(pos, true);
      pos += 4;
      // Parse headers -- stored as array of [name, value] pairs.
      pos += headersLen;
      const headers = [];
      if (headersLen > 0) {
        const headersBlob = blob.subarray(pos - headersLen, pos);
        for (const line of sharedDecoder.decode(headersBlob).split("\r\n")) {
          const sep = line.indexOf(": ");
          if (sep > 0) headers.push([line.slice(0, sep), line.slice(sep + 2)]);
        }
      }
      const bodyLen = view.getUint32(pos, true);
      pos += 4;
      let body, bodyStreaming = false;
      if (bodyLen === 0xFFFFFFFF) {
        body = EMPTY_U8;
        bodyStreaming = true;
      } else {
        body = blob.subarray(pos, pos + bodyLen);
        pos += bodyLen;
      }
      requests.push({ id, method, url, headers, body, bodyStreaming });
    }
    return requests;
  }

  // Shared between jse.serve and node:http.
  globalThis.__jse.unpackServeRequests = unpackServeRequests;

  const toBytes = globalThis.__jse.toBytes;

  function sendResponse(listenerId, reqId, resp) {
    if (resp._isUpgrade || resp.status === 101) {
      return undefined;
    }
    const headers = resp._headersJoined ? resp._headersJoined() : "";
    // Hot path: materialized body - skip _serveBody() allocation.
    if (!resp._bodyIter && resp._fetchId == null) {
      resp._bodyUsed = true;
      try {
        ops.op_serve_respond(listenerId, reqId, resp.status ?? 200, headers, resp._bodyBytes ?? EMPTY_U8);
      } catch {
        // Client disconnected before response was sent.
      }
      return undefined;
    }
    const body = resp._serveBody();
    if (body.full !== undefined) {
      try {
        ops.op_serve_respond(listenerId, reqId, resp.status ?? 200, headers, body.full);
      } catch {}
      return undefined;
    }
    return sendStream(listenerId, reqId, resp, headers, body.iter);
  }

  async function sendStream(listenerId, reqId, resp, headers, iter) {
    ops.op_serve_respond_start(listenerId, reqId, resp.status ?? 200, headers);
    try {
      for await (const chunk of iter) {
        await ops.op_serve_respond_chunk(reqId, toBytes(chunk));
      }
    } finally {
      ops.op_serve_respond_end(reqId);
    }
  }

  // cert/key may be PEM contents or a filesystem path.
  function readPem(value, what) {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
      throw new TypeError(`jse.serve: ${what} must be a PEM string or a path`);
    }
    const text = typeof value === "string" ? value : sharedDecoder.decode(value);
    if (text.includes("-----BEGIN")) return text;
    return ops.op_read_text_file_sync(text);
  }

  function serve(options, handler) {
    if (typeof options === "function") {
      handler = options;
      options = {};
    } else if (!handler && typeof options?.handler === "function") {
      handler = options.handler;
    }
    if (typeof handler !== "function") {
      throw new TypeError("jse.serve: handler must be a function");
    }
    // Mutable handler slot for hot reload.
    let _activeHandler = handler;
    const hostname = options?.hostname ?? (globalThis.process?.env?.HOST || "0.0.0.0");
    const envPort = globalThis.process?.env?.PORT ? Number(globalThis.process.env.PORT) : NaN;
    const port = options?.port ?? (!isNaN(envPort) && envPort >= 0 ? envPort : 8000);
    let tls;
    if (options?.cert !== undefined || options?.key !== undefined) {
      tls = {
        cert: readPem(options.cert, "cert"),
        key: readPem(options.key, "key"),
      };
    }
    const [id, boundPort] = ops.op_serve_listen(hostname, port, tls, options?.limits);

    let _hotWatcher = null;
    let _hotVersion = 0;

    const server = {
      port: boundPort,
      hostname,
      close() {
        if (_hotWatcher) { _hotWatcher.close(); _hotWatcher = null; }
        ops.op_serve_close(id);
      },

      // Hot-swap the handler. In-flight requests finish with the old one.
      // New requests use the new handler immediately. No restart.
      reload(newHandler) {
        if (typeof newHandler !== "function") throw new TypeError("reload: handler must be a function");
        _activeHandler = newHandler;
        _hotVersion++;
        return server;
      },

      // Watch a module file and hot-reload when it changes.
      // The module must export a default function or a 'handler' named export.
      async hot(modulePath) {
        const path = await import("node:path");
        const fs = await import("node:fs");
        const resolved = path.resolve(String(modulePath));

        // Security: only allow hot-reload from the project directory
        const cwd = process.cwd();
        if (!resolved.startsWith(cwd)) {
          throw new Error(`server.hot() only allows files under the project directory: ${cwd}`);
        }
        // Reject symlinks pointing outside the project
        try {
          const real = fs.realpathSync(resolved);
          if (!real.startsWith(cwd)) {
            throw new Error(`server.hot() target resolves outside the project directory`);
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          // File doesn't exist yet, will be checked on load
        }

        async function load() {
          _hotVersion++;
          try {
            // Read and eval the module. Wraps in a function scope so
            // export default works via return.
            const code = fs.readFileSync(resolved, "utf8");
            // Extract default export: supports "export default fn" and
            // "module.exports = fn" patterns.
            const wrapped = `(function(){
              let __default, __handler, __fetch;
              const module = { exports: {} };
              const exports = module.exports;
              ${code.replace(/export\s+default\s+/g, "__default = ")}
              return __default || module.exports.default || module.exports.handler || module.exports;
            })()`;
            const result = (0, eval)(wrapped);
            const fn = typeof result === "function" ? result
              : typeof result?.default === "function" ? result.default
              : typeof result?.handler === "function" ? result.handler
              : typeof result?.fetch === "function" ? result.fetch
              : null;
            if (typeof fn !== "function") {
              ops.op_log(2, "hot", `${modulePath}: no handler export found`);
              return false;
            }
            _activeHandler = fn;
            ops.op_log(1, "hot", `reloaded ${modulePath} (v${_hotVersion})`);
            return true;
          } catch (err) {
            ops.op_log(3, "hot", `failed to reload ${modulePath}: ${err?.message || err}`);
            return false;
          }
        }

        // Initial load
        await load();

        // Watch for changes
        try {
          _hotWatcher = fs.watch(resolved, { persistent: false });
          _hotWatcher.on("change", () => {
            // Debounce: ignore rapid successive events
            if (server._hotDebounce) return;
            server._hotDebounce = true;
            setTimeout(async () => {
              server._hotDebounce = false;
              await load();
            }, 50);
          });
        } catch (err) {
          ops.op_log(2, "hot", `cannot watch ${modulePath}: ${err?.message || err}`);
        }

        return server;
      },

      get version() { return _hotVersion; },
    };

    function finish(reqId, resp) {
      if (!(resp instanceof Response)) {
        resp = resp === null || resp === undefined
          ? new Response("Internal Server Error\n", { status: 500, headers: { "Content-Type": "text/plain" } })
          : new Response(String(resp), { headers: { "Content-Type": "text/plain" } });
      }
      const sent = sendResponse(id, reqId, resp);
      if (sent) {
        sent.catch(() => {
          // Connection went away mid-response; nothing to do.
        });
      }
    }

    if (options?.log) {
      ops.op_log_set_http_enabled(true);
    }

    function handle(raw) {
      let resp;
      try {
        const req = Request._fromServe(raw);
        req._rawListenerId = id;
        req._rawId = raw.id;
        resp = _activeHandler(req);
      } catch (err) {
        ops.op_log(3, "http", `Error in handler for ${raw.method} ${raw.url}: ${err?.stack || err}`);
        resp = new Response("Internal Server Error\n", { status: 500, headers: { "Content-Type": "text/plain" } });
      }
      // Sync handlers complete the whole request without a single promise
      // allocation when the body is materialized (the hot path).
      if (resp instanceof Promise) {
        resp.then(
          (r) => finish(raw.id, r),
          (err) => {
            ops.op_log(3, "http", `Async error in handler for ${raw.method} ${raw.url}: ${err?.stack || err}`);
            finish(raw.id, new Response("Internal Server Error\n", { status: 500, headers: { "Content-Type": "text/plain" } }));
          },
        );
        return;
      }
      finish(raw.id, resp);
    }

    let serveReqCount = 0;

    // Keep the event loop alive while the server is listening.
    // Without this, the process exits because the async pull loop
    // alone doesn't register as a ref-counted I/O handle.
    const keepAlive = setInterval(() => {}, 1 << 30);

    // One pull loop; handlers run concurrently (not awaited here). Requests
    // are pulled in batches to amortize the op round-trip.
    server.finished = (async () => {
      for (;;) {
        const blob = await ops.op_serve_pull(id, 64);
        if (blob.length === 0) break;
        for (const raw of unpackServeRequests(blob)) {
          serveReqCount++;
          handle(raw);
        }
      }
      clearInterval(keepAlive);
    })();

    const origClose = server.close;
    server.close = () => {
      clearInterval(keepAlive);
      origClose();
    };

    return server;
  }

  // Built-in security headers middleware (replaces helmet npm package).
  // Usage: jse.serve({ port: 3000 }, jse.secure(handler));
  // Or selective: jse.serve({ port: 3000 }, jse.secure(handler, { hsts: false }));
  function secure(handler, options = {}) {
    const {
      hsts = true,
      noSniff = true,
      xssFilter = true,
      frameOptions = "DENY",
      contentSecurityPolicy = null,
      referrerPolicy = "strict-origin-when-cross-origin",
      permissionsPolicy = null,
      crossOriginOpenerPolicy = "same-origin",
      crossOriginResourcePolicy = "same-origin",
    } = options;

    return async (req) => {
      const res = await handler(req);
      const headers = new Headers(res.headers);

      if (hsts) headers.set("Strict-Transport-Security", typeof hsts === "string" ? hsts : "max-age=31536000; includeSubDomains");
      if (noSniff) headers.set("X-Content-Type-Options", "nosniff");
      if (xssFilter) headers.set("X-XSS-Protection", "0");
      if (frameOptions) headers.set("X-Frame-Options", typeof frameOptions === "string" ? frameOptions : "DENY");
      if (contentSecurityPolicy) headers.set("Content-Security-Policy", typeof contentSecurityPolicy === "string" ? contentSecurityPolicy : "default-src 'self'");
      if (referrerPolicy) headers.set("Referrer-Policy", referrerPolicy);
      if (permissionsPolicy) headers.set("Permissions-Policy", permissionsPolicy);
      if (crossOriginOpenerPolicy) headers.set("Cross-Origin-Opener-Policy", crossOriginOpenerPolicy);
      if (crossOriginResourcePolicy) headers.set("Cross-Origin-Resource-Policy", crossOriginResourcePolicy);

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };
  }

  // Built-in rate limiter for HTTP handlers (replaces express-rate-limit).
  // Usage: jse.serve({ port: 3000 }, jse.rateLimit(handler, { window: 60000, max: 100 }));
  function rateLimit(handler, options = {}) {
    const windowMs = options.window || options.windowMs || 60000;
    const max = options.max || 100;
    const message = options.message || "Too Many Requests";
    const keyFn = options.keyFn || ((req) => req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "global");

    const hits = new Map();
    // Cleanup old entries periodically
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of hits) {
        if (now - entry.start > windowMs) hits.delete(key);
      }
    }, windowMs);

    return async (req) => {
      const key = keyFn(req);
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now - entry.start > windowMs) {
        entry = { start: now, count: 0 };
        hits.set(key, entry);
      }
      entry.count++;

      if (entry.count > max) {
        const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
        return new Response(JSON.stringify({ error: message }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(max),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil((entry.start + windowMs) / 1000)),
          },
        });
      }

      const res = await handler(req);
      const headers = new Headers(res.headers);
      headers.set("X-RateLimit-Limit", String(max));
      headers.set("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
      headers.set("X-RateLimit-Reset", String(Math.ceil((entry.start + windowMs) / 1000)));

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };
  }

  // CORS middleware
  function cors(handler, options = {}) {
    const {
      origin = "*",
      methods = "GET,HEAD,PUT,PATCH,POST,DELETE",
      allowedHeaders = "*",
      credentials = false,
      maxAge = 86400,
    } = options;

    return async (req) => {
      const reqOrigin = req.headers.get("origin") || "*";
      const allowOrigin = typeof origin === "function" ? origin(reqOrigin) : origin;

      // Preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": allowOrigin,
            "Access-Control-Allow-Methods": methods,
            "Access-Control-Allow-Headers": allowedHeaders,
            "Access-Control-Max-Age": String(maxAge),
            ...(credentials ? { "Access-Control-Allow-Credentials": "true" } : {}),
          },
        });
      }

      const res = await handler(req);
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", allowOrigin);
      if (credentials) headers.set("Access-Control-Allow-Credentials", "true");

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };
  }

  if (!globalThis.jse) {
    globalThis.jse = {};
  }
  globalThis.jse.serve = serve;
  globalThis.jse.secure = secure;
  globalThis.jse.rateLimit = rateLimit;
  globalThis.jse.cors = cors;
})(globalThis);
