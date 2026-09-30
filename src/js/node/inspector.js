// node:inspector -- V8 Inspector integration.
import EventEmitter from "node:events";

let inspectorUrl = null;

export function open(port, host, wait) {
  // Inspector is started via --inspect CLI flag; this is a compat no-op.
}

export function close() {}

export function url() {
  return inspectorUrl || undefined;
}

export function waitForDebugger() {
  // With --inspect-brk the runtime already waits before main execution.
}

export class Session extends EventEmitter {
  #ws = null;
  #nextId = 1;
  #pending = new Map();

  connect() {
    // In-process session: connect to the inspector WebSocket if available.
    const wsUrl = inspectorUrl;
    if (wsUrl) {
      try {
        this.#ws = new WebSocket(wsUrl);
        this.#ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.id !== undefined && this.#pending.has(msg.id)) {
              const cb = this.#pending.get(msg.id);
              this.#pending.delete(msg.id);
              cb(msg.error || null, msg.result || {});
            } else if (msg.method) {
              this.emit(msg.method, msg);
              this.emit("inspectorNotification", msg);
            }
          } catch {}
        };
        this.#ws.onerror = () => {};
      } catch {}
    }
  }

  connectToMainThread() {
    this.connect();
  }

  disconnect() {
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
    this.#pending.clear();
  }

  post(method, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = undefined;
    }
    if (!this.#ws || this.#ws.readyState !== 1) {
      if (typeof callback === "function") {
        queueMicrotask(() => callback(new Error("Inspector session is not connected")));
      }
      return;
    }
    const id = this.#nextId++;
    const msg = { id, method };
    if (params) msg.params = params;
    if (typeof callback === "function") {
      this.#pending.set(id, callback);
    }
    this.#ws.send(JSON.stringify(msg));
  }
}

export default { open, close, url, waitForDebugger, Session };
