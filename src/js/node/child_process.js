// node:child_process — live stdio pipes (pipe / inherit / ignore).
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

const ops = Deno.core.ops;

function stdioAt(options, index) {
  const stdio = options?.stdio;
  if (typeof stdio === "string") return modeOf(stdio);
  if (Array.isArray(stdio) && stdio[index] != null) return modeOf(stdio[index]);
  return "pipe";
}

function modeOf(value) {
  if (value === "inherit" || value === "ignore" || value === "pipe") return value;
  return "pipe";
}

function normalizeSpec(command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = undefined;
  }
  options = options ?? {};
  return {
    cmd: String(command),
    args: (args ?? []).map(String),
    cwd: options.cwd !== undefined ? String(options.cwd) : undefined,
    env: options.env
      ? Object.entries(options.env).map(([k, v]) => [k, String(v)])
      : undefined,
    stdin: stdioAt(options, 0),
    stdout: stdioAt(options, 1),
    stderr: stdioAt(options, 2),
  };
}

function asOutput(bytes, encoding) {
  let buf;
  if (Buffer.isBuffer(bytes)) buf = bytes;
  else if (bytes instanceof Uint8Array) buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else buf = Buffer.from(bytes ?? []);
  return encoding ? buf.toString(encoding) : buf;
}

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Pulls from the host channel only when something reads. Bytes stay buffered
// in the channel until then, so a listener attached after 'close' still works.
function PipeStream(id, which) {
  Readable.call(this);
  this._id = id;
  this._which = which;
  this._inflight = false;
  this._done = false;
}
PipeStream.prototype = Object.create(Readable.prototype);
PipeStream.prototype.constructor = PipeStream;
PipeStream.prototype._read = function () {
  if (this._inflight || this._done) return;
  this._inflight = true;
  ops.op_child_read(this._id, this._which).then(
    (chunk) => {
      this._inflight = false;
      if (this._done) return;
      if (!chunk || chunk.byteLength === 0) {
        this._done = true;
        this.push(null);
        return;
      }
      this.push(asBuffer(chunk));
    },
    (err) => {
      this._inflight = false;
      this.destroy(err);
    },
  );
};

async function readAll(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class ChildProcess extends EventEmitter {
  #id = null;
  #exitPromise;

  constructor(id, pid, spec) {
    super();
    this.#id = id;
    this.pid = pid;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = spec.stdout === "pipe" ? new PipeStream(id, 0) : null;
    this.stderr = spec.stderr === "pipe" ? new PipeStream(id, 1) : null;
    this.stdin =
      spec.stdin === "pipe"
        ? new Writable({
            write(chunk, encoding, cb) {
              const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding ?? "utf8") : chunk;
              ops.op_child_stdin_write(id, bytes).then(() => cb(), cb);
            },
            final(cb) {
              try {
                ops.op_child_stdin_close(id);
                cb();
              } catch (err) {
                cb(err);
              }
            },
          })
        : null;
    this.#exitPromise = ops.op_child_exit(id).then(
      (result) => {
        this.exitCode = result.code;
        this.emit("exit", result.code, null);
        this.emit("close", result.code, null);
        return result;
      },
      (err) => {
        this.emit("error", err);
        this.emit("close", null, null);
        throw err;
      },
    );
    this.#exitPromise.catch(() => {});
  }

  static _spawnError(err) {
    const child = new EventEmitter();
    child.killed = false;
    child.exitCode = null;
    child.stdout = null;
    child.stderr = null;
    child.stdin = null;
    queueMicrotask(() => {
      child.emit("error", err);
      child.emit("close", null, null);
    });
    return child;
  }

  kill() {
    if (this.#id === null) return false;
    this.killed = ops.op_child_kill(this.#id);
    return this.killed;
  }

  _result() {
    return Promise.all([this.#exitPromise, readAll(this.stdout), readAll(this.stderr)]).then(
      ([result, stdout, stderr]) => ({ code: result.code, stdout, stderr }),
    );
  }
}

function spawn(command, args, options) {
  const spec = normalizeSpec(command, args, options);
  let spawned;
  try {
    spawned = ops.op_child_spawn(spec);
  } catch (err) {
    return ChildProcess._spawnError(err);
  }
  return new ChildProcess(spawned.id, spawned.pid, spec);
}

function execFile(file, args, options, cb) {
  if (typeof args === "function") {
    cb = args;
    args = undefined;
    options = undefined;
  } else if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  const encoding = options?.encoding;
  const promise = new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    child.on("error", reject);
    if (typeof child._result !== "function") {
      reject(new Error("spawn failed"));
      return;
    }
    child._result().then(
      (result) =>
        resolve({
          stdout: asOutput(result.stdout, encoding),
          stderr: asOutput(result.stderr, encoding),
        }),
      reject,
    );
  });
  if (cb) {
    promise.then(
      ({ stdout, stderr }) => cb(null, stdout, stderr),
      (err) => cb(err, "", ""),
    );
    return undefined;
  }
  return promise;
}

function exec(command, options, cb) {
  if (typeof options === "function") {
    cb = options;
    options = undefined;
  }
  return execFile("/bin/sh", ["-c", String(command)], options, cb);
}

function spawnSync(command, args, options) {
  const spec = normalizeSpec(command, args, options);
  const encoding = (args !== undefined && !Array.isArray(args) ? args : options)?.encoding;
  try {
    const result = ops.op_child_spawn_sync(spec);
    return {
      status: result.code,
      signal: null,
      stdout: asOutput(result.stdout, encoding),
      stderr: asOutput(result.stderr, encoding),
      error: undefined,
      pid: 0,
    };
  } catch (err) {
    return {
      status: null,
      signal: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      error: err,
      pid: 0,
    };
  }
}

function execFileSync(file, args, options) {
  const result = spawnSync(file, args, options);
  if (result.error) throw result.error;
  return result.stdout;
}

function execSync(command, options) {
  const result = spawnSync("/bin/sh", ["-c", String(command)], options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(`Command failed: ${command}`);
    err.status = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}

function fork(modulePath, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = undefined;
  }
  options = options ? { ...options } : {};
  const execPath = options.execPath || process.execPath || "jse";
  const execArgv = options.execArgv || process.execArgv || [];

  const ipc = ops.op_ipc_listen();
  const env = { ...(options.env || process.env), NODE_CHANNEL_PORT: String(ipc.port) };
  options.env = env;

  const fullArgs = ["run", "--allow-all", ...execArgv, String(modulePath), ...(args || []).map(String)];
  const child = spawn(execPath, fullArgs, options);

  let workerConnId = null;
  const pendingMessages = [];
  child.connected = false;

  child.send = function (message, ...sendArgs) {
    const cb = typeof sendArgs[sendArgs.length - 1] === "function" ? sendArgs[sendArgs.length - 1] : undefined;
    if (workerConnId === null) {
      pendingMessages.push({ message, cb });
      return true;
    }
    try {
      const ok = ops.op_ipc_server_send(ipc.id, workerConnId, JSON.stringify(message));
      if (cb) queueMicrotask(() => cb(ok ? null : new Error("Send failed")));
      return ok;
    } catch (err) {
      if (cb) queueMicrotask(() => cb(err));
      return false;
    }
  };

  child.disconnect = function () {
    if (child.connected) {
      child.connected = false;
      ops.op_ipc_server_close(ipc.id);
      child.emit("disconnect");
    }
  };

  function pollServer() {
    ops.op_ipc_server_poll(ipc.id).then(
      (evt) => {
        if (!evt) return;
        if (evt.kind === "connect") {
          workerConnId = evt.id;
          child.connected = true;
          child.emit("spawn");
          while (pendingMessages.length > 0) {
            const { message, cb } = pendingMessages.shift();
            try {
              const ok = ops.op_ipc_server_send(ipc.id, workerConnId, JSON.stringify(message));
              if (cb) queueMicrotask(() => cb(ok ? null : new Error("Send failed")));
            } catch (err) {
              if (cb) queueMicrotask(() => cb(err));
            }
          }
        } else if (evt.kind === "message" && evt.data) {
          try {
            const data = JSON.parse(evt.data);
            child.emit("message", data);
          } catch (_) {}
        } else if (evt.kind === "disconnect") {
          child.connected = false;
          child.emit("disconnect");
        }
        pollServer();
      },
      () => {
        child.connected = false;
      },
    );
  }

  pollServer();

  child.on("exit", () => {
    ops.op_ipc_server_close(ipc.id);
  });

  return child;
}

export { spawn, execFile, exec, spawnSync, execFileSync, execSync, fork, ChildProcess };
export default { spawn, execFile, exec, spawnSync, execFileSync, execSync, fork, ChildProcess };
