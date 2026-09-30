// node:worker_threads thin wrapper over the global Worker host.
// workerData is delivered as a priming message on the parent->child channel,
// consumed here before the host loop starts (which is after module eval).
import { EventEmitter } from "node:events";

const ops = Deno.core.ops;

export const isMainThread = !ops.op_in_worker();
export let workerData = null;
export let parentPort = null;
export const threadId = isMainThread ? 0 : 1;

if (!isMainThread) {
  const bytes = await ops.op_host_recv();
  const msg = bytes && bytes.length ? __jse.deserialize(bytes) : { data: null };
  workerData = msg && "data" in msg ? msg.data : null;
  const listeners = new Map();
  parentPort = {
    postMessage(value) {
      ops.op_host_send(__jse.serialize({ type: "message", data: value === undefined ? null : value }));
    },
    on(type, fn) {
      if (type !== "message") return this;
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
      // Installed after the priming recv, so later host-loop messages hit it.
      globalThis.onmessage = (event) => {
        for (const listener of list) listener(event.data);
      };
      return this;
    },
    once(type, fn) {
      const wrap = (value) => {
        this.off(type, wrap);
        fn(value);
      };
      return this.on(type, wrap);
    },
    off(type, fn) {
      const list = listeners.get(type);
      if (!list) return this;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
      return this;
    },
  };
}

export class Worker extends EventEmitter {
  #id;
  #done = false;

  constructor(filename, options = {}) {
    super();
    const spec = filename instanceof URL ? filename.href : String(filename);
    this.#id = ops.op_worker_spawn(spec);
    this.threadId = 1;
    const data = options.workerData === undefined ? null : options.workerData;
    ops.op_worker_send(this.#id, __jse.serialize({ __jse_worker_data: true, data }));
    this.#loop();
  }

  postMessage(value) {
    if (this.#done) throw new Error("worker is terminated");
    const ok = ops.op_worker_send(
      this.#id,
      __jse.serialize({ type: "message", data: value === undefined ? null : value }),
    );
    if (!ok) throw new Error("worker is gone");
  }

  async #loop() {
    while (!this.#done) {
      let bytes;
      try {
        bytes = await ops.op_worker_recv(this.#id);
      } catch {
        break;
      }
      if (!bytes || bytes.length === 0) break;
      const msg = __jse.deserialize(bytes);
      if (msg && msg.type === "message") this.emit("message", msg.data);
    }
    this.#done = true;
    this.emit("exit", 0);
  }

  terminate() {
    this.#done = true;
    ops.op_worker_terminate(this.#id);
  }
}

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");

export class MessagePort extends EventEmitter {
  #chSend;
  #chRecv;
  #closed = false;
  #started = false;
  #onmessage = null;

  constructor(chSend, chRecv) {
    super();
    this.#chSend = chSend;
    this.#chRecv = chRecv;
  }

  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(fn) {
    this.#onmessage = fn;
    if (fn) this.start();
  }

  on(type, fn) {
    super.on(type, fn);
    if (type === "message") this.start();
    return this;
  }

  addListener(type, fn) {
    return this.on(type, fn);
  }

  once(type, fn) {
    super.once(type, fn);
    if (type === "message") this.start();
    return this;
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#pump();
  }

  async #pump() {
    while (!this.#closed) {
      let res;
      try {
        res = await this.#chRecv.recv();
      } catch {
        break;
      }
      if (res.done || this.#closed) break;
      const data = res.value;
      if (this.#onmessage) {
        try {
          this.#onmessage({ data, target: this });
        } catch (err) {
          console.error("MessagePort onmessage error:", err);
        }
      }
      this.emit("message", data);
    }
    this.emit("close");
  }

  postMessage(value) {
    if (this.#closed) throw new Error("MessagePort is closed");
    this.#chSend.send(value).catch(() => {});
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#chSend.close();
    this.#chRecv.close();
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

export class MessageChannel {
  constructor() {
    const ch1 = chan(0);
    const ch2 = chan(0);
    this.port1 = new MessagePort(ch1, ch2);
    this.port2 = new MessagePort(ch2, ch1);
  }
}

const broadcastHubs = new Map();

export class BroadcastChannel extends EventEmitter {
  #name;
  #closed = false;
  #onmessage = null;

  constructor(name) {
    super();
    this.#name = String(name);
    let channels = broadcastHubs.get(this.#name);
    if (!channels) {
      channels = new Set();
      broadcastHubs.set(this.#name, channels);
    }
    channels.add(this);
  }

  get name() {
    return this.#name;
  }

  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(fn) {
    this.#onmessage = fn;
  }

  postMessage(value) {
    if (this.#closed) throw new Error("BroadcastChannel is closed");
    const channels = broadcastHubs.get(this.#name);
    if (!channels) return;
    for (const ch of channels) {
      if (ch === this || ch.#closed) continue;
      queueMicrotask(() => {
        if (ch.#closed) return;
        const event = { data: structuredClone(value), target: ch };
        if (ch.#onmessage) {
          try {
            ch.#onmessage(event);
          } catch (e) {
            console.error("BroadcastChannel onmessage error:", e);
          }
        }
        ch.emit("message", event.data);
      });
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const channels = broadcastHubs.get(this.#name);
    if (channels) {
      channels.delete(this);
      if (channels.size === 0) {
        broadcastHubs.delete(this.#name);
      }
    }
    this.emit("close");
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

if (!globalThis.MessageChannel) {
  globalThis.MessageChannel = MessageChannel;
  globalThis.MessagePort = MessagePort;
}
if (!globalThis.BroadcastChannel) {
  globalThis.BroadcastChannel = BroadcastChannel;
}

export default {
  isMainThread,
  Worker,
  parentPort,
  workerData,
  threadId,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  SHARE_ENV,
};
