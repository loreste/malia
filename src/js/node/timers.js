// node:timers — timers module.
export const setTimeout = globalThis.setTimeout;
export const clearTimeout = globalThis.clearTimeout;
export const setInterval = globalThis.setInterval;
export const clearInterval = globalThis.clearInterval;
export const setImmediate = globalThis.setImmediate;
export const clearImmediate = globalThis.clearImmediate;

export const promises = {
  setTimeout(delay = 0, value, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        return reject(signal.reason ?? new Error("The operation was aborted"));
      }
      const timer = globalThis.setTimeout(() => resolve(value), delay);
      if (signal) {
        signal.addEventListener("abort", () => {
          globalThis.clearTimeout(timer);
          reject(signal.reason ?? new Error("The operation was aborted"));
        }, { once: true });
      }
    });
  },
  setImmediate(value, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        return reject(signal.reason ?? new Error("The operation was aborted"));
      }
      const imm = globalThis.setImmediate(() => resolve(value));
      if (signal) {
        signal.addEventListener("abort", () => {
          globalThis.clearImmediate(imm);
          reject(signal.reason ?? new Error("The operation was aborted"));
        }, { once: true });
      }
    });
  },
  async *setInterval(delay = 0, value, options = {}) {
    while (true) {
      await promises.setTimeout(delay, undefined, options);
      yield value;
    }
  },
};

export default {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  promises,
};
