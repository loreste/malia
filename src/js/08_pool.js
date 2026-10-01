// One dispatcher and job-tagged replies for ordinary and streaming work.
"use strict";
((globalThis) => {
  class WorkerPool {
    #entries = [];
    #queue = [];
    #closed = false;
    #path;
    #nextId = 1;
    #maxQueue;
    #maxBuffered;
    #timeout;
    constructor(path, options = {}) {
      this.#path = path;
      const size = options.size ?? Deno.core.ops.op_cpus();
      this.#maxQueue = options.maxQueue ?? 1024;
      this.#maxBuffered = options.maxBuffered ?? 64;
      this.#timeout = options.timeoutMs ?? 30000;
      for (const [name, value] of Object.entries({ size, maxQueue: this.#maxQueue, maxBuffered: this.#maxBuffered, timeoutMs: this.#timeout })) {
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}`);
      }
      if (size > 256) throw new RangeError('WorkerPool size exceeds 256');
      try { for (let i = 0; i < size; i++) this.#entries.push({ worker: new Worker(path), job: null }); }
      catch (error) { this.close(); throw error; }
    }
    get size() { return this.#entries.length; }
    get pending() { return this.#queue.length; }
    #enqueue(job, options) {
      if (this.#closed) throw new Error('pool is closed');
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error('job aborted');
      if (this.#queue.length >= this.#maxQueue) throw new Error('pool queue capacity exceeded');
      job.id = this.#nextId++;
      job.finished = false;
      job.signal = options?.signal;
      job.abort = () => this.#finish(job, job.signal.reason ?? new Error('job aborted'), true);
      job.signal?.addEventListener('abort', job.abort, { once: true });
      this.#queue.push(job);
      this.#dispatch();
    }
    run(arg, options = {}) {
      return new Promise((resolve, reject) => this.#enqueue({ arg, resolve, reject, stream: false }, options));
    }
    map(items, options) { return Promise.all(items.map(item => this.run(item, options))); }
    stream(arg, options = {}) {
      const job = { arg, stream: true, values: [], waiters: [], error: null, finished: false };
      this.#enqueue(job, options);
      const next = () => {
        if (job.values.length) return Promise.resolve({ done: false, value: job.values.shift() });
        if (job.error) return Promise.reject(job.error);
        if (job.finished) return Promise.resolve({ done: true, value: undefined });
        if (job.waiters.length >= this.#maxBuffered) return Promise.reject(new Error('Too many pending stream reads'));
        return new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
      };
      const iterator = {
        next,
        return: () => {
          job.values.length = 0;
          this.#finish(job, null, true);
          return Promise.resolve({ done: true, value: undefined });
        },
        [Symbol.asyncIterator]() { return this; },
      };
      return iterator;
    }
    #finish(job, error, retire = false, value) {
      if (job.finished) return;
      job.finished = true;
      clearTimeout(job.timer);
      job.signal?.removeEventListener('abort', job.abort);
      const queued = this.#queue.indexOf(job);
      if (queued >= 0) this.#queue.splice(queued, 1);
      if (job.stream) {
        job.error = error;
        for (const waiter of job.waiters.splice(0)) {
          if (error) waiter.reject(error);
          else waiter.resolve({ done: true, value: undefined });
        }
      } else if (error) job.reject(error);
      else job.resolve(value);
      const entry = job.entry;
      if (entry?.job === job) {
        entry.job = null;
        if (retire) {
          entry.worker.terminate();
          if (!this.#closed) {
            try { entry.worker = new Worker(this.#path); }
            catch (failure) { this.close(failure); return; }
          }
        }
      }
      this.#dispatch();
    }
    #dispatch() {
      if (this.#closed) return;
      for (const entry of this.#entries) {
        if (entry.job || !this.#queue.length) continue;
        const job = this.#queue.shift();
        entry.job = job;
        job.entry = entry;
        job.timer = setTimeout(() => this.#finish(job, new Error('worker job deadline exceeded'), true), this.#timeout);
        try {
          entry.worker.postMessage({ __maliaPoolJob: { id: job.id, stream: job.stream }, data: job.arg });
          this.#receive(entry, job);
        } catch (error) { this.#finish(job, error, true); }
      }
    }
    async #receive(entry, job) {
      const worker = entry.worker;
      try {
        while (!job.finished) {
          const { data: reply } = await worker.receive();
          if (job.finished) return;
          if (reply?.__maliaPoolId !== job.id) continue;
          if (reply.kind === 'error') throw new Error(reply.error);
          if (!job.stream) { this.#finish(job, null, false, reply.data); return; }
          if (reply.kind === 'done') { this.#finish(job, null); return; }
          const waiter = job.waiters.shift();
          if (waiter) waiter.resolve({ done: false, value: reply.data });
          else {
            if (job.values.length >= this.#maxBuffered) throw new Error('worker stream buffer capacity exceeded');
            job.values.push(reply.data);
          }
        }
      } catch (error) { this.#finish(job, error, true); }
    }
    close(error = new Error('pool is closed')) {
      if (this.#closed) return;
      this.#closed = true;
      for (const job of [...this.#queue]) this.#finish(job, error);
      for (const entry of this.#entries) {
        if (entry.job) this.#finish(entry.job, error);
        entry.worker.terminate();
      }
    }
  }
  globalThis.WorkerPool = WorkerPool;
})(globalThis);
