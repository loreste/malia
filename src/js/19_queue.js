// 19_queue.js -- Embedded durable persistent message and task queue
(function () {
  class Queue {
    #db;
    #path;

    constructor(path = ":memory:") {
      this.#path = String(path);
      this.#db = globalThis.jse.sql.open(this.#path);
      this.#init();
    }

    #init() {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS _jse_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 5,
          created_at INTEGER NOT NULL,
          locked_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_jse_queue_fetch 
          ON _jse_queue (topic, status, locked_until);
      `);
    }

    push(topic, payload, options = {}) {
      const topicStr = String(topic);
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      const maxRetries = options.maxRetries ?? 5;
      const delayMs = options.delayMs ?? 0;
      const now = Date.now();
      const lockedUntil = now + delayMs;

      this.#db.exec(
        "INSERT INTO _jse_queue (topic, payload, status, attempts, max_retries, created_at, locked_until) VALUES (?, ?, 'pending', 0, ?, ?, ?)",
        topicStr,
        payloadStr,
        maxRetries,
        now,
        lockedUntil
      );
      const rows = this.#db.query("SELECT last_insert_rowid() AS id");
      return rows[0] ? rows[0].id : 0;
    }

    pop(topic, leaseMs = 30000) {
      const now = Date.now();
      const lockExpiry = now + leaseMs;
      let claimed = null;

      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        let rows;
        if (topic) {
          rows = this.#db.query(
            "SELECT id, topic, payload, attempts, max_retries FROM _jse_queue WHERE status = 'pending' AND locked_until <= ? AND topic = ? ORDER BY id ASC LIMIT 1",
            now,
            String(topic)
          );
        } else {
          rows = this.#db.query(
            "SELECT id, topic, payload, attempts, max_retries FROM _jse_queue WHERE status = 'pending' AND locked_until <= ? ORDER BY id ASC LIMIT 1",
            now
          );
        }
        if (rows && rows.length > 0) {
          const r = rows[0];
          this.#db.exec(
            "UPDATE _jse_queue SET locked_until = ?, attempts = attempts + 1 WHERE id = ?",
            lockExpiry,
            r.id
          );
          let parsed;
          try {
            parsed = JSON.parse(r.payload);
          } catch (_) {
            parsed = r.payload;
          }
          claimed = {
            id: r.id,
            topic: r.topic,
            payload: parsed,
            attempts: r.attempts + 1,
            maxRetries: r.max_retries,
          };
        }
        this.#db.exec("COMMIT;");
      } catch (err) {
        try {
          this.#db.exec("ROLLBACK;");
        } catch (_) {}
        throw err;
      }
      return claimed;
    }

    ack(id) {
      const idNum = Number(id);
      this.#db.exec("DELETE FROM _jse_queue WHERE id = ?", idNum);
      return true;
    }

    nack(id, backoffMs = 1000) {
      const idNum = Number(id);
      const now = Date.now();
      const rows = this.#db.query("SELECT attempts, max_retries FROM _jse_queue WHERE id = ?", idNum);
      if (!rows || rows.length === 0) return false;
      const { attempts, max_retries } = rows[0];
      if (attempts >= max_retries) {
        this.#db.exec("UPDATE _jse_queue SET status = 'dead', locked_until = 0 WHERE id = ?", idNum);
      } else {
        const nextLock = now + backoffMs;
        this.#db.exec("UPDATE _jse_queue SET locked_until = ? WHERE id = ?", nextLock, idNum);
      }
      return true;
    }

    size(topic) {
      if (topic) {
        const rows = this.#db.query("SELECT COUNT(*) AS count FROM _jse_queue WHERE topic = ? AND status = 'pending'", String(topic));
        return rows[0] ? rows[0].count : 0;
      }
      const rows = this.#db.query("SELECT COUNT(*) AS count FROM _jse_queue WHERE status = 'pending'");
      return rows[0] ? rows[0].count : 0;
    }

    dead(topic) {
      let rows;
      if (topic) {
        rows = this.#db.query("SELECT id, topic, payload, attempts FROM _jse_queue WHERE topic = ? AND status = 'dead'", String(topic));
      } else {
        rows = this.#db.query("SELECT id, topic, payload, attempts FROM _jse_queue WHERE status = 'dead'");
      }
      return rows.map((r) => {
        let parsed;
        try {
          parsed = JSON.parse(r.payload);
        } catch (_) {
          parsed = r.payload;
        }
        return { id: r.id, topic: r.topic, payload: parsed, attempts: r.attempts };
      });
    }

    close() {
      this.#db.close();
    }
  }

  const queueFactory = (path = ":memory:") => new Queue(path);
  queueFactory.open = queueFactory;
  queueFactory.Queue = Queue;

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.queue = queueFactory;
})();
