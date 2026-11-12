// malia.parallel -- concurrent execution primitives for existing Node.js code.
//
// Node.js is single-threaded. These APIs let you add concurrency to existing
// code without rewriting it. For CPU-bound work, use WorkerPool. For I/O-bound
// work (fetch, DB queries, file reads), these give you controlled parallelism
// that Promise.all can't -- concurrency limits, backpressure, and structured
// error handling.
//
//   // Fetch 100 URLs, 10 at a time (not all at once)
//   const results = await malia.parallel.map(urls, url => fetch(url), { concurrency: 10 });
//
//   // Process stream chunks concurrently
//   await malia.parallel.pipeline(readStream, chunk => transform(chunk), writeStream);
//
//   // Protect shared state
//   const lock = malia.mutex();
//   await lock.run(async () => { /* critical section */ });

"use strict";
((globalThis) => {
  const ops = Deno.core.ops;
  const maxConcurrency = Math.max(1, ops.op_cpus() - 1);

  // -- parallel: run tasks with concurrency control --------------------------

  // malia.parallel(tasks, options) -- run function array concurrently
  // Unlike Promise.all, this limits how many run at once.
  async function parallel(tasks, options = {}) {
    const concurrency = Math.min(options.concurrency || maxConcurrency, tasks.length);
    const signal = options.signal;
    const results = new Array(tasks.length);
    let nextIdx = 0;
    let firstError = null;

    async function runner() {
      while (nextIdx < tasks.length) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        if (firstError && !options.settled) return;
        const idx = nextIdx++;
        if (idx >= tasks.length) break;
        try {
          results[idx] = await (typeof tasks[idx] === "function" ? tasks[idx]() : tasks[idx]);
        } catch (e) {
          if (options.settled) {
            results[idx] = { status: "rejected", reason: e };
          } else {
            firstError = firstError || e;
            throw e;
          }
        }
      }
    }

    const runners = Array.from({ length: concurrency }, () => runner());
    if (options.settled) {
      await Promise.allSettled(runners);
    } else {
      try { await Promise.all(runners); }
      catch (_) { throw firstError; }
    }
    return results;
  }

  // malia.parallel.map(items, fn, options) -- parallel map with concurrency
  // The killer feature: process arrays concurrently with a simple limit.
  //   await malia.parallel.map(users, user => db.save(user), { concurrency: 20 })
  parallel.map = async function (items, fn, options = {}) {
    const concurrency = options.concurrency || maxConcurrency;
    const signal = options.signal;
    const results = new Array(items.length);
    let nextIdx = 0;

    async function runner() {
      while (nextIdx < items.length) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        const idx = nextIdx++;
        if (idx >= items.length) break;
        results[idx] = await fn(items[idx], idx, items);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
    return results;
  };

  // malia.parallel.filter(items, fn, options)
  parallel.filter = async function (items, fn, options = {}) {
    const flags = await parallel.map(items, fn, options);
    return items.filter((_, i) => flags[i]);
  };

  // malia.parallel.each(items, fn, options) -- side-effect-only parallel forEach
  parallel.each = async function (items, fn, options = {}) {
    await parallel.map(items, fn, options);
  };

  // malia.parallel.reduce(items, fn, init, options) -- ordered reduce with parallel fetch
  parallel.reduce = async function (items, fn, init, options = {}) {
    // Pre-fetch all items concurrently, then reduce in order
    const fetched = await parallel.map(items, (item) => item, options);
    let acc = init;
    for (let i = 0; i < fetched.length; i++) {
      acc = await fn(acc, fetched[i], i);
    }
    return acc;
  };

  // malia.parallel.race(tasks) -- first to complete wins
  parallel.race = function (tasks) {
    return Promise.race(tasks.map(t => typeof t === "function" ? t() : t));
  };

  // malia.parallel.any(tasks) -- first to succeed wins (ignores rejections)
  parallel.any = function (tasks) {
    return Promise.any(tasks.map(t => typeof t === "function" ? t() : t));
  };

  // malia.parallel.pipeline(source, ...stages) -- concurrent stream transform
  parallel.pipeline = async function (source, ...stages) {
    if (stages.length === 0) return source;

    let input = source;
    for (const stage of stages) {
      if (typeof stage === "function") {
        const ch = chan(64);
        const reader = (async () => {
          try {
            if (input && typeof input[Symbol.asyncIterator] === "function") {
              for await (const chunk of input) {
                await ch.send(await stage(chunk));
              }
            }
          } finally {
            ch.close();
          }
        })();
        reader.catch(() => ch.close());
        input = ch;
      } else if (stage && typeof stage.write === "function") {
        // Writable sink
        if (input && typeof input[Symbol.asyncIterator] === "function") {
          for await (const chunk of input) {
            stage.write(chunk);
          }
          if (typeof stage.end === "function") stage.end();
        }
        return;
      } else {
        input = stage;
      }
    }
    // Collect if no writable sink
    const results = [];
    if (input && typeof input[Symbol.asyncIterator] === "function") {
      for await (const item of input) results.push(item);
    }
    return results;
  };

  parallel.limit = maxConcurrency;

  // -- pool: reusable concurrent executor ------------------------------------

  // malia.parallel.pool(fn, options) -- submit work items to a bounded executor
  //   const fetcher = malia.parallel.pool(url => fetch(url).then(r => r.json()), { concurrency: 5 });
  //   const result = await fetcher.submit("https://api.example.com/data");
  parallel.pool = function (fn, options = {}) {
    const concurrency = options.concurrency || maxConcurrency;
    const waiting = [];
    let active = 0;

    function drain() {
      while (active < concurrency && waiting.length > 0) {
        const { args, resolve, reject } = waiting.shift();
        active++;
        Promise.resolve()
          .then(() => fn(...args))
          .then(resolve, reject)
          .finally(() => { active--; drain(); });
      }
    }

    return {
      submit(...args) {
        return new Promise((resolve, reject) => {
          waiting.push({ args, resolve, reject });
          drain();
        });
      },
      get pending() { return waiting.length; },
      get active() { return active; },
      get concurrency() { return concurrency; },
    };
  };

  // -- mutex / semaphore -- structured concurrency ---------------------------

  function mutex() {
    let locked = false;
    const queue = [];
    return {
      async acquire() {
        if (!locked) { locked = true; return; }
        await new Promise(resolve => queue.push(resolve));
      },
      release() {
        if (queue.length > 0) queue.shift()();
        else locked = false;
      },
      async run(fn) {
        await this.acquire();
        try { return await fn(); }
        finally { this.release(); }
      },
      get locked() { return locked; },
    };
  }

  function semaphore(n) {
    let count = 0;
    const queue = [];
    return {
      async acquire() {
        if (count < n) { count++; return; }
        await new Promise(resolve => queue.push(resolve));
      },
      release() {
        if (queue.length > 0) queue.shift()();
        else count--;
      },
      async run(fn) {
        await this.acquire();
        try { return await fn(); }
        finally { this.release(); }
      },
      get available() { return n - count; },
      get waiting() { return queue.length; },
    };
  }

  // -- batch / retry / timeout / debounce / throttle -------------------------

  async function batch(items, size, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      const r = await Promise.all(chunk.map((item, j) => fn(item, i + j)));
      results.push(...r);
    }
    return results;
  }

  async function retry(fn, options = {}) {
    const { attempts = 3, delay = 100, backoff = 2, signal, onRetry } = options;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      try { return await fn(i); }
      catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          onRetry?.(err, i + 1);
          await new Promise(r => setTimeout(r, delay * Math.pow(backoff, i)));
        }
      }
    }
    throw lastErr;
  }

  function timeout(promise, ms, message) {
    if (typeof promise === "function") promise = promise();
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || `Timeout after ${ms}ms`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function debounce(fn, ms) {
    let timer;
    const debounced = function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer;
    const throttled = function (...args) {
      const now = Date.now();
      const remaining = ms - (now - last);
      clearTimeout(timer);
      if (remaining <= 0) {
        last = now;
        fn.apply(this, args);
      } else {
        timer = setTimeout(() => { last = Date.now(); fn.apply(this, args); }, remaining);
      }
    };
    throttled.cancel = () => clearTimeout(timer);
    return throttled;
  }

  // -- Attach to globals -----------------------------------------------------

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.parallel = parallel;
  globalThis.jse.mutex = mutex;
  globalThis.jse.semaphore = semaphore;
  globalThis.jse.batch = batch;
  globalThis.jse.retry = retry;
  globalThis.jse.timeout = timeout;
  globalThis.jse.debounce = debounce;
  globalThis.jse.throttle = throttle;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
