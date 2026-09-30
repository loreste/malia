// src/js/14_kv.js - JavaScript API for Off-Heap Zero-GC Shared Key-Value Store
((globalThis) => {
  const { core } = globalThis.__bootstrap;
  const { ops } = core;

  if (!globalThis.jse) {
    globalThis.jse = {};
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const kv = {
    get(key) {
      if (typeof key !== "string") throw new TypeError("key must be a string");
      const res = ops.op_kv_get(key);
      if (!res.found || !res.value) return null;
      const raw = res.value instanceof Uint8Array ? res.value : new Uint8Array(res.value);
      try {
        const text = decoder.decode(raw);
        return JSON.parse(text);
      } catch (_) {
        return raw;
      }
    },

    getWithVersion(key) {
      if (typeof key !== "string") throw new TypeError("key must be a string");
      const res = ops.op_kv_get(key);
      if (!res.found || !res.value) return null;
      const raw = res.value instanceof Uint8Array ? res.value : new Uint8Array(res.value);
      let val;
      try {
        val = JSON.parse(decoder.decode(raw));
      } catch (_) {
        val = raw;
      }
      return { value: val, version: res.version };
    },

    set(key, value, options) {
      if (typeof key !== "string") throw new TypeError("key must be a string");
      let bytes;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else {
        bytes = encoder.encode(JSON.stringify(value));
      }
      const ttlMs = options && typeof options.ttlMs === "number"
        ? options.ttlMs
        : (options && typeof options.ttl === "number" ? options.ttl * 1000 : null);
      return ops.op_kv_set(key, bytes, ttlMs);
    },

    delete(key) {
      if (typeof key !== "string") throw new TypeError("key must be a string");
      return ops.op_kv_delete(key);
    },

    has(key) {
      if (typeof key !== "string") throw new TypeError("key must be a string");
      return ops.op_kv_has(key);
    },

    clear() {
      ops.op_kv_clear();
    },

    keys(prefix) {
      return ops.op_kv_keys(prefix || null);
    },

    stats() {
      return ops.op_kv_stats();
    },

    atomic: {
      incr(key, amount = 1) {
        if (typeof key !== "string") throw new TypeError("key must be a string");
        return ops.op_kv_incr(key, Number(amount));
      },
      decr(key, amount = 1) {
        if (typeof key !== "string") throw new TypeError("key must be a string");
        return ops.op_kv_incr(key, -Number(amount));
      },
      cas(key, expectedVersion, newValue, options) {
        if (typeof key !== "string") throw new TypeError("key must be a string");
        let bytes;
        if (newValue instanceof Uint8Array) {
          bytes = newValue;
        } else {
          bytes = encoder.encode(JSON.stringify(newValue));
        }
        const ttlMs = options && typeof options.ttlMs === "number"
          ? options.ttlMs
          : (options && typeof options.ttl === "number" ? options.ttl * 1000 : null);
        return ops.op_kv_cas(key, expectedVersion, bytes, ttlMs);
      },
    },
  };

  globalThis.jse.kv = kv;
})(globalThis);
