// node:dgram -- UDP datagram sockets backed by native tokio ops.
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

const ops = Deno.core.ops;

class Socket extends EventEmitter {
  #type;
  #id = null;
  #receiving = false;

  constructor(type, listener) {
    super();
    this.#type = typeof type === "string" ? type : type?.type ?? "udp4";
    if (typeof listener === "function") this.on("message", listener);
  }

  bind(port, address, callback) {
    if (typeof address === "function") { callback = address; address = undefined; }
    if (typeof port === "function") { callback = port; port = 0; address = undefined; }
    const addr = address || (this.#type === "udp6" ? "::" : "0.0.0.0");
    if (typeof callback === "function") this.once("listening", callback);
    ops.op_udp_bind(addr, port || 0, this.#type).then(
      (id) => {
        this.#id = id;
        this.emit("listening");
        this.#pump();
      },
      (err) => this.emit("error", err),
    );
    return this;
  }

  #pump() {
    if (this.#id === null || this.#receiving) return;
    this.#receiving = true;
    ops.op_udp_recv(this.#id).then(
      (result) => {
        this.#receiving = false;
        if (this.#id === null) return;
        const buf = Buffer.from(result.data);
        const rinfo = { address: result.address, family: this.#type === "udp6" ? "IPv6" : "IPv4", port: result.port, size: buf.length };
        this.emit("message", buf, rinfo);
        this.#pump();
      },
      (err) => {
        this.#receiving = false;
        if (this.#id !== null) this.emit("error", err);
      },
    );
  }

  address() {
    if (this.#id === null) return { address: "0.0.0.0", family: "IPv4", port: 0 };
    try {
      const a = ops.op_udp_address(this.#id);
      return { address: a.address, family: this.#type === "udp6" ? "IPv6" : "IPv4", port: a.port };
    } catch { return { address: "0.0.0.0", family: "IPv4", port: 0 }; }
  }

  send(msg, offset, length, port, address, callback) {
    if (typeof offset === "number" && typeof length === "number") {
      msg = Buffer.isBuffer(msg) ? msg.subarray(offset, offset + length) : Buffer.from(msg).subarray(offset, offset + length);
    } else {
      callback = address;
      address = port;
      port = offset;
    }
    if (typeof address === "function") { callback = address; address = "127.0.0.1"; }
    address = address || "127.0.0.1";
    const data = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg));
    const doSend = (id) => {
      ops.op_udp_send(id, data, address, port).then(
        (n) => { if (typeof callback === "function") callback(null, n); },
        (err) => { if (typeof callback === "function") callback(err); else this.emit("error", err); },
      );
    };
    if (this.#id !== null) {
      doSend(this.#id);
    } else {
      // Auto-bind if not bound yet.
      this.bind(0, undefined, () => doSend(this.#id));
    }
    return this;
  }

  close(callback) {
    if (this.#id !== null) {
      ops.op_udp_close(this.#id);
      this.#id = null;
    }
    if (typeof callback === "function") this.once("close", callback);
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  ref() { return this; }
  unref() { return this; }
  setBroadcast() { return this; }
  setTTL() { return this; }
  setMulticastTTL() { return this; }
  setMulticastLoopback() { return this; }
  addMembership() {}
  dropMembership() {}
  setMulticastInterface() {}
}

export function createSocket(options, callback) {
  return new Socket(options, callback);
}

export { Socket };
export default { createSocket, Socket };
