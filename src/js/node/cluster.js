// node:cluster implementation
import { EventEmitter } from "node:events";
import { fork as cpFork } from "node:child_process";

class Worker extends EventEmitter {
  constructor(id, child) {
    super();
    this.id = id;
    this.process = child;
    this.state = "none";
  }

  send(message, ...args) {
    return this.process.send(message, ...args);
  }

  kill(signal = "SIGTERM") {
    return this.process.kill(signal);
  }

  destroy(signal = "SIGTERM") {
    return this.kill(signal);
  }

  disconnect() {
    this.process.disconnect();
    return this;
  }

  isConnected() {
    return Boolean(this.process?.connected);
  }

  isDead() {
    return Boolean(this.process?.killed || this.process?.exitCode !== null);
  }
}

class Cluster extends EventEmitter {
  #nextId = 0;

  constructor() {
    super();
    this.SCHED_RR = 1;
    this.SCHED_NONE = 2;
    this.schedulingPolicy = this.SCHED_NONE; // Direct kernel SO_REUSEPORT load balancing
    this.settings = {
      exec: process.argv[1] || "",
      args: process.argv.slice(2) || [],
      execArgv: process.execArgv || [],
      silent: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    };
    this.workers = {};
    this.worker = undefined;

    if (this.isWorker) {
      process._initIpc?.();
      let id = 1;
      try {
        id = Number(process.env.NODE_UNIQUE_ID) || 1;
      } catch (_) {}
      this.worker = new Worker(id, process);
      process.on("message", (msg) => {
        this.worker.emit("message", msg);
      });
    }
  }

  get isWorker() {
    try {
      return Boolean(process.env?.NODE_UNIQUE_ID);
    } catch (_) {
      return false;
    }
  }

  get isMaster() {
    return !this.isWorker;
  }

  get isPrimary() {
    return !this.isWorker;
  }

  setupPrimary(settings = {}) {
    Object.assign(this.settings, settings);
    this.emit("setup", this.settings);
  }

  setupMaster(settings = {}) {
    this.setupPrimary(settings);
  }

  fork(env = {}) {
    if (this.isWorker) {
      throw new Error("cluster.fork() can only be called from the primary process");
    }
    const id = ++this.#nextId;
    const workerEnv = {
      ...process.env,
      ...env,
      NODE_UNIQUE_ID: String(id),
    };

    const targetModule = this.settings.exec || process.argv[1];
    const child = cpFork(targetModule, this.settings.args, {
      env: workerEnv,
      execArgv: this.settings.execArgv,
      silent: this.settings.silent,
      stdio: this.settings.stdio,
    });

    const worker = new Worker(id, child);
    this.workers[id] = worker;

    child.on("spawn", () => {
      worker.state = "online";
      worker.emit("online");
      this.emit("online", worker);
    });

    child.on("message", (msg) => {
      if (msg && typeof msg === "object" && msg.cmd === "NODE_CLUSTER") {
        if (msg.act === "online") {
          worker.state = "online";
          worker.emit("online");
          this.emit("online", worker);
          return;
        }
        if (msg.act === "listening") {
          worker.state = "listening";
          const addr = {
            address: msg.address || "0.0.0.0",
            port: msg.port,
            addressType: 4,
            fd: undefined,
          };
          worker.emit("listening", addr);
          this.emit("listening", worker, addr);
          return;
        }
      }
      worker.emit("message", msg);
      this.emit("message", worker, msg);
    });

    child.on("disconnect", () => {
      worker.state = "disconnected";
      worker.emit("disconnect");
      this.emit("disconnect", worker);
    });

    child.on("exit", (code, signal) => {
      worker.state = "dead";
      delete this.workers[id];
      worker.emit("exit", code, signal);
      this.emit("exit", worker, code, signal);
    });

    child.on("error", (err) => {
      worker.emit("error", err);
    });

    queueMicrotask(() => {
      this.emit("fork", worker);
    });

    return worker;
  }

  disconnect(cb) {
    const active = Object.values(this.workers);
    let remaining = active.length;
    if (remaining === 0) {
      if (cb) queueMicrotask(cb);
      return;
    }
    for (const w of active) {
      w.once("disconnect", () => {
        remaining--;
        if (remaining === 0 && cb) cb();
      });
      w.disconnect();
    }
  }
}

const cluster = new Cluster();

export const isWorker = cluster.isWorker;
export const isMaster = cluster.isMaster;
export const isPrimary = cluster.isPrimary;
export const worker = cluster.worker;
export const workers = cluster.workers;
export const settings = cluster.settings;
export const SCHED_RR = cluster.SCHED_RR;
export const SCHED_NONE = cluster.SCHED_NONE;
export const schedulingPolicy = cluster.schedulingPolicy;
export const setupPrimary = (s) => cluster.setupPrimary(s);
export const setupMaster = (s) => cluster.setupMaster(s);
export const fork = (env) => cluster.fork(env);
export const disconnect = (cb) => cluster.disconnect(cb);
export const on = (...args) => cluster.on(...args);
export const once = (...args) => cluster.once(...args);
export const off = (...args) => cluster.off(...args);
export const emit = (...args) => cluster.emit(...args);
export const addListener = (...args) => cluster.addListener(...args);
export const removeListener = (...args) => cluster.removeListener(...args);

export default cluster;
