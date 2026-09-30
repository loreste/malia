// Timers: sleep()/setTimeout/setInterval built on a JS-side min-heap of
// deadline buckets with a single armed op (op_sleep_until) for the earliest
// deadline. Entries sharing a deadline (e.g. 10k sleep(50) calls) land in
// one bucket, so the whole batch costs one heap insert and one op
// round-trip. The armed op is re-armed when the earliest deadline changes:
// op_timer_poke wakes it early (earlier deadline pushed, or a timer
// cleared) and the pump recomputes. Callbacks never run in the turn that
// scheduled them: the pump starts after a zero-length op, so microtasks and
// nextTicks go first, as in Node.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  const core = Deno.core;

  // Live entries that keep the process alive (not unref'd). When it drops
  // to 0 the armed sleep op is unref'd so the event loop can exit.
  let refedCount = 0;

  // ---- Binary min-heap of buckets keyed by bucket.deadline ----------------
  // bucket = { deadline, entries: [{ run, cancelled }] }
  const heap = [];
  const buckets = new Map(); // deadline -> bucket

  function heapPush(bucket) {
    heap.push(bucket);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].deadline <= heap[i].deadline) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left].deadline < heap[smallest].deadline) smallest = left;
        if (right < heap.length && heap[right].deadline < heap[smallest].deadline) smallest = right;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }

  // ---- Pump --------------------------------------------------------------
  // While the heap is non-empty the pump either fires due buckets or waits
  // on a single op_sleep_until for the earliest deadline. The pending op is
  // also what keeps the event loop alive while timers are outstanding.
  let pumping = false;
  let armedDeadline = Infinity;
  let armedPromise = null;

  function syncArmedRef() {
    if (armedPromise === null) return;
    if (refedCount > 0) core.refOpPromise(armedPromise);
    else core.unrefOpPromise(armedPromise);
  }

  async function pump() {
    // Yield one event-loop turn before firing anything. The deferred op
    // resolves on the next tick even though it is ready immediately.
    armedPromise = ops.op_void_async_deferred();
    syncArmedRef();
    await armedPromise;
    armedPromise = null;
    while (heap.length > 0) {
      const top = heap[0];
      // Drop buckets whose entries were all cancelled before arming on
      // their deadline -- otherwise a cleared far timer would hold the
      // event loop open for no reason.
      let anyLive = false;
      for (const entry of top.entries) {
        if (!entry.cancelled) {
          anyLive = true;
          break;
        }
      }
      if (!anyLive) {
        heapPop();
        buckets.delete(top.deadline);
        continue;
      }
      const now = ops.op_now();
      if (top.deadline > now) {
        armedDeadline = top.deadline;
        armedPromise = ops.op_sleep_until(top.deadline);
        syncArmedRef();
        await armedPromise;
        armedPromise = null;
        // Woke up: deadline reached, or poked (earlier entry / clear).
        // Loop around and recompute from the current heap top.
        continue;
      }
      armedDeadline = Infinity;
      heapPop();
      buckets.delete(top.deadline);
      for (const entry of top.entries) {
        if (!entry.cancelled) {
          try {
            if (!entry.repeat) setEntryRef(entry, false);
            entry.run();
          } catch (err) {
            if (!globalThis.process?._dispatchException?.(err)) {
              ops.op_log(3, "timer", `Uncaught exception in timer: ${err?.stack || err}`);
              throw err;
            }
          }
        }
      }
    }
    armedDeadline = Infinity;
    pumping = false;
  }

  function setEntryRef(entry, refed) {
    const counted = entry.refed && !entry.cancelled;
    if (counted === refed) return;
    entry.refed = refed;
    refedCount += refed ? 1 : -1;
    syncArmedRef();
  }

  function schedule(entry) {
    // Quantize to 1ms (timer resolution): makes same-batch sleeps share a
    // bucket -- op_now() has sub-ms precision which would otherwise give
    // every entry its own bucket. Flooring (standard timer slack, <=1ms)
    // compensates tokio's round-up-to-next-tick wake granularity so the
    // average fire time lands on the requested deadline.
    entry.deadline = Math.floor(entry.deadline);
    const bucket = buckets.get(entry.deadline);
    if (bucket) {
      bucket.entries.push(entry);
      // Same deadline as an existing bucket: never earlier than the armed
      // deadline, so no poke and no pump state change needed... unless the
      // pump already fired that bucket and deleted it (handled above), or
      // the pump is not running at all.
      if (!pumping) {
        pumping = true;
        pump();
      }
      return;
    }
    const newBucket = { deadline: entry.deadline, entries: [entry] };
    buckets.set(entry.deadline, newBucket);
    heapPush(newBucket);
    if (entry.deadline < armedDeadline) {
      // New earliest: wake the pump to re-arm. (No pending wait => cheap
      // stored permit consumed on the next arm, harmless.)
      ops.op_timer_poke();
    }
    if (!pumping) {
      pumping = true;
      pump();
    }
  }

  // ---- Public API ---------------------------------------------------------

  // Sleeps with the same (1ms-quantized) deadline share one promise and one
  // heap entry: awaiting the same promise N times is much cheaper than
  // allocating and resolving N promises.
  const sleepCache = new Map(); // deadline -> promise

  globalThis.sleep = (ms, options) => {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    const deadline = Math.floor(ops.op_now() + Math.max(ms, 0));
    // Without an AbortSignal, shared-deadline optimization applies.
    if (!signal) {
      let promise = sleepCache.get(deadline);
      if (!promise) {
        promise = new Promise((resolve) => {
          const entry = {
            deadline,
            run: () => { sleepCache.delete(deadline); resolve(); },
            cancelled: false,
            refed: false,
          };
          setEntryRef(entry, true);
          schedule(entry);
        });
        sleepCache.set(deadline, promise);
      }
      return promise;
    }
    // Cancellable sleep: unique promise + abort listener.
    return new Promise((resolve, reject) => {
      const entry = {
        deadline,
        run: () => { signal.removeEventListener("abort", onAbort); resolve(); },
        cancelled: false,
        refed: false,
      };
      function onAbort() {
        entry.cancelled = true;
        setEntryRef(entry, false);
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
      setEntryRef(entry, true);
      schedule(entry);
    });
  };

  // Node clamps delays outside [1, 2^31 - 1] to 1ms.
  function delayOf(ms) {
    ms = Number(ms);
    return ms >= 1 && ms <= 2147483647 ? ms : 1;
  }

  let nextId = 1;
  const timers = new Map(); // id -> Timeout
  const kEntry = Symbol("entry");

  // Node's Timeout object; numeric coercion gives the id, so
  // clearTimeout(+timer) and timers used as map keys keep working.
  class Timeout {
    constructor(callback, ms, args, repeat) {
      this._id = nextId++;
      this._idleTimeout = ms;
      this._onTimeout = callback;
      this._repeat = repeat ? ms : null;
      const entry = {
        deadline: ops.op_now() + ms,
        repeat,
        run: () => {
          if (repeat) {
            callback(...args);
            // Read the entry through `this`: refresh() may have replaced it.
            const current = this[kEntry];
            if (!current.cancelled && timers.has(this._id)) {
              current.deadline = ops.op_now() + ms;
              schedule(current);
            }
          } else {
            timers.delete(this._id);
            callback(...args);
          }
        },
        cancelled: false,
        refed: false,
      };
      this[kEntry] = entry;
      timers.set(this._id, this);
      setEntryRef(entry, true);
      schedule(entry);
    }

    ref() {
      if (!this[kEntry].cancelled) setEntryRef(this[kEntry], true);
      return this;
    }

    unref() {
      setEntryRef(this[kEntry], false);
      return this;
    }

    hasRef() {
      return this[kEntry].refed;
    }

    refresh() {
      const entry = this[kEntry];
      if (entry.cancelled) return this;
      // Re-arm from now: retire the old heap entry, schedule a fresh one.
      const fresh = { ...entry, deadline: ops.op_now() + this._idleTimeout, cancelled: false, refed: false };
      const refed = entry.refed;
      setEntryRef(entry, false);
      entry.cancelled = true;
      this[kEntry] = fresh;
      fresh.run = entry.run;
      setEntryRef(fresh, refed);
      schedule(fresh);
      return this;
    }

    close() {
      clear(this);
      return this;
    }

    [Symbol.toPrimitive]() {
      return this._id;
    }

    [Symbol.dispose]() {
      clear(this);
    }
  }

  globalThis.setTimeout = (fn, ms, ...args) => {
    const callback = typeof fn === "function" ? fn : () => (0, eval)(String(fn));
    return new Timeout(callback, delayOf(ms), args, false);
  };

  globalThis.setInterval = (fn, ms, ...args) => new Timeout(fn, delayOf(ms), args, true);

  function clear(timer) {
    const t = timer instanceof Timeout ? timer : timers.get(Number(timer));
    if (!t || !timers.has(t._id)) return;
    timers.delete(t._id);
    const entry = t[kEntry];
    setEntryRef(entry, false);
    entry.cancelled = true;
    // Wake the pump so a cleared earliest timer does not hold the event
    // loop open until its (now dead) deadline.
    ops.op_timer_poke();
  }
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;

  // setImmediate: a FIFO drained once per event-loop turn, after I/O and
  // before later timers. Immediates queued while draining run next turn.
  let immediateQueue = [];
  let immediatePromise = null;
  let immediateRefs = 0;

  class Immediate {
    constructor(fn, args) {
      this._onImmediate = fn;
      this._args = args;
      this._cleared = false;
      this._refed = true;
      immediateRefs++;
    }

    ref() {
      if (!this._refed && !this._cleared) {
        this._refed = true;
        immediateRefs++;
        syncImmediateRef();
      }
      return this;
    }

    unref() {
      if (this._refed) {
        this._refed = false;
        immediateRefs--;
        syncImmediateRef();
      }
      return this;
    }

    hasRef() {
      return this._refed;
    }

    [Symbol.dispose]() {
      clearImmediate(this);
    }
  }

  function syncImmediateRef() {
    if (immediatePromise === null) return;
    if (immediateRefs > 0) core.refOpPromise(immediatePromise);
    else core.unrefOpPromise(immediatePromise);
  }

  function runImmediates() {
    immediatePromise = null;
    const batch = immediateQueue;
    immediateQueue = [];
    for (const imm of batch) {
      if (imm._cleared) continue;
      imm._cleared = true;
      if (imm._refed) {
        imm._refed = false;
        immediateRefs--;
      }
      try {
        imm._onImmediate(...imm._args);
      } catch (err) {
        if (!globalThis.process?._dispatchException?.(err)) throw err;
      }
    }
    if (immediateQueue.length > 0) armImmediates();
  }

  function armImmediates() {
    immediatePromise = ops.op_void_async_deferred();
    syncImmediateRef();
    immediatePromise.then(runImmediates);
  }

  globalThis.setImmediate = (fn, ...args) => {
    const imm = new Immediate(fn, args);
    immediateQueue.push(imm);
    if (immediatePromise === null) armImmediates();
    return imm;
  };

  globalThis.clearImmediate = (imm) => {
    if (!(imm instanceof Immediate) || imm._cleared) return;
    imm._cleared = true;
    imm.unref();
  };

  // Exposed for node:timers.
  globalThis.__jse.Timeout = Timeout;
  globalThis.__jse.Immediate = Immediate;

  globalThis.performance = globalThis.performance || {
    now: () => ops.op_now(),
    timeOrigin: Date.now() - ops.op_now(),
  };
})(globalThis);
