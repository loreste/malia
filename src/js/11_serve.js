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
      const headersBlob = blob.subarray(pos, pos + headersLen);
      pos += headersLen;
      const headers = [];
      if (headersLen > 0) {
        for (const line of sharedDecoder.decode(headersBlob).split("\r\n")) {
          const sep = line.indexOf(": ");
          headers.push([line.slice(0, sep), line.slice(sep + 2)]);
        }
      }
      const bodyLen = view.getUint32(pos, true);
      pos += 4;
      let body, bodyStreaming = false;
      if (bodyLen === 0xFFFFFFFF) {
        // Body is available via streaming op_serve_read_body(id)
        body = new Uint8Array(0);
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

  if (!globalThis.jse) {
    globalThis.jse = {};
  }
  globalThis.jse.serve = serve;
})(globalThis);
