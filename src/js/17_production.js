// src/js/17_production.js - Enterprise Production Telemetry, Health Checks, and Graceful Shutdown
((globalThis) => {
  const { core } = globalThis.__bootstrap;
  const { ops } = core;

  if (!globalThis.jse) {
    globalThis.jse = {};
  }

  const shutdownHooks = [];
  let shuttingDown = false;

  function onShutdown(fn) {
    if (typeof fn !== "function") throw new TypeError("Shutdown hook must be a function");
    shutdownHooks.push(fn);
  }

  async function gracefulShutdown(options = {}) {
    if (shuttingDown) return;
    shuttingDown = true;

    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 5000;
    if (globalThis.jse.log && typeof globalThis.jse.log.info === "function") {
      globalThis.jse.log.info("[production] Graceful shutdown initiated, running hooks...");
    }

    const shutdownPromise = (async () => {
      for (const hook of shutdownHooks) {
        try {
          await hook();
        } catch (err) {
          if (globalThis.jse.log && typeof globalThis.jse.log.error === "function") {
            globalThis.jse.log.error(`[production] Shutdown hook error: ${err?.message || err}`);
          }
        }
      }
    })();

    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));

    await Promise.race([shutdownPromise, timeoutPromise]);
    process.exit(0);
  }

  // Intercept SIGTERM and SIGINT for graceful shutdown in containers/production
  if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("SIGTERM", () => {
      gracefulShutdown({ timeoutMs: 10000 });
    });
    process.on("SIGINT", () => {
      gracefulShutdown({ timeoutMs: 5000 });
    });
  }

  function getMetrics() {
    const raw = ops.op_production_metrics();
    let mem = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 };
    try {
      const sysMem = ops.op_meminfo ? ops.op_meminfo() : null;
      const heap = ops.op_optimizer_heap_stats ? ops.op_optimizer_heap_stats() : null;
      mem = {
        rss: sysMem ? sysMem.rss : 0,
        heapTotal: heap ? heap.total : 0,
        heapUsed: heap ? heap.used : 0,
        external: heap ? heap.external : 0,
      };
    } catch (_) {}

    const kvStats = globalThis.jse.kv ? globalThis.jse.kv.stats() : null;
    return {
      uptime: raw.uptime_secs,
      requestsTotal: raw.requests_total,
      activeConnections: raw.active_connections,
      memory: mem,
      kv: kvStats,
    };
  }

  getMetrics.prometheus = function () {
    const m = getMetrics();
    return [
      "# HELP jse_uptime_seconds Process uptime in seconds",
      "# TYPE jse_uptime_seconds gauge",
      `jse_uptime_seconds ${m.uptime.toFixed(3)}`,
      "# HELP jse_requests_total Total number of HTTP requests processed",
      "# TYPE jse_requests_total counter",
      `jse_requests_total ${m.requestsTotal}`,
      "# HELP jse_active_connections Current active HTTP connections",
      "# TYPE jse_active_connections gauge",
      `jse_active_connections ${m.activeConnections}`,
      "# HELP jse_rss_bytes Physical resident set size in bytes",
      "# TYPE jse_rss_bytes gauge",
      `jse_rss_bytes ${m.memory.rss}`,
      "# HELP jse_heap_used_bytes V8 active heap used in bytes",
      "# TYPE jse_heap_used_bytes gauge",
      `jse_heap_used_bytes ${m.memory.heapUsed}`,
      "# HELP jse_heap_total_bytes V8 total heap allocated in bytes",
      "# TYPE jse_heap_total_bytes gauge",
      `jse_heap_total_bytes ${m.memory.heapTotal}`,
    ].join("\n") + "\n";
  };

  function healthCheck() {
    return (req) => {
      const data = {
        status: "ok",
        uptime: process.uptime ? process.uptime() : ops.op_production_metrics().uptime_secs,
        timestamp: new Date().toISOString(),
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  globalThis.jse.metrics = getMetrics;
  globalThis.jse.onShutdown = onShutdown;
  globalThis.jse.gracefulShutdown = gracefulShutdown;
  globalThis.jse.healthCheck = healthCheck;
  globalThis.jse.production = {
    metrics: getMetrics,
    onShutdown,
    gracefulShutdown,
    healthCheck,
  };
})(globalThis);
