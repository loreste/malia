// Global runtime helpers and browser/framework compatibility shims
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  globalThis.global = globalThis;
  globalThis.GLOBAL = globalThis;
  globalThis.root = globalThis;
  // No `window` or `self`, as in Node: isomorphic code (React, Next.js) uses
  // `typeof window` to tell server from browser.

  // Global require() for ESM (Node v22+ compat). Builtins are served from
  // the node:module builtin map once it's loaded. File modules use the CJS
  // loader. This is a lazy shim: it becomes fully functional after the first
  // ESM module that triggers node:module's registration.
  if (typeof globalThis.require !== "function") {
    const cache = new Map();
    // Populated by node:module when it loads (via createRequire's __builtin).
    let builtinFn = null;
    globalThis.__jse_register_require_builtins = (fn) => { builtinFn = fn; };
    globalThis.require = function require(spec) {
      const text = String(spec);
      const bare = text.replace(/^node:/, "");
      // Try builtin first.
      if (builtinFn) {
        const key = "node:" + bare;
        if (cache.has(key)) return cache.get(key);
        const mod = builtinFn(key);
        if (mod !== undefined && mod !== null) { cache.set(key, mod); return mod; }
      }
      // File module.
      const cwd = ops.op_cwd();
      let resolved;
      try { resolved = ops.op_require_resolve(bare, cwd + "/_.js"); }
      catch { throw Object.assign(new Error("Cannot find module '" + spec + "'"), { code: "MODULE_NOT_FOUND" }); }
      if (cache.has(resolved)) return cache.get(resolved);
      if (resolved.endsWith(".json")) {
        const val = JSON.parse(ops.op_read_text_file_sync(resolved));
        cache.set(resolved, val);
        return val;
      }
      const code = ops.op_read_text_file_sync(resolved);
      const mod = { exports: {}, id: resolved, filename: resolved, loaded: false };
      cache.set(resolved, mod.exports);
      const dir = resolved.replace(/[/\\][^/\\]*$/, "");
      new Function("exports", "require", "module", "__filename", "__dirname", code)(mod.exports, require, mod, resolved, dir);
      mod.loaded = true;
      cache.set(resolved, mod.exports);
      return mod.exports;
    };
    globalThis.require.resolve = function (spec) {
      const bare = String(spec).replace(/^node:/, "");
      try { return ops.op_require_resolve(bare, ops.op_cwd() + "/_.js"); }
      catch { throw Object.assign(new Error("Cannot find module '" + spec + "'"), { code: "MODULE_NOT_FOUND" }); }
    };
    globalThis.require.cache = {};
  }

  // structuredClone
  if (typeof globalThis.structuredClone !== "function") {
    globalThis.structuredClone = (value) => {
      let bytes;
      try {
        bytes = ops.op_serialize(value, undefined, undefined, false, undefined);
      } catch (err) {
        // V8 reports uncloneable values as a TypeError; the spec (and Node)
        // throw a DataCloneError DOMException.
        throw new DOMException(err?.message ?? String(err), "DataCloneError");
      }
      return ops.op_deserialize(bytes, undefined, undefined, undefined, false);
    };
  }

  // navigator for framework SSR (Vue, Angular, React, Vite)
  if (!globalThis.navigator) {
    globalThis.navigator = {
      userAgent: "Node.js/26", // what Node reports
      userAgentData: {
        brands: [
          { brand: "jse", version: ops.op_runtime_version() },
          { brand: "Node.js", version: "26.11.1" },
        ],
        mobile: false,
        platform: typeof process !== "undefined" ? process.platform : "darwin",
      },
      // A getter: this object is built into the snapshot at build time.
      get hardwareConcurrency() {
        return ops.op_cpus();
      },
      language: "en-US",
      languages: ["en-US", "en"],
      platform: typeof process !== "undefined" ? process.platform : "darwin",
      onLine: true,
    };
  }

  // Web Crypto API on globalThis (Node 19+, Angular, Vue 3, React)
  if (!globalThis.crypto) {
    globalThis.crypto = {
      getRandomValues(typedArray) {
        if (
          !typedArray || !ArrayBuffer.isView(typedArray) || typedArray instanceof DataView ||
          typedArray instanceof Float32Array || typedArray instanceof Float64Array
        ) {
          throw new DOMException("The data argument must be an integer-type TypedArray", "TypeMismatchError");
        }
        if (typedArray.byteLength > 65536) {
          throw new DOMException(
            `The ArrayBufferView's byte length (${typedArray.byteLength}) exceeds the number of bytes of entropy available via this API (65536)`,
            "QuotaExceededError",
          );
        }
        const bytes = new Uint8Array(
          typedArray.buffer,
          typedArray.byteOffset,
          typedArray.byteLength,
        );
        const random = ops.op_crypto_random_bytes(bytes.byteLength);
        bytes.set(new Uint8Array(random));
        return typedArray;
      },
      randomUUID() {
        const b = new Uint8Array(ops.op_crypto_random_bytes(16));
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10
        const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
      // subtle: defined in 24_webcrypto.js
    };
  }


  // MessageChannel and MessagePort for React Scheduler and UI frameworks
  if (typeof globalThis.MessageChannel !== "function") {
    class MessagePort extends (globalThis.EventTarget || Object) {
      #other = null;
      #onmessage = null;
      #closed = false;

      constructor() {
        super();
      }

      _connect(other) {
        this.#other = other;
      }

      get onmessage() {
        return this.#onmessage;
      }

      set onmessage(fn) {
        this.#onmessage = fn;
      }

      postMessage(message) {
        if (this.#closed) return;
        const target = this.#other;
        if (!target || target.#closed) return;
        queueMicrotask(() => {
          if (target.#closed) return;
          const evt = { type: "message", data: message };
          if (typeof target.#onmessage === "function") {
            try {
              target.#onmessage(evt);
            } catch (err) {
              console.error("MessagePort onmessage error:", err);
            }
          }
          if (typeof target.dispatchEvent === "function") {
            target.dispatchEvent(evt);
          }
        });
      }

      close() {
        this.#closed = true;
      }

      start() {}
      ref() { return this; }
      unref() { return this; }
    }

    class MessageChannel {
      constructor() {
        this.port1 = new MessagePort();
        this.port2 = new MessagePort();
        this.port1._connect(this.port2);
        this.port2._connect(this.port1);
      }
    }

    globalThis.MessagePort = MessagePort;
    globalThis.MessageChannel = MessageChannel;
  }

  // WebAssembly streaming wrappers
  if (typeof WebAssembly !== "undefined") {
    WebAssembly.compileStreaming = async function (source) {
      const response = await Promise.resolve(source);
      const bytes = await response.arrayBuffer();
      return WebAssembly.compile(bytes);
    };

    WebAssembly.instantiateStreaming = async function (source, importObject) {
      const response = await Promise.resolve(source);
      const bytes = await response.arrayBuffer();
      return WebAssembly.instantiate(bytes, importObject);
    };
  }
})(globalThis);
