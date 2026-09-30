// src/js/15_router.js - High-Performance Radix Router and Zero-Copy Static File Server
((globalThis) => {
  const { core } = globalThis.__bootstrap;
  const { ops } = core;

  if (!globalThis.jse) {
    globalThis.jse = {};
  }

  class Router {
    #routes = [];
    #handlers = new Map();
    #middlewares = [];
    #nextId = 1;

    #add(method, pattern, handler) {
      if (typeof pattern !== "string") throw new TypeError("Route pattern must be a string");
      if (typeof handler !== "function") throw new TypeError("Route handler must be a function");

      const id = this.#nextId++;
      this.#routes.push([id, method, pattern]);
      this.#handlers.set(id, handler);
      return this;
    }

    get(pattern, handler) {
      return this.#add("GET", pattern, handler);
    }

    post(pattern, handler) {
      return this.#add("POST", pattern, handler);
    }

    put(pattern, handler) {
      return this.#add("PUT", pattern, handler);
    }

    delete(pattern, handler) {
      return this.#add("DELETE", pattern, handler);
    }

    patch(pattern, handler) {
      return this.#add("PATCH", pattern, handler);
    }

    options(pattern, handler) {
      return this.#add("OPTIONS", pattern, handler);
    }

    all(pattern, handler) {
      return this.#add("ALL", pattern, handler);
    }

    use(...args) {
      if (args.length === 1 && typeof args[0] === "function") {
        this.#middlewares.push({ prefix: "/", fn: args[0] });
      } else if (args.length >= 2 && typeof args[0] === "string") {
        const prefix = args[0];
        for (let i = 1; i < args.length; i++) {
          if (typeof args[i] === "function") {
            this.#middlewares.push({ prefix, fn: args[i] });
          }
        }
      }
      return this;
    }

    /**
     * Mount static directory with zero-copy file streaming, ETags, and SPA fallback
     * @param {string} prefix Route prefix, e.g. "/assets" or "/"
     * @param {string} directory Local filesystem path, e.g. "./public"
     * @param {{ spa?: boolean | string, maxAge?: number }} [options]
     */
    static(prefix, directory, options = {}) {
      const cleanPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      const pattern = cleanPrefix === "" ? "/*path" : `${cleanPrefix}/*path`;
      const spaFallback = options.spa === true ? "index.html" : (typeof options.spa === "string" ? options.spa : null);
      const maxAge = typeof options.maxAge === "number" ? options.maxAge : 3600;

      this.#add("GET", pattern, (req) => {
        const relPath = req.params?.path ? "/" + req.params.path : "/";
        const file = ops.op_static_file(directory, relPath, spaFallback);

        if (!file || !file.exists || !file.is_file) {
          return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
        }

        // Check If-None-Match for 304 Not Modified
        const ifNoneMatch = req.headers.get("if-none-match");
        if (ifNoneMatch && ifNoneMatch === file.etag) {
          return new Response(null, {
            status: 304,
            headers: {
              "ETag": file.etag,
              "Cache-Control": `public, max-age=${maxAge}`,
            },
          });
        }

        const headers = {
          "Content-Type": file.mime_type,
          "Content-Length": String(file.size),
          "ETag": file.etag,
          "Cache-Control": `public, max-age=${maxAge}`,
        };

        const body = file.contents ? new Uint8Array(file.contents) : new Uint8Array(0);
        return new Response(body, { status: 200, headers });
      });

      return this;
    }

    /**
     * Generate standard (req) => Response handler compatible with jse.serve and fetch
     */
    handler() {
      const routes = this.#routes;
      const handlers = this.#handlers;
      const middlewares = this.#middlewares;

      return async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        // Run middlewares
        for (const mw of middlewares) {
          if (path.startsWith(mw.prefix)) {
            const mwRes = await mw.fn(req);
            if (mwRes instanceof Response) {
              return mwRes;
            }
          }
        }

        // Match route using fast native radix tree
        const match = ops.op_router_match(method, path, routes);
        if (!match || !match.matched) {
          return new Response(
            JSON.stringify({ error: "Not Found", path, method }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }

        // Attach parsed route params and query params to request
        req.params = match.params || {};
        req.query = Object.fromEntries(url.searchParams.entries());

        const handler = handlers.get(match.route_id);
        if (!handler) {
          return new Response("Internal Server Error", { status: 500 });
        }

        try {
          const res = await handler(req);
          if (res instanceof Response) {
            return res;
          }
          if (typeof res === "string" || res instanceof Uint8Array) {
            return new Response(res, {
              status: 200,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          }
          if (res && typeof res === "object") {
            return new Response(JSON.stringify(res), {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            });
          }
          return new Response("", { status: 204 });
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      };
    }
  }

  globalThis.jse.Router = Router;
})(globalThis);
