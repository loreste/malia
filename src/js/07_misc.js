// Global runtime helpers and browser/framework compatibility shims
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  globalThis.global = globalThis;
  globalThis.GLOBAL = globalThis;
  globalThis.root = globalThis;
  if (!globalThis.self) globalThis.self = globalThis;
  if (!globalThis.window) globalThis.window = globalThis;

  // structuredClone
  if (typeof globalThis.structuredClone !== "function") {
    globalThis.structuredClone = (value) =>
      ops.op_deserialize(
        ops.op_serialize(value, undefined, undefined, false, undefined),
        undefined,
        undefined,
        undefined,
        false,
      );
  }

  // DOMException
  if (typeof globalThis.DOMException !== "function") {
    class DOMException extends Error {
      constructor(message = "", name = "Error") {
        super(message);
        this.name = name;
      }
    }
    globalThis.DOMException = DOMException;
  }

  // navigator for framework SSR (Vue, Angular, React, Vite)
  if (!globalThis.navigator) {
    globalThis.navigator = {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jse/0.1.0 Node/26.0.0",
      userAgentData: {
        brands: [
          { brand: "jse", version: "0.1.0" },
          { brand: "Node.js", version: "26.0.0" },
        ],
        mobile: false,
        platform: typeof process !== "undefined" ? process.platform : "darwin",
      },
      hardwareConcurrency: 8,
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
        if (!typedArray || !ArrayBuffer.isView(typedArray) || typedArray instanceof DataView) {
          throw new TypeError("Argument must be an integer TypedArray");
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
      subtle: {},
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
