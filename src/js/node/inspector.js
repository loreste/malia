// node:inspector shim
import EventEmitter from "node:events";

export function open() {}
export function close() {}
export function url() {
  return undefined;
}
export function waitForDebugger() {}

export class Session extends EventEmitter {
  connect() {}
  disconnect() {}
  post(method, params, callback) {
    if (typeof params === "function") {
      callback = params;
    }
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, {}));
    }
  }
}

export default {
  open,
  close,
  url,
  waitForDebugger,
  Session,
};
