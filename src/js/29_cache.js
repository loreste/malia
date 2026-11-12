// malia.cache -- LRU cache with TTL, size limits, and stale-while-revalidate.
// Replaces lru-cache (100M/week), node-cache (5M/week), keyv (20M/week).
//
//   const cache = malia.cache({ max: 1000, ttl: 60000 });
//   cache.set("user:123", userData);
//   const user = cache.get("user:123");
//
//   // Cache-aside pattern (the killer feature):
//   const user = await cache.getOrSet("user:123", async () => {
//     return await db.query("SELECT * FROM users WHERE id = 123");
//   }, { ttl: 30000 });
//
//   // Works for images, buffers, anything:
//   const img = await cache.getOrSet("avatar:" + userId, async () => {
//     const res = await fetch(avatarUrl);
//     return Buffer.from(await res.arrayBuffer());
//   }, { ttl: 3600000 });

"use strict";
((globalThis) => {

  class LRUCache {
    #max;
    #ttl;
    #map = new Map();  // key -> { value, expires, size }
    #hits = 0;
    #misses = 0;
    #maxSize;
    #currentSize = 0;
    #sizeOf;
    #onEvict;
    #staleWhileRevalidate;
    #pending = new Map(); // key -> Promise (dedup concurrent getOrSet)

    constructor(options = {}) {
      this.#max = options.max || 1000;
      this.#ttl = options.ttl || 0;  // 0 = no expiry
      this.#maxSize = options.maxSize || 0;  // 0 = count-based, not size-based
      this.#sizeOf = options.sizeOf || null; // fn(value, key) -> size in bytes
      this.#onEvict = options.onEvict || null;  // fn(key, value)
      this.#staleWhileRevalidate = options.staleWhileRevalidate || 0;  // ms
    }

    get(key) {
      const entry = this.#map.get(key);
      if (!entry) {
        this.#misses++;
        return undefined;
      }

      // Check expiry
      if (entry.expires && Date.now() > entry.expires) {
        if (this.#staleWhileRevalidate && Date.now() < entry.expires + this.#staleWhileRevalidate) {
          // Stale-while-revalidate: return stale value AND mark for revalidation.
          // The revalidation loader is set by getOrSet(); plain get() returns
          // stale but cannot revalidate (no loader). getOrSet() checks the
          // _stale flag and kicks off a background refresh.
          this.#hits++;
          entry._stale = true;
          this.#touch(key, entry);
          return entry.value;
        }
        this.#evict(key);
        this.#misses++;
        return undefined;
      }

      this.#hits++;
      this.#touch(key, entry);
      return entry.value;
    }

    set(key, value, options = {}) {
      const ttl = options.ttl ?? this.#ttl;
      const expires = ttl > 0 ? Date.now() + ttl : 0;
      const size = this.#sizeOf ? this.#sizeOf(value, key) : 1;

      // Reject entries that alone exceed maxSize
      if (this.#maxSize && size > this.#maxSize) {
        return this;
      }

      // If key exists, remove old entry first
      if (this.#map.has(key)) {
        const old = this.#map.get(key);
        this.#currentSize -= old.size || 1;
        this.#map.delete(key);
      }

      // Evict until we have room
      while (this.#map.size >= this.#max || (this.#maxSize && this.#currentSize + size > this.#maxSize)) {
        if (this.#map.size === 0) break;
        const oldest = this.#map.keys().next().value;
        this.#evict(oldest);
      }

      this.#map.set(key, { value, expires, size });
      this.#currentSize += size;
      return this;
    }

    // Cache-aside: get from cache, or compute and store
    async getOrSet(key, fn, options = {}) {
      // Check cache first
      const entry = this.#map.get(key);
      if (entry) {
        const now = Date.now();
        if (!entry.expires || now <= entry.expires) {
          // Fresh hit
          this.#hits++;
          this.#touch(key, entry);
          return entry.value;
        }
        if (this.#staleWhileRevalidate && now < entry.expires + this.#staleWhileRevalidate) {
          // Stale but within revalidation window: return stale value and
          // kick off background refresh so the next caller gets fresh data.
          this.#hits++;
          this.#touch(key, entry);
          const staleValue = entry.value;
          if (!this.#pending.has(key)) {
            const refresh = (async () => {
              try {
                const fresh = await fn(key);
                this.set(key, fresh, options);
              } catch (_) {
                // Revalidation failed; stale entry stays until it fully expires
              } finally {
                this.#pending.delete(key);
              }
            })();
            this.#pending.set(key, refresh);
          }
          return staleValue;
        }
        // Fully expired
        this.#evict(key);
      }
      // Dedup: if another caller is already computing this key, wait for it
      if (this.#pending.has(key)) {
        return this.#pending.get(key);
      }

      const promise = (async () => {
        try {
          const value = await fn(key);
          this.set(key, value, options);
          return value;
        } finally {
          this.#pending.delete(key);
        }
      })();

      this.#pending.set(key, promise);
      return promise;
    }

    has(key) {
      const entry = this.#map.get(key);
      if (!entry) return false;
      if (entry.expires && Date.now() > entry.expires) {
        this.#evict(key);
        return false;
      }
      return true;
    }

    delete(key) {
      return this.#evict(key);
    }

    clear() {
      if (this.#onEvict) {
        for (const [key, entry] of this.#map) {
          this.#onEvict(key, entry.value);
        }
      }
      this.#map.clear();
      this.#currentSize = 0;
      this.#hits = 0;
      this.#misses = 0;
    }

    // Iterate entries (most recent first)
    *entries() {
      const keys = [...this.#map.keys()].reverse();
      for (const key of keys) {
        const entry = this.#map.get(key);
        if (entry && (!entry.expires || Date.now() <= entry.expires)) {
          yield [key, entry.value];
        }
      }
    }

    *keys() {
      for (const [key] of this.entries()) yield key;
    }

    *values() {
      for (const [, value] of this.entries()) yield value;
    }

    [Symbol.iterator]() {
      return this.entries();
    }

    forEach(fn) {
      for (const [key, value] of this.entries()) fn(value, key, this);
    }

    // Bulk operations
    setMany(entries, options = {}) {
      for (const [key, value] of entries) this.set(key, value, options);
      return this;
    }

    getMany(keys) {
      return keys.map(k => this.get(k));
    }

    deleteMany(keys) {
      let count = 0;
      for (const k of keys) if (this.delete(k)) count++;
      return count;
    }

    // Stats
    get size() { return this.#map.size; }
    get max() { return this.#max; }
    get hits() { return this.#hits; }
    get misses() { return this.#misses; }
    get hitRate() {
      const total = this.#hits + this.#misses;
      return total === 0 ? 0 : this.#hits / total;
    }
    get currentSize() { return this.#currentSize; }

    stats() {
      return {
        size: this.#map.size,
        max: this.#max,
        hits: this.#hits,
        misses: this.#misses,
        hitRate: this.hitRate,
        currentSize: this.#currentSize,
        maxSize: this.#maxSize,
        pending: this.#pending.size,
      };
    }

    // Remove expired entries without waiting for access
    purge() {
      const now = Date.now();
      let purged = 0;
      for (const [key, entry] of this.#map) {
        if (entry.expires && now > entry.expires) {
          this.#evict(key);
          purged++;
        }
      }
      return purged;
    }

    // Internal
    #touch(key, entry) {
      // Move to end (most recently used)
      this.#map.delete(key);
      this.#map.set(key, entry);
    }

    #evict(key) {
      const entry = this.#map.get(key);
      if (!entry) return false;
      this.#map.delete(key);
      this.#currentSize -= entry.size || 1;
      if (this.#onEvict) this.#onEvict(key, entry.value);
      return true;
    }
  }

  // malia.cache(options) -- create an LRU cache
  function cache(options) {
    return new LRUCache(options);
  }
  cache.LRUCache = LRUCache;

  // Convenience: memoize an async function
  cache.memoize = function (fn, options = {}) {
    const c = new LRUCache(options);
    const keyFn = options.key || ((...args) => JSON.stringify(args));
    const memoized = async function (...args) {
      const key = keyFn(...args);
      return c.getOrSet(key, () => fn.apply(this, args), options);
    };
    memoized.cache = c;
    memoized.clear = () => c.clear();
    return memoized;
  };

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.cache = cache;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
