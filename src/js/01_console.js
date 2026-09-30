// console, backed by the builtin op_print op and structured logger ops.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;
  const print = (msg, isErr) => ops.op_print(msg + "\n", isErr);
  const timers = new Map();

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
    dir(value, options) {
      print(__jse.inspect(value, { customInspect: false, ...options }), false);
    },
    group() {},
    groupEnd() {},
    clear() {},
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
