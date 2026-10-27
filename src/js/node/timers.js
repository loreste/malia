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
      let onAbort;
      const timer = globalThis.setTimeout(() => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolve(value);
      }, delay);
      if (signal) {
        onAbort = () => {
          globalThis.clearTimeout(timer);
          reject(signal.reason ?? new Error("The operation was aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },
  setImmediate(value, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        return reject(signal.reason ?? new Error("The operation was aborted"));
      }
      let onAbort;
      const imm = globalThis.setImmediate(() => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolve(value);
      });
      if (signal) {
        onAbort = () => {
          globalThis.clearImmediate(imm);
          reject(signal.reason ?? new Error("The operation was aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },
  async *setInterval(delay = 0, value, options = {}) {
    const signal = options?.signal;
    while (!signal?.aborted) {
      try {
        await promises.setTimeout(delay, undefined, options);
      } catch {
        return; // abort signal: end the iterator gracefully
      }
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
