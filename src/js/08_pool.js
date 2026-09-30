// WorkerPool: fixed-size pool of Workers with idle-first (least-busy)
// dispatch. Each pooled worker handles one job at a time; `run(arg)` posts
// `arg` to an idle worker and resolves with its next reply, so pool worker
// scripts must answer exactly one postMessage per received message.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  class WorkerPool {
    #entries = [];
    #idle = [];
    #queue = [];
    #closed = false;

    constructor(path, options = {}) {
      const size = Math.max(1, Math.floor(options.size ?? ops.op_cpus()));
      for (let i = 0; i < size; i++) {
        const entry = { worker: new Worker(path) };
        this.#entries.push(entry);
        this.#idle.push(entry);
      }
    }

    get size() {
      return this.#entries.length;
    }

    get pending() {
      return this.#queue.length;
    }

    // Dispatch `arg` to the next idle worker; resolves with its reply.
    run(arg) {
      if (this.#closed) return Promise.reject(new Error("pool is closed"));
      return new Promise((resolve, reject) => {
        this.#queue.push({ arg, resolve, reject });
        this.#dispatch();
      });
    }

    // Run `fn` over `items` with the pool; resolves to an array of results
    // in input order.
    map(items) {
      return Promise.all(items.map((item) => this.run(item)));
    }

    #dispatch() {
      while (!this.#closed && this.#queue.length > 0 && this.#idle.length > 0) {
        const entry = this.#idle.shift();
        const job = this.#queue.shift();
        const reply = entry.worker.receive();
        entry.worker.postMessage(job.arg);
        const settle = (fn, value) => {
          if (!this.#closed) this.#idle.push(entry);
          fn(value);
          this.#dispatch();
        };
        reply.then(
          ({ data }) => settle(job.resolve, data),
          (err) => settle(job.reject, err),
        );
      }
    }

    // Reject queued jobs and terminate all workers. In-flight jobs resolve
    // or reject with whatever their worker last sent before termination.
    close() {
      this.#closed = true;
      for (const job of this.#queue.splice(0)) {
        job.reject(new Error("pool is closed"));
      }
      this.#idle.length = 0;
      for (const { worker } of this.#entries) {
        worker.terminate();
      }
    }
  }

  globalThis.WorkerPool = WorkerPool;
})(globalThis);
