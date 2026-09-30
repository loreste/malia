// process global: argv/env/cwd/exit/nextTick and friends.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  // env/argv are read lazily: at snapshot-build time these ops would bake
  // the build machine's environment into the blob, so defer the first read
  // until a runtime actually touches them.
  const envTarget = {};
  let envInitialized = false;
  // Windows env keys are case-insensitive (`Path` and `PATH` are the same).
  let envIsWin = null;
  function envKey(target, prop) {
    if (typeof prop !== "string") return prop;
    if (envIsWin === null) envIsWin = ops.op_platform() === "win32";
    if (!envIsWin) return prop;
    const lower = prop.toLowerCase();
    for (const key of Object.keys(target)) {
      if (key.toLowerCase() === lower) return key;
    }
    return prop;
  }
  function ensureEnvInitialized() {
    if (!envInitialized) {
      try {
        const vars = ops.op_env();
        if (vars && vars.length > 0) {
          for (const [k, v] of vars) {
            const key = envKey(envTarget, k);
            if (!(key in envTarget)) envTarget[key] = v;
          }
          envInitialized = true;
        }
      } catch (_) {}
    }
  }

  const envProxy = new Proxy(envTarget, {
    get(target, prop) {
      if (typeof prop === "symbol") return target[prop];
      ensureEnvInitialized();
      return target[envKey(target, prop)];
    },
    set(target, prop, value) {
      ensureEnvInitialized();
      target[envKey(target, prop)] = String(value);
      return true;
    },
    has(target, prop) {
      ensureEnvInitialized();
      return envKey(target, prop) in target;
    },
    ownKeys(target) {
      ensureEnvInitialized();
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      ensureEnvInitialized();
      return Reflect.getOwnPropertyDescriptor(target, envKey(target, prop));
    },
    deleteProperty(target, prop) {
      ensureEnvInitialized();
      delete target[envKey(target, prop)];
      return true;
    },
  });

  function loadEnv() {
    return envProxy;
  }
  let argvCache = null;
  function loadArgv() {
    if (argvCache === null) argvCache = ops.op_args();
    return argvCache;
  }

  // pid / ppid / isTTY / memory are getters: reading them during the
  // snapshot build would bake the build machine into the blob.
  function stdioStream(fd, isErr) {
    return {
      fd,
      write(chunk) {
        let text;
        if (typeof chunk === "string") {
          text = chunk;
        } else if (typeof TextDecoder !== "undefined") {
          text = new TextDecoder().decode(chunk);
        } else {
          text = String(chunk);
        }
        ops.op_print(text, isErr);
        return true;
      },
      get isTTY() {
        return ops.op_isatty(fd);
      },
    };
  }

  const listeners = new Map();
  function listFor(type) {
    let list = listeners.get(type);
    if (!list) {
      list = [];
      listeners.set(type, list);
    }
    return list;
  }
  function on(type, fn) {
    if (type === "message") initIpc();
    listFor(type).push({ fn, once: false });
    return process;
  }
  function once(type, fn) {
    if (type === "message") initIpc();
    listFor(type).push({ fn, once: true });
    return process;
  }
  function off(type, fn) {
    const list = listeners.get(type);
    if (!list) return process;
    const idx = list.findIndex((entry) => entry.fn === fn);
    if (idx >= 0) list.splice(idx, 1);
    return process;
  }
  function emit(type, ...args) {
    const list = listeners.get(type);
    if (!list || list.length === 0) return false;
    for (const entry of list.slice()) {
      if (entry.once) {
        const idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
      }
      entry.fn(...args);
    }
    return true;
  }
  function listenerCount(type) {
    const list = listeners.get(type);
    return list ? list.length : 0;
  }
  function rawListeners(type) {
    const list = listeners.get(type);
    return list ? list.map((entry) => entry.fn) : [];
  }
  function _dispatchException(err) {
    if (listenerCount("uncaughtException") > 0) {
      try {
        emit("uncaughtException", err, "uncaughtException");
        return true;
      } catch (handlerErr) {
        ops.op_log(3, "runtime", `Error in uncaughtException listener: ${handlerErr?.stack || handlerErr}`);
        return false;
      }
    }
    return false;
  }
  function _dispatchUnhandledRejection(reason, promise) {
    if (listenerCount("unhandledRejection") > 0) {
      try {
        emit("unhandledRejection", reason, promise);
        return true;
      } catch (handlerErr) {
        ops.op_log(3, "runtime", `Error in unhandledRejection listener: ${handlerErr?.stack || handlerErr}`);
        return false;
      }
    }
    return false;
  }

  let bootedAt = null;
  function uptime() {
    const now = ops.op_now();
    if (bootedAt === null) bootedAt = now;
    return (now - bootedAt) / 1000;
  }

  function memoryUsage() {
    const heap = ops.op_memory_usage();
    const mem = ops.op_meminfo();
    return {
      rss: mem.rss,
      heapTotal: heap.heapTotal,
      heapUsed: heap.heapUsed,
      external: heap.external,
      arrayBuffers: 0,
    };
  }

  function hrtime(prev) {
    const now = ops.op_now() * 1e6; // microseconds
    const sec = Math.floor(now / 1e6);
    const nsec = Math.floor((now % 1e6) * 1000);
    if (prev) {
      let ds = sec - prev[0];
      let dn = nsec - prev[1];
      if (dn < 0) {
        ds -= 1;
        dn += 1e9;
      }
      return [ds, dn];
    }
    return [sec, nsec];
  }
  hrtime.bigint = () => BigInt(Math.floor(ops.op_now() * 1e6));

  // process.emitWarning(warning[, type | options][, code]): emits 'warning'
  // and prints `(node:PID) [code] Type: message` unless --no-warnings.
  function emitWarning(warning, typeOrOptions, code) {
    let type = "Warning";
    let detail;
    if (typeOrOptions && typeof typeOrOptions === "object") {
      type = typeOrOptions.type ?? type;
      code = typeOrOptions.code;
      detail = typeOrOptions.detail;
    } else if (typeof typeOrOptions === "string") {
      type = typeOrOptions;
    }
    if (typeof warning === "string") {
      const err = new Error(warning);
      err.name = String(type);
      if (code !== undefined) err.code = code;
      if (detail !== undefined) err.detail = detail;
      warning = err;
    } else if (!(warning instanceof Error)) {
      throw __jse.invalidArgType("warning", "string or an instance of Error", warning);
    }
    if (warning.name === "DeprecationWarning" && process.noDeprecation) return;
    queueMicrotask(() => {
      emit("warning", warning);
      if (ops.op_no_warnings() || process.env.NODE_NO_WARNINGS === "1") return;
      const prefix = warning.code ? `[${warning.code}] ` : "";
      let text = `(node:${process.pid}) ${prefix}${warning.name}: ${warning.message}`;
      if (warning.detail) text += `\n${warning.detail}`;
      ops.op_print(text + "\n", true);
    });
  }

  // process.exit() with no argument uses process.exitCode, as in Node.
  function exit(code) {
    const status = (code ?? process.exitCode ?? 0) | 0;
    process.exitCode = status;
    try {
      emit("exit", status);
    } catch {
      // A throwing listener still ends the process.
    }
    ops.op_exit(status);
  }

  const process = {
    get argv() {
      return loadArgv();
    },
    get argv0() {
      return loadArgv()[0] || "jse";
    },
    get env() {
      return loadEnv();
    },
    stdout: stdioStream(1, false),
    stderr: stdioStream(2, true),
    stdin: {
      fd: 0,
      get isTTY() {
        return ops.op_isatty(0);
      },
    },
    get pid() {
      return ops.op_pid();
    },
    get ppid() {
      return ops.op_ppid();
    },
    platform: ops.op_platform(),
    arch: ops.op_arch(),
    title: "node",
    version: "v26.0.0",
    versions: { malia: "0.1.0", jse: "0.1.0", v8: "15.0.4", node: "26.0.0" },
    release: {
      name: "node",
      lts: "Iron",
      sourceUrl: "",
      headersUrl: "",
      libUrl: "",
    },
    exitCode: undefined,
    emitWarning,
    umask: (mask) => ops.op_umask(mask === undefined ? -1 : typeof mask === "string" ? parseInt(mask, 8) : mask),
    cwd: () => ops.op_cwd(),
    chdir: (dir) => ops.op_chdir(String(dir)),
    exit,
    nextTick: (cb, ...args) => {
      queueMicrotask(() => {
        try {
          cb(...args);
        } catch (err) {
          if (!_dispatchException(err)) {
            ops.op_log(3, "runtime", `Uncaught exception in nextTick: ${err?.stack || err}`);
            throw err;
          }
        }
      });
    },
    hrtime,
    uptime,
    memoryUsage,
    on,
    off,
    once,
    emit,
    addListener: on,
    removeListener: off,
    listenerCount,
    rawListeners,
    listeners: rawListeners,
    _dispatchException,
    _dispatchUnhandledRejection,
    get execPath() {
      try {
        return ops.op_exec_path();
      } catch (_) {
        return "jse";
      }
    },
    get execArgv() {
      try {
        return ops.op_exec_argv();
      } catch (_) {
        return [];
      }
    },
    features: {},
    config: { variables: {} },
    connected: false,
  };

  let ipcClientId = null;
  let ipcConnected = false;
  const pendingIpcMessages = [];

  function initIpc() {
    if (ipcClientId !== null || ipcConnected) return;
    const portStr = process.env.NODE_CHANNEL_PORT;
    if (!portStr) return;
    const port = Number(portStr);
    if (!port || isNaN(port)) return;

    ops.op_ipc_client_connect(port).then(
      (clientId) => {
        ipcClientId = clientId;
        ipcConnected = true;
        process.connected = true;
        const uniqueId = process.env.NODE_UNIQUE_ID;
        const onlinePayload = JSON.stringify({
          cmd: "NODE_CLUSTER",
          act: "online",
          id: uniqueId ? Number(uniqueId) : undefined,
        });
        ops.op_ipc_client_send(clientId, onlinePayload);
        while (pendingIpcMessages.length > 0) {
          const item = pendingIpcMessages.shift();
          try {
            const ok = ops.op_ipc_client_send(clientId, JSON.stringify(item.message));
            if (item.cb) queueMicrotask(() => item.cb(ok ? null : new Error("Send failed")));
          } catch (err) {
            if (item.cb) queueMicrotask(() => item.cb(err));
          }
        }
        pollLoop(clientId);
      },
      () => {},
    );
  }

  function pollLoop(clientId) {
    ops.op_ipc_client_poll(clientId).then(
      (line) => {
        if (line === null || line === undefined) {
          ipcConnected = false;
          process.connected = false;
          process.emit("disconnect");
          return;
        }
        try {
          const msg = JSON.parse(line);
          process.emit("message", msg);
        } catch (_) {}
        pollLoop(clientId);
      },
      () => {
        ipcConnected = false;
        process.connected = false;
        process.emit("disconnect");
      },
    );
  }

  process.send = function (message, ...args) {
    const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
    if (!ipcConnected || ipcClientId === null) {
      pendingIpcMessages.push({ message, cb });
      initIpc();
      return true;
    }
    try {
      const payload = JSON.stringify(message);
      const ok = ops.op_ipc_client_send(ipcClientId, payload);
      if (cb) queueMicrotask(() => cb(ok ? null : new Error("Send failed")));
      return ok;
    } catch (err) {
      if (cb) queueMicrotask(() => cb(err));
      return false;
    }
  };

  process.disconnect = function () {
    if (ipcClientId !== null) {
      ipcConnected = false;
      process.connected = false;
      ops.op_ipc_client_close(ipcClientId);
      ipcClientId = null;
      process.emit("disconnect");
    }
  };

  process._initIpc = initIpc;

  globalThis.process = process;

  // deno_core exposes a bare `Deno` global ({ core }); packages that sniff
  // for Deno (e.g. chalk's supports-color) expect Deno.args to exist.
  try {
    if (globalThis.Deno) {
      Object.defineProperty(globalThis.Deno, "args", {
        get: () => loadArgv().slice(2),
        configurable: true,
      });
    }
  } catch {
    // Deno global may be non-extensible; ignore.
  }
})(globalThis);
