// jse.serve: Deno-style HTTP server over the hyper engine (src/serve.rs).
// handler(req: Request) -> Response (or a promise of one). Responses with
// string/typed-array bodies go out whole; async-iterable bodies stream as
// chunked transfer-encoding.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  const sharedDecoder = new TextDecoder();

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
      const methodLen = view.getUint16(pos, true);
      pos += 2;
      const method = sharedDecoder.decode(blob.subarray(pos, pos + methodLen));
      pos += methodLen;
      const urlLen = view.getUint16(pos, true);
      pos += 2;
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
      const body = blob.subarray(pos, pos + bodyLen);
      pos += bodyLen;
      requests.push({ id, method, url, headers, body });
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
    const body = resp._serveBody();
    if (body.full !== undefined) {
      // Whole-body hot path: one sync op, no promise at all.
      ops.op_serve_respond(listenerId, reqId, resp.status ?? 200, headers, body.full);
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

    const server = {
      port: boundPort,
      hostname,
      close() {
        ops.op_serve_close(id);
      },
    };

    function finish(reqId, resp) {
      if (!(resp instanceof Response)) {
        resp = resp === null || resp === undefined
          ? new Response("Internal Server Error", { status: 500 })
          : new Response(String(resp));
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
        resp = handler(req);
      } catch (err) {
        ops.op_log(3, "http", `Error in handler for ${raw.method} ${raw.url}: ${err?.stack || err}`);
        resp = new Response("Internal Server Error\n", { status: 500 });
      }
      // Sync handlers complete the whole request without a single promise
      // allocation when the body is materialized (the hot path).
      if (resp instanceof Promise) {
        resp.then(
          (r) => finish(raw.id, r),
          (err) => {
            ops.op_log(3, "http", `Async error in handler for ${raw.method} ${raw.url}: ${err?.stack || err}`);
            finish(raw.id, new Response("Internal Server Error\n", { status: 500 }));
          },
        );
        return;
      }
      finish(raw.id, resp);
    }

    let serveReqCount = 0;
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
    })();


    return server;
  }

  if (!globalThis.jse) {
    globalThis.jse = {};
  }
  globalThis.jse.serve = serve;
})(globalThis);
