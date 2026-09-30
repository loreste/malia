// BroadcastChannel (HTML standard, Node global): messages reach every other
// channel with the same name in this process, including in workers.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  const core = Deno.core;

  class BroadcastChannel extends EventTarget {
    #name;
    #id;
    #refed = true;
    #pending = null;
    onmessage = null;
    onmessageerror = null;

    constructor(name) {
      if (arguments.length === 0) throw new TypeError("The \"name\" argument must be specified");
      super();
      this.#name = String(name);
      this.#id = ops.op_broadcast_open(this.#name);
      this.#receive();
    }

    get name() {
      return this.#name;
    }

    async #receive() {
      // A handler may close() the channel; stop before the next receive.
      while (this.#id !== null) {
        this.#pending = ops.op_broadcast_recv(this.#id);
        if (!this.#refed) core.unrefOpPromise(this.#pending);
        const bytes = await this.#pending;
        this.#pending = null;
        if (bytes === null) return; // closed
        let event;
        try {
          const data = ops.op_deserialize(bytes, undefined, undefined, undefined, false);
          event = new MessageEvent("message", { data });
        } catch {
          event = new MessageEvent("messageerror", {});
        }
        const handler = event.type === "message" ? this.onmessage : this.onmessageerror;
        if (typeof handler === "function") {
          try {
            handler.call(this, event);
          } catch (err) {
            queueMicrotask(() => { throw err; });
          }
        }
        this.dispatchEvent(event);
      }
    }

    postMessage(message) {
      if (this.#id === null) throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
      let bytes;
      try {
        bytes = ops.op_serialize(message, undefined, undefined, false, undefined);
      } catch (err) {
        throw new DOMException(err?.message ?? String(err), "DataCloneError");
      }
      ops.op_broadcast_post(this.#id, bytes);
    }

    close() {
      if (this.#id === null) return;
      ops.op_broadcast_close(this.#id);
      this.#id = null;
    }

    // Node: an open channel keeps the event loop alive unless unref'd.
    ref() {
      this.#refed = true;
      if (this.#pending) core.refOpPromise(this.#pending);
      return this;
    }

    unref() {
      this.#refed = false;
      if (this.#pending) core.unrefOpPromise(this.#pending);
      return this;
    }
  }

  globalThis.BroadcastChannel = BroadcastChannel;
})(globalThis);
