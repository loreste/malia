// Timers: sleep()/setTimeout/setInterval built on a JS-side min-heap of
// deadline buckets with a single armed op (op_sleep_until) for the earliest
// deadline. Entries sharing a deadline (e.g. 10k sleep(50) calls) land in
// one bucket, so the whole batch costs one heap insert and one op
// round-trip. The armed op is re-armed when the earliest deadline changes:
// op_timer_poke wakes it early (earlier deadline pushed, or a timer
// cleared) and the pump recomputes.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

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

  async function pump() {
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
        await ops.op_sleep_until(top.deadline);
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

  globalThis.sleep = (ms) => {
    const deadline = Math.floor(ops.op_now() + Math.max(ms, 0));
    let promise = sleepCache.get(deadline);
    if (!promise) {
      promise = new Promise((resolve) => {
        schedule({
          deadline,
          run: () => {
            sleepCache.delete(deadline);
            resolve();
          },
          cancelled: false,
        });
      });
      sleepCache.set(deadline, promise);
    }
    return promise;
  };

  let nextId = 1;
  const timers = new Map();

  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = nextId++;
    const callback = typeof fn === "function" ? fn : () => eval(fn);
    const entry = {
      deadline: ops.op_now() + Math.max(ms, 0),
      run: () => {
        timers.delete(id);
        callback(...args);
      },
      cancelled: false,
    };
    timers.set(id, entry);
    schedule(entry);
    return id;
  };

  globalThis.setInterval = (fn, ms = 0, ...args) => {
    const id = nextId++;
    // Node clamps interval delays to >= 1ms; it also keeps a 0ms interval
    // from busy-spinning the pump without ever yielding to the event loop.
    const interval = Math.max(ms, 1);
    const entry = {
      deadline: ops.op_now() + interval,
      run: () => {
        if (entry.cancelled) return;
        fn(...args);
        if (!entry.cancelled && timers.has(id)) {
          entry.deadline = ops.op_now() + interval;
          schedule(entry);
        }
      },
      cancelled: false,
    };
    timers.set(id, entry);
    schedule(entry);
    return id;
  };

  const clear = (id) => {
    const entry = timers.get(id);
    if (entry) {
      entry.cancelled = true;
      timers.delete(id);
      // Wake the pump so a cleared earliest timer does not hold the event
      // loop open until its (now dead) deadline.
      ops.op_timer_poke();
    }
  };
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;

  // setImmediate: fires on the next event-loop turn (deadline already
  // elapsed, so the pump runs it as soon as it is scheduled).
  globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = globalThis.clearTimeout;

  globalThis.performance = globalThis.performance || {
    now: () => ops.op_now(),
    timeOrigin: Date.now() - ops.op_now(),
  };
})(globalThis);
