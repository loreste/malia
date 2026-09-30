// 12_websocket.js: Standards-compliant WebSocket client and server upgrade.
// Provides EventTarget, Event, MessageEvent, CloseEvent, ErrorEvent, and WebSocket.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ---- Standard DOM / Web Events -------------------------------------------

  // Legacy numeric codes for the DOMException names that have one.
  const DOM_EXCEPTION_CODES = {
    IndexSizeError: 1,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25,
  };

  class DOMException extends Error {
    constructor(message = "", options = "Error") {
      const name = typeof options === "object" && options !== null ? String(options.name ?? "Error") : String(options);
      super(message, typeof options === "object" && options !== null && "cause" in options ? { cause: options.cause } : undefined);
      this.name = name;
    }

    get code() {
      return DOM_EXCEPTION_CODES[this.name] ?? 0;
    }
  }
  if (!globalThis.DOMException) {
    globalThis.DOMException = DOMException;
  }

  class Event {
    #type;
    #bubbles;
    #cancelable;
    #defaultPrevented = false;
    #timeStamp;
    #target = null;
    #currentTarget = null;

    constructor(type, eventInitDict = {}) {
      this.#type = String(type);
      this.#bubbles = Boolean(eventInitDict.bubbles);
      this.#cancelable = Boolean(eventInitDict.cancelable);
      this.#timeStamp = Date.now();
    }

    get type() { return this.#type; }
    get bubbles() { return this.#bubbles; }
    get cancelable() { return this.#cancelable; }
    get defaultPrevented() { return this.#defaultPrevented; }
    get timeStamp() { return this.#timeStamp; }
    get target() { return this.#target; }
    get currentTarget() { return this.#currentTarget; }

    _setTarget(target) {
      this.#target = target;
      this.#currentTarget = target;
    }

    preventDefault() {
      if (this.#cancelable) this.#defaultPrevented = true;
    }
    stopPropagation() {}
    stopImmediatePropagation() {}
  }

  class CustomEvent extends Event {
    #detail;
    constructor(type, eventInitDict = {}) {
      super(type, eventInitDict);
      this.#detail = eventInitDict.detail ?? null;
    }
    get detail() { return this.#detail; }
  }

  class MessageEvent extends Event {
    #data;
    #origin;
    #lastEventId;
    #source;
    #ports;

    constructor(type, eventInitDict = {}) {
      super(type, eventInitDict);
      this.#data = eventInitDict.data;
      this.#origin = eventInitDict.origin ?? "";
      this.#lastEventId = eventInitDict.lastEventId ?? "";
      this.#source = eventInitDict.source ?? null;
      this.#ports = eventInitDict.ports ? Object.freeze([...eventInitDict.ports]) : Object.freeze([]);
    }

    get data() { return this.#data; }
    get origin() { return this.#origin; }
    get lastEventId() { return this.#lastEventId; }
    get source() { return this.#source; }
    get ports() { return this.#ports; }
  }

  class CloseEvent extends Event {
    #code;
    #reason;
    #wasClean;

    constructor(type, eventInitDict = {}) {
      super(type, eventInitDict);
      this.#code = eventInitDict.code ?? 0;
      this.#reason = eventInitDict.reason ?? "";
      this.#wasClean = Boolean(eventInitDict.wasClean);
    }

    get code() { return this.#code; }
    get reason() { return this.#reason; }
    get wasClean() { return this.#wasClean; }
  }

  class ErrorEvent extends Event {
    #message;
    #filename;
    #lineno;
    #colno;
    #error;

    constructor(type, eventInitDict = {}) {
      super(type, eventInitDict);
      this.#message = eventInitDict.message ?? "";
      this.#filename = eventInitDict.filename ?? "";
      this.#lineno = eventInitDict.lineno ?? 0;
      this.#colno = eventInitDict.colno ?? 0;
      this.#error = eventInitDict.error ?? null;
    }

    get message() { return this.#message; }
    get filename() { return this.#filename; }
    get lineno() { return this.#lineno; }
    get colno() { return this.#colno; }
    get error() { return this.#error; }
  }

  class EventTarget {
    #listeners = new Map();

    addEventListener(type, callback, options = {}) {
      if (typeof callback !== "function" && typeof callback?.handleEvent !== "function") return;
      const once = typeof options === "object" ? Boolean(options?.once) : false;
      let list = this.#listeners.get(type);
      if (!list) {
        list = [];
        this.#listeners.set(type, list);
      }
      if (!list.some((item) => item.callback === callback)) {
        list.push({ callback, once });
      }
    }

    removeEventListener(type, callback) {
      const list = this.#listeners.get(type);
      if (!list) return;
      const idx = list.findIndex((item) => item.callback === callback);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    }

    dispatchEvent(event) {
      if (!(event instanceof Event)) {
        throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
      }
      if (typeof event._setTarget === "function") {
        event._setTarget(this);
      }
      const list = this.#listeners.get(event.type);
      if (!list || list.length === 0) return !event.defaultPrevented;
      const snapshot = [...list];
      for (const item of snapshot) {
        if (item.once) {
          this.removeEventListener(event.type, item.callback);
        }
        try {
          if (typeof item.callback === "function") {
            item.callback.call(this, event);
          } else if (typeof item.callback?.handleEvent === "function") {
            item.callback.handleEvent(event);
          }
        } catch (err) {
          queueMicrotask(() => { throw err; });
        }
      }
      return !event.defaultPrevented;
    }
  }

  // ---- WebSocket Implementation --------------------------------------------

  class WebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    #id = null;
    #url = "";
    #readyState = 0; // CONNECTING
    #protocol = "";
    #binaryType = "blob";
    #onopen = null;
    #onmessage = null;
    #onerror = null;
    #onclose = null;
    #closeCode = null;
    #closeReason = null;

    constructor(url, protocols = []) {
      super();

      if (typeof protocols === "string") {
        protocols = [protocols];
      }
      this.#protocol = Array.isArray(protocols) && protocols.length > 0 ? String(protocols[0]) : "";

      if (typeof url === "object" && url !== null && url._upgrade) {
        // Server-side upgrade
        const { listenerId, reqId } = url._upgrade;
        this.#url = "ws://localhost/";
        this.#initServer(listenerId, reqId);
        return;
      }

      if (typeof url !== "string") {
        throw new TypeError("WebSocket constructor: url must be a string");
      }
      const parsed = new URL(url);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new SyntaxError(`The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol}' is not supported.`);
      }
      this.#url = parsed.href;
      this.#initClient(this.#url);
    }

    get url() { return this.#url; }
    get readyState() { return this.#readyState; }
    get bufferedAmount() { return 0; }
    get extensions() { return ""; }
    get protocol() { return this.#protocol; }

    get binaryType() { return this.#binaryType; }
    set binaryType(type) {
      if (type === "blob" || type === "arraybuffer" || type === "nodebuffer") {
        this.#binaryType = type;
      }
    }

    get onopen() { return this.#onopen; }
    set onopen(fn) {
      if (this.#onopen) this.removeEventListener("open", this.#onopen);
      this.#onopen = typeof fn === "function" ? fn : null;
      if (this.#onopen) this.addEventListener("open", this.#onopen);
    }

    get onmessage() { return this.#onmessage; }
    set onmessage(fn) {
      if (this.#onmessage) this.removeEventListener("message", this.#onmessage);
      this.#onmessage = typeof fn === "function" ? fn : null;
      if (this.#onmessage) this.addEventListener("message", this.#onmessage);
    }

    get onerror() { return this.#onerror; }
    set onerror(fn) {
      if (this.#onerror) this.removeEventListener("error", this.#onerror);
      this.#onerror = typeof fn === "function" ? fn : null;
      if (this.#onerror) this.addEventListener("error", this.#onerror);
    }

    get onclose() { return this.#onclose; }
    set onclose(fn) {
      if (this.#onclose) this.removeEventListener("close", this.#onclose);
      this.#onclose = typeof fn === "function" ? fn : null;
      if (this.#onclose) this.addEventListener("close", this.#onclose);
    }

    async #initClient(url) {
      try {
        const id = await ops.op_ws_connect(url);
        this.#id = id;
        this.#readyState = 1; // OPEN
        const openEvent = new Event("open");
        this.dispatchEvent(openEvent);
        this.#startPoll();
      } catch (err) {
        this.#readyState = 3; // CLOSED
        const errEvent = new ErrorEvent("error", { message: err?.message || String(err) });
        this.dispatchEvent(errEvent);
        const closeEvent = new CloseEvent("close", { code: 1006, reason: "connection failed", wasClean: false });
        this.dispatchEvent(closeEvent);
      }
    }

    async #initServer(listenerId, reqId) {
      try {
        const id = await ops.op_ws_upgrade(listenerId, reqId);
        this.#id = id;
        this.#readyState = 1; // OPEN
        const openEvent = new Event("open");
        this.dispatchEvent(openEvent);
        this.#startPoll();
      } catch (err) {
        this.#readyState = 3; // CLOSED
        const errEvent = new ErrorEvent("error", { message: err?.message || String(err) });
        this.dispatchEvent(errEvent);
        const closeEvent = new CloseEvent("close", { code: 1006, reason: "upgrade failed", wasClean: false });
        this.dispatchEvent(closeEvent);
      }
    }

    async #startPoll() {
      while (this.#readyState !== 3) {
        let event;
        try {
          event = await ops.op_ws_poll(this.#id);
        } catch {
          break;
        }
        if (!event) break;
        if (event.kind === 1) { // text
          const data = decoder.decode(event.data);
          const msgEvent = new MessageEvent("message", { data, origin: this.#url });
          this.dispatchEvent(msgEvent);
        } else if (event.kind === 2) { // binary
          const buf = event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength);
          let data;
          if (this.#binaryType === "arraybuffer") {
            data = buf;
          } else if (this.#binaryType === "nodebuffer" && typeof Buffer !== "undefined") {
            data = Buffer.from(buf);
          } else if (typeof Blob !== "undefined") {
            data = new Blob([buf]);
          } else if (typeof Buffer !== "undefined") {
            data = Buffer.from(buf);
          } else {
            data = buf;
          }
          const msgEvent = new MessageEvent("message", { data, origin: this.#url });
          this.dispatchEvent(msgEvent);
        } else if (event.kind === 3) { // close
          this.#readyState = 3;
          const closeEvent = new CloseEvent("close", {
            code: event.code || 1000,
            reason: event.reason || "",
            wasClean: event.code !== 1006,
          });
          this.dispatchEvent(closeEvent);
          break;
        } else if (event.kind === 4) { // error
          const errEvent = new ErrorEvent("error", { message: event.reason });
          this.dispatchEvent(errEvent);
        }
      }
      if (this.#readyState !== 3) {
        this.#readyState = 3;
        const code = this.#closeCode !== null ? this.#closeCode : 1006;
        const reason = this.#closeReason !== null ? this.#closeReason : "connection closed";
        const wasClean = this.#closeCode !== null;
        const closeEvent = new CloseEvent("close", {
          code,
          reason,
          wasClean,
        });
        this.dispatchEvent(closeEvent);
      }
    }

    send(data) {
      if (this.#readyState !== 1) {
        throw new Error("WebSocket is not open: readyState " + this.#readyState);
      }
      if (typeof data === "string") {
        ops.op_ws_send(this.#id, encoder.encode(data), true);
      } else if (data instanceof ArrayBuffer) {
        ops.op_ws_send(this.#id, new Uint8Array(data), false);
      } else if (ArrayBuffer.isView(data)) {
        ops.op_ws_send(this.#id, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), false);
      } else {
        throw new TypeError("data must be a string, Buffer, ArrayBuffer, or ArrayBufferView");
      }
    }

    close(code = 1000, reason = "") {
      if (code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(
          `The code must be either 1000, or between 3000 and 4999. ${code} is invalid.`,
          "InvalidAccessError",
        );
      }
      if (typeof reason === "string" && encoder.encode(reason).length > 123) {
        throw new SyntaxError("The message must not be greater than 123 bytes.");
      }
      if (this.#readyState === 2 || this.#readyState === 3) return;
      this.#readyState = 2; // CLOSING
      this.#closeCode = code;
      this.#closeReason = String(reason);
      if (this.#id !== null) {
        ops.op_ws_close(this.#id, code, String(reason));
      }
    }

    ping(data = "") {
      if (this.#readyState !== 1) return;
      this.dispatchEvent(new CustomEvent("ping", { detail: data }));
    }

    pong(data = "") {
      if (this.#readyState !== 1) return;
      this.dispatchEvent(new CustomEvent("pong", { detail: data }));
    }

    on(type, listener) {
      const handler = (evt) => {
        if (type === "message") listener(evt.data, evt.isBinary);
        else if (type === "close") listener(evt.code, evt.reason);
        else if (type === "error") listener(evt.error || evt);
        else if (type === "ping" || type === "pong") listener(evt.detail);
        else listener(evt);
      };
      this.addEventListener(type, handler);
      return this;
    }

    once(type, listener) {
      const handler = (evt) => {
        if (type === "message") listener(evt.data, evt.isBinary);
        else if (type === "close") listener(evt.code, evt.reason);
        else if (type === "error") listener(evt.error || evt);
        else if (type === "ping" || type === "pong") listener(evt.detail);
        else listener(evt);
      };
      this.addEventListener(type, handler, { once: true });
      return this;
    }

    off(type, listener) {
      this.removeEventListener(type, listener);
      return this;
    }

    addListener(type, listener) { return this.on(type, listener); }
    removeListener(type, listener) { return this.off(type, listener); }
  }

  // ---- Server Upgrade API --------------------------------------------------

  function upgradeWebSocket(req) {
    if (!req || req._rawId === undefined) {
      throw new TypeError("upgradeWebSocket requires an incoming Request from jse.serve");
    }
    const socket = new WebSocket({
      _upgrade: {
        listenerId: req._rawListenerId,
        reqId: req._rawId,
      },
    });
    const response = new Response(null, { status: 101 });
    response._isUpgrade = true;
    return { response, socket };
  }

  // Export to globalThis
  globalThis.Event = Event;
  globalThis.CustomEvent = CustomEvent;
  globalThis.MessageEvent = MessageEvent;
  globalThis.CloseEvent = CloseEvent;
  globalThis.ErrorEvent = ErrorEvent;
  globalThis.EventTarget = EventTarget;
  globalThis.WebSocket = WebSocket;

  if (globalThis.jse) {
    globalThis.jse.upgradeWebSocket = upgradeWebSocket;
  }
  if (globalThis.Deno) {
    globalThis.Deno.upgradeWebSocket = upgradeWebSocket;
  }
})(globalThis);
