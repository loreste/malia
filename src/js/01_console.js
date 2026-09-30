// console, backed by the builtin op_print op and structured logger ops.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  let groupDepth = 0;
  const print = (msg, isErr) => {
    const indent = groupDepth > 0 ? "  ".repeat(groupDepth) : "";
    ops.op_print(indent + msg + "\n", isErr);
  };
  const timers = new Map();
  const counters = new Map();

  const console = {
    log(...args) {
      if (ops.op_log_get_format() === 1) {
        ops.op_log(1, "app", __jse.format(...args));
      } else {
        print(__jse.format(...args), false);
      }
    },
    info(...args) {
      if (ops.op_log_get_format() === 1) {
        ops.op_log(1, "app", __jse.format(...args));
      } else {
        print(__jse.format(...args), false);
      }
    },
    debug(...args) {
      if (ops.op_log_get_format() === 1) {
        ops.op_log(0, "app", __jse.format(...args));
      } else if (ops.op_log_get_level() <= 0) {
        print(__jse.format(...args), false);
      }
    },
    warn(...args) {
      if (ops.op_log_get_format() === 1) {
        ops.op_log(2, "app", __jse.format(...args));
      } else {
        print(__jse.format(...args), true);
      }
    },
    error(...args) {
      if (ops.op_log_get_format() === 1) {
        ops.op_log(3, "app", __jse.format(...args));
      } else {
        print(__jse.format(...args), true);
      }
    },
    trace(...args) {
      const err = new Error();
      const stack = (err.stack || "").split("\n").slice(1).join("\n");
      print(__jse.format(...args) + "\n" + stack, true);
    },
    assert(condition, ...args) {
      if (!condition) {
        print("Assertion failed" + (args.length ? ": " + __jse.format(...args) : ""), true);
      }
    },
    time(label = "default") {
      timers.set(label, ops.op_now());
    },
    timeEnd(label = "default") {
      const start = timers.get(label);
      if (start !== undefined) {
        timers.delete(label);
        print(label + ": " + (ops.op_now() - start).toFixed(3) + "ms", false);
      }
    },
    timeLog(label = "default", ...args) {
      const start = timers.get(label);
      if (start !== undefined) {
        const elapsed = (ops.op_now() - start).toFixed(3);
        print(label + ": " + elapsed + "ms" + (args.length ? " " + __jse.format(...args) : ""), false);
      }
    },
    count(label = "default") {
      const c = (counters.get(label) || 0) + 1;
      counters.set(label, c);
      print(label + ": " + c, false);
    },
    countReset(label = "default") {
      counters.delete(label);
    },
    table(data, columns) {
      if (data === null || data === undefined || typeof data !== "object") {
        print(String(data), false);
        return;
      }
      // Collect rows
      const rows = [];
      const isArray = Array.isArray(data);
      const keys = isArray ? Object.keys(data) : Object.keys(data);
      const colSet = new Set();
      for (const key of keys) {
        const val = data[key];
        if (val !== null && typeof val === "object" && !Array.isArray(val)) {
          for (const k of Object.keys(val)) colSet.add(k);
        }
      }
      const cols = columns || (colSet.size > 0 ? [...colSet] : null);
      if (cols) {
        // Object rows
        const header = ["(index)", ...cols];
        const rowData = [];
        for (const key of keys) {
          const val = data[key];
          const row = [String(key)];
          for (const col of cols) {
            const cell = val !== null && typeof val === "object" ? val[col] : undefined;
            row.push(cell === undefined ? "" : String(cell));
          }
          rowData.push(row);
        }
        // Calculate column widths
        const widths = header.map((h, i) => {
          let max = h.length;
          for (const row of rowData) if (row[i] && row[i].length > max) max = row[i].length;
          return max;
        });
        const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
        const sep = widths.map(w => "-".repeat(w + 2)).join("+");
        print(widths.map((w, i) => " " + pad(header[i], w) + " ").join("|"), false);
        print(sep, false);
        for (const row of rowData) {
          print(widths.map((w, i) => " " + pad(row[i] || "", w) + " ").join("|"), false);
        }
      } else {
        // Simple key-value
        const header = ["(index)", "Values"];
        const rowData = keys.map(k => [String(k), String(data[k])]);
        const widths = header.map((h, i) => {
          let max = h.length;
          for (const row of rowData) if (row[i] && row[i].length > max) max = row[i].length;
          return max;
        });
        const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
        const sep = widths.map(w => "-".repeat(w + 2)).join("+");
        print(widths.map((w, i) => " " + pad(header[i], w) + " ").join("|"), false);
        print(sep, false);
        for (const row of rowData) {
          print(widths.map((w, i) => " " + pad(row[i] || "", w) + " ").join("|"), false);
        }
      }
    },
    dir(value, options) {
      print(__jse.inspect(value, { customInspect: false, ...options }), false);
    },
    group(...args) {
      if (args.length) print(__jse.format(...args), false);
      groupDepth++;
    },
    groupCollapsed(...args) {
      if (args.length) print(__jse.format(...args), false);
      groupDepth++;
    },
    groupEnd() {
      if (groupDepth > 0) groupDepth--;
    },
    clear() {
      ops.op_print("\x1b[2J\x1b[H", false);
    },
  };

  globalThis.console = console;

  // Application-level structured logger API on globalThis.jse.log
  if (!globalThis.jse) {
    globalThis.jse = {};
  }

  globalThis.jse.log = {
    debug(target, ...args) {
      ops.op_log(0, String(target), args.map(String).join(" "));
    },
    info(target, ...args) {
      ops.op_log(1, String(target), args.map(String).join(" "));
    },
    warn(target, ...args) {
      ops.op_log(2, String(target), args.map(String).join(" "));
    },
    error(target, ...args) {
      ops.op_log(3, String(target), args.map(String).join(" "));
    },
    get level() {
      const lvl = ops.op_log_get_level();
      return ["debug", "info", "warn", "error", "none"][lvl] || "info";
    },
    set level(name) {
      const map = { debug: 0, trace: 0, info: 1, warn: 2, warning: 2, error: 3, none: 4, off: 4 };
      const val = map[String(name).toLowerCase()];
      if (val !== undefined) ops.op_log_set_level(val);
    },
    get format() {
      return ops.op_log_get_format() === 1 ? "json" : "text";
    },
    set format(fmt) {
      ops.op_log_set_format(String(fmt).toLowerCase() === "json" ? 1 : 0);
    },
    get http() {
      return ops.op_log_is_http_enabled();
    },
    set http(enabled) {
      ops.op_log_set_http_enabled(Boolean(enabled));
    },
    configure(options = {}) {
      if (options.level !== undefined) this.level = options.level;
      if (options.format !== undefined) this.format = options.format;
      if (options.http !== undefined) this.http = options.http;
    },
  };
})(globalThis);
