// malia.pubsub -- in-process pub/sub for real-time apps.
// No Redis, no socket.io, no npm packages.
//
//   const bus = malia.pubsub();
//   bus.subscribe("chat:room1", (msg) => ws.send(JSON.stringify(msg)));
//   bus.publish("chat:room1", { user: "Alice", text: "hello" });
//
//   // Pattern matching
//   bus.subscribe("events:*", (msg, topic) => console.log(topic, msg));
//   bus.publish("events:user.login", { userId: 123 });
//
//   // With history (replay last N messages for late joiners)
//   const bus = malia.pubsub({ history: 50 });

"use strict";
((globalThis) => {
  function pubsub(options = {}) {
    const historySize = options.history || 0;
    const subs = new Map();  // topic -> Set<{fn, pattern}>
    const history = new Map(); // topic -> [messages]
    let subId = 0;

    function matchPattern(pattern, topic) {
      if (pattern === topic) return true;
      if (!pattern.includes("*")) return false;
      const regex = new RegExp("^" + pattern.replace(/\*/g, "[^:]*").replace(/\*\*/g, ".*") + "$");
      return regex.test(topic);
    }

    function getHistory(topic) {
      return history.get(topic) || [];
    }

    return {
      subscribe(pattern, fn) {
        const id = ++subId;
        const entry = { id, fn, pattern };

        // Register for exact topic and pattern matching
        if (!subs.has(pattern)) subs.set(pattern, new Set());
        subs.get(pattern).add(entry);

        // Replay history if available
        if (historySize > 0) {
          if (pattern.includes("*")) {
            for (const [topic, msgs] of history) {
              if (matchPattern(pattern, topic)) {
                for (const msg of msgs) fn(msg, topic);
              }
            }
          } else {
            for (const msg of getHistory(pattern)) fn(msg, pattern);
          }
        }

        // Return unsubscribe function
        return () => {
          const set = subs.get(pattern);
          if (set) { set.delete(entry); if (set.size === 0) subs.delete(pattern); }
        };
      },

      publish(topic, message) {
        // Store in history
        if (historySize > 0) {
          if (!history.has(topic)) history.set(topic, []);
          const h = history.get(topic);
          h.push(message);
          while (h.length > historySize) h.shift();
        }

        let delivered = 0;
        // Deliver to exact subscribers
        const exact = subs.get(topic);
        if (exact) for (const entry of exact) { entry.fn(message, topic); delivered++; }

        // Deliver to pattern subscribers
        for (const [pattern, entries] of subs) {
          if (pattern === topic) continue; // already delivered
          if (pattern.includes("*") && matchPattern(pattern, topic)) {
            for (const entry of entries) { entry.fn(message, topic); delivered++; }
          }
        }
        return delivered;
      },

      // List active topics with subscriber counts
      topics() {
        const result = {};
        for (const [pattern, entries] of subs) {
          result[pattern] = entries.size;
        }
        return result;
      },

      // Unsubscribe all listeners for a pattern
      unsubscribe(pattern) {
        subs.delete(pattern);
      },

      // Clear all subscriptions and history
      clear() {
        subs.clear();
        history.clear();
      },

      // Number of active subscriptions
      get size() {
        let n = 0;
        for (const s of subs.values()) n += s.size;
        return n;
      },

      // Once: subscribe for a single message then auto-unsubscribe
      once(pattern) {
        return new Promise((resolve) => {
          const unsub = this.subscribe(pattern, (msg, topic) => {
            unsub();
            resolve({ message: msg, topic });
          });
        });
      },

      // Async iterator for a topic
      async *listen(pattern) {
        const queue = [];
        let notify = null;
        let done = false;
        const unsub = this.subscribe(pattern, (msg, topic) => {
          queue.push({ message: msg, topic });
          if (notify) { notify(); notify = null; }
        });
        try {
          while (!done) {
            if (queue.length > 0) {
              yield queue.shift();
            } else {
              await new Promise(r => { notify = r; });
            }
          }
        } finally {
          unsub();
        }
      },
    };
  }

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.pubsub = pubsub;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
