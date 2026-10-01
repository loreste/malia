// Continuous Runtime Optimizer and WebAssembly JIT acceleration.
((globalThis) => {
  const { core } = globalThis.__bootstrap;
  const { ops } = core;

  if (!globalThis.jse) {
    globalThis.jse = {};
  }

  const isWasmMode = Boolean(ops.op_is_wasm_mode());

  let timerId = null;
  let running = false;
  let lastHeapUsed = 0;

  const optimizer = {
    optimize() {
      try {
        const stats = ops.op_optimizer_compact_memory();
        lastHeapUsed = stats.heap_used;
        return {
          passes: stats.passes,
          memoryReclaimedBytes: Number(stats.memory_reclaimed_bytes),
          heapUsed: stats.heap_used,
          heapTotal: stats.heap_total,
          heapLimit: stats.heap_limit,
          mode: stats.mode,
          isWasm: stats.is_wasm,
        };
      } catch (err) {
        return null;
      }
    },

    stats() {
      try {
        const s = ops.op_optimizer_stats();
        return {
          passes: s.passes,
          memoryReclaimedBytes: Number(s.memory_reclaimed_bytes),
          heapUsed: s.heap_used,
          heapTotal: s.heap_total,
          heapLimit: s.heap_limit,
          mode: s.mode,
          isWasm: s.is_wasm,
          active: running,
        };
      } catch (err) {
        return null;
      }
    },

    heap() {
      try {
        const h = ops.op_optimizer_heap_stats();
        return {
          used: h.used,
          total: h.total,
          limit: h.limit,
          external: h.external,
        };
      } catch (err) {
        return null;
      }
    },

    start(intervalMs = 1500) {
      if (running) return;
      running = true;
      timerId = setInterval(() => {
        try {
          const heap = ops.op_optimizer_heap_stats();
          // If heap usage increased significantly or has fragmentation, compact
          if (heap.total > heap.used * 1.3 || (lastHeapUsed > 0 && heap.used > lastHeapUsed + 1024 * 1024)) {
            optimizer.optimize();
          }
        } catch (_) {}
      }, intervalMs);

      if (timerId && typeof timerId.unref === "function") {
        timerId.unref();
      }
    },

    stop() {
      if (!running) return;
      running = false;
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  };

  const wasm = {
    get isWasm() {
      return ops.op_is_wasm_mode();
    },

    compile(operation = "add") {
      const opName = typeof operation === "string" ? operation : (operation && operation.op ? operation.op : "add");
      const bytes = ops.op_wasm_synthesize_fn(opName);
      const mod = new WebAssembly.Module(bytes);
      const instance = new WebAssembly.Instance(mod);
      const fn = instance.exports.compute;
      fn.instance = instance;
      fn.module = mod;
      return fn;
    },

    compileApp(entryPath, outputPath) {
      if (!entryPath) throw new Error("entryPath is required for compileApp");
      const out = outputPath || entryPath.replace(/\.(js|ts|mjs|cjs)$/, "") + ".wasm";
      const res = ops.op_wasm_compile_app(entryPath, out);
      return {
        success: res.success,
        entry: res.entry,
        output: res.output,
        bytesWritten: res.bytes_written,
      };
    },

    stats() {
      return {
        isWasm: ops.op_is_wasm_mode(),
        optimizer: optimizer.stats(),
      };
    },
  };

  globalThis.jse.optimizer = optimizer;
  globalThis.jse.wasm = wasm;

  // Explicit opt-in only; low_memory_notification requests GC, not JS-to-Wasm compilation.
  try {
    if (typeof process !== "undefined" && process.env && process.env.JSE_OPTIMIZE === "1") {
      optimizer.start(1000);
    }
  } catch (_) {}
})(globalThis);

