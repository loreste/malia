// node:dgram — UDP datagram socket module.
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

class Socket extends EventEmitter {
  #type;
  #bound = false;
  #port = 0;
  #address = "0.0.0.0";

  constructor(type, listener) {
    super();
    this.#type = typeof type === "string" ? type : type?.type ?? "udp4";
    if (typeof listener === "function") this.on("message", listener);
  }

  bind(port, address, callback) {
    if (typeof address === "function") {
      callback = address;
      address = undefined;
    }
    if (typeof port === "function") {
      callback = port;
      port = 0;
      address = undefined;
    }
    this.#port = port || 0;
    this.#address = address || (this.#type === "udp6" ? "::" : "0.0.0.0");
    this.#bound = true;
    if (typeof callback === "function") this.once("listening", callback);
    queueMicrotask(() => {
      this.emit("listening");
    });
    return this;
  }

  address() {
    return {
      address: this.#address,
      family: this.#type === "udp6" ? "IPv6" : "IPv4",
      port: this.#port,
    };
  }

  send(msg, offset, length, port, address, callback) {
    if (typeof offset === "number" && typeof length === "number") {
      // standard 6-arg form
    } else {
      // (msg, port, address, callback) form
      callback = address;
      address = port;
      port = offset;
    }
    if (typeof address === "function") {
      callback = address;
      address = "127.0.0.1";
    }
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, Buffer.byteLength(msg)));
    }
    return this;
  }

  close(callback) {
    this.#bound = false;
    if (typeof callback === "function") this.once("close", callback);
    queueMicrotask(() => {
      this.emit("close");
    });
    return this;
  }

  ref() {
    return this;
  }
  unref() {
    return this;
  }
  setBroadcast() {
    return this;
  }
  setTTL() {
    return this;
  }
  setMulticastTTL() {
    return this;
  }
  setMulticastLoopback() {
    return this;
  }
}

export function createSocket(options, callback) {
  return new Socket(options, callback);
}

export { Socket };
export default {
  createSocket,
  Socket,
};
