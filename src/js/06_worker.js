// Worker: OS-thread workers, each with its own V8 isolate. Parent and
// worker exchange V8 structured-clone binary messages over tokio channels
// bridged through ops.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  // ---- Parent side --------------------------------------------------------
  class Worker {
    #id;
    #onmessage = null;
    #terminated = false;
    #loopStarted = false;

    // `path` is resolved against the process cwd (like Node's
    // worker_threads), or may be an absolute file:// URL.
    constructor(path) {
      this.#id = ops.op_worker_spawn(String(path));
    }

    get onmessage() {
      return this.#onmessage;
    }

    // Setting onmessage starts a background receive loop. Note: the loop
    // holds the event loop open; call terminate() when done.
    set onmessage(fn) {
      this.#onmessage = fn;
      if (fn && !this.#loopStarted) {
        this.#loopStarted = true;
        this.#loop();
      }
    }

    postMessage(value) {
      if (this.#terminated) throw new Error("worker is terminated");
      const ok = ops.op_worker_send(
        this.#id,
        __jse.serialize({ type: "message", data: value === undefined ? null : value }),
      );
      if (!ok) throw new Error("worker is gone");
    }

    // One-shot receive; does not hold the event loop open. Resolves to
    // { data } or throws if the worker went away.
    async receive() {
      const bytes = await ops.op_worker_recv(this.#id);
      if (bytes.length === 0) throw new Error("worker is gone");
      const msg = __jse.deserialize(bytes);
      return { data: msg.data };
    }

    terminate() {
      this.#terminated = true;
      ops.op_worker_terminate(this.#id);
    }

    async #loop() {
      while (!this.#terminated) {
        let bytes;
        try {
          bytes = await ops.op_worker_recv(this.#id);
        } catch {
          break;
        }
        if (bytes.length === 0) break;
        try {
          const msg = __jse.deserialize(bytes);
          if (msg.type === "message" && this.#onmessage) {
            this.#onmessage({ data: msg.data });
          }
        } catch (err) {
          console.error("worker onmessage error:", err);
        }
      }
    }
  }

  globalThis.Worker = Worker;

  // ---- Worker (child) side ------------------------------------------------
  // Invoked by the host (worker.rs) right after runtime creation, before the
  // worker's main module is evaluated. This is deferred rather than branching
  // on op_in_worker() at bootstrap: the bootstrap JS is baked into the V8
  // startup snapshot, where per-runtime state is not yet available.
  globalThis.__jseInitWorkerChild = () => {
    globalThis.self = globalThis;
    let messageHandler = null;
    Object.defineProperty(globalThis, "onmessage", {
      get: () => messageHandler,
      set: (fn) => {
        messageHandler = fn;
      },
      configurable: true,
    });
    globalThis.postMessage = (value) => {
      ops.op_host_send(
        __jse.serialize({ type: "message", data: value === undefined ? null : value }),
      );
    };
    // Driven by the host after the worker's main module has been evaluated.
    globalThis.__jseWorkerHostLoop = async () => {
      while (true) {
        const bytes = await ops.op_host_recv();
        if (bytes.length === 0) break;
        try {
          const msg = __jse.deserialize(bytes);
          if (msg.type === "message" && messageHandler) {
            messageHandler({ data: msg.data });
          }
        } catch (err) {
          console.error("worker onmessage error:", err);
        }
      }
    };
  };
})(globalThis);
