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
        __jse.serialize(value === undefined ? null : value),
      );
      if (!ok) throw new Error("worker is gone");
    }

    // One-shot receive; does not hold the event loop open. Resolves to
    // { data } or throws if the worker went away.
    async receive() {
      const bytes = await ops.op_worker_recv(this.#id);
      if (bytes.length === 0) throw new Error("worker is gone");
      return { data: __jse.deserialize(bytes) };
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
          const data = __jse.deserialize(bytes);
          if (this.#onmessage) {
            this.#onmessage({ data });
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
    const poolContext = new Deno.core.AsyncVariable();
    globalThis.postMessage = (value) => {
      const job = poolContext.get();
      const payload = job ? { __maliaPoolId: job.id, kind: job.stream && value?.__done === true ? 'done' : 'data', data: value } : (value === undefined ? null : value);
      if (!ops.op_host_send(__jse.serialize(payload))) {
        throw new Error('worker reply channel is closed or full');
      }
    };
    // Driven by the host after the worker's main module has been evaluated.
    globalThis.__jseWorkerHostLoop = async () => {
      while (true) {
        const bytes = await ops.op_host_recv();
        if (bytes.length === 0) break;
        try {
          const data = __jse.deserialize(bytes);
          if (messageHandler) {
            const job = data?.__maliaPoolJob;
            if (!job) { messageHandler({ data }); continue; }
            const previous = poolContext.enter(job);
            const report = error => ops.op_host_send(__jse.serialize({
              __maliaPoolId: job.id, kind: 'error', error: String(error?.message ?? error)
            }));
            try {
              const result = messageHandler({ data: data.data });
              if (result && typeof result.then === 'function') result.catch(report);
            } catch (error) { report(error); }
            finally { Deno.core.setAsyncContext(previous); }
          }
        } catch (err) {
          console.error("worker onmessage error:", err);
        }
      }
    };
  };
})(globalThis);
