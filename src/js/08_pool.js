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

    // Dispatch `arg` and return an async iterable of replies. The worker
    // sends a sentinel `{ __done: true }` to signal completion (or the
    // pool reclaims the worker after the iterable is broken out of).
    stream(arg) {
      if (this.#closed) throw new Error("pool is closed");
      const pool = this;
      return {
        [Symbol.asyncIterator]() {
          let entry = null;
          let done = false;
          const ready = new Promise((resolve) => {
            pool.#queue.push({
              arg,
              resolve: (e) => { entry = e; resolve(); },
              reject: () => { done = true; resolve(); },
              _stream: true,
            });
            pool.#dispatchStream();
          });
          return {
            async next() {
              await ready;
              if (done || !entry) return { done: true, value: undefined };
              const msg = await entry.worker.receive();
              if (!msg || msg.data?.__done) {
                if (!pool.#closed) pool.#idle.push(entry);
                pool.#dispatch();
                return { done: true, value: undefined };
              }
              return { done: false, value: msg.data };
            },
            return() {
              if (entry && !pool.#closed) { pool.#idle.push(entry); pool.#dispatch(); }
              done = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
    }

    #dispatchStream() {
      while (!this.#closed && this.#queue.length > 0 && this.#idle.length > 0) {
        const job = this.#queue[0];
        if (job._stream) {
          this.#queue.shift();
          const entry = this.#idle.shift();
          entry.worker.postMessage(job.arg);
          job.resolve(entry);
        } else {
          // Non-stream job, use normal dispatch.
          this.#dispatch();
          return;
        }
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
