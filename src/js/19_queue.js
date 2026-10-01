// 19_queue.js -- Embedded durable persistent message and task queue
(function () {
  class Queue {
    #db;
    #path;

    constructor(path = ":memory:") {
      this.#path = String(path);
      this.#db = globalThis.jse.sql.open(this.#path);
      try { this.#init(); }
      catch (error) { this.#db.close(); throw error; }
    }

    #init() {
      this.#db.query("PRAGMA busy_timeout = 250");
      this.#db.exec("BEGIN IMMEDIATE");
      try {
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
      const columns = this.#db.query("PRAGMA table_info(_jse_queue)");
      if (!columns.some(c => c.name === 'lease_token')) {
        this.#db.exec("ALTER TABLE _jse_queue ADD COLUMN lease_token TEXT");
      }
      this.#db.exec("CREATE TABLE IF NOT EXISTS _jse_queue_schema (version INTEGER NOT NULL)");
      const versions = this.#db.query("SELECT version FROM _jse_queue_schema");
      if (versions.some(v => v.version !== 2)) throw new Error('Unsupported queue schema');
      if (!versions.length) this.#db.exec("INSERT INTO _jse_queue_schema VALUES (2)");
      this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }

    #duration(value, name, minimum = 0) {
      if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) {
        throw new RangeError(`${name} must be an integer between ${minimum} and 2147483647`);
      }
      return value;
    }

    #topic(topic) {
      if (typeof topic !== 'string' || !topic.trim() || topic.length > 1024) throw new TypeError('Invalid queue topic');
      return topic;
    }

    push(topic, payload, options = {}) {
      const topicStr = this.#topic(topic);
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      const maxRetries = this.#duration(options.maxRetries ?? 5, 'maxRetries', 1);
      const delayMs = this.#duration(options.delayMs ?? 0, 'delayMs');
      if (typeof payloadStr !== 'string' || new TextEncoder().encode(payloadStr).length > 1048576) throw new RangeError('Queue payload exceeds 1 MiB or is not serializable');
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
      if (topic !== undefined) this.#topic(topic);
      this.#duration(leaseMs, 'leaseMs', 1);
      const now = Date.now();
      const lockExpiry = now + leaseMs;
      let claimed = null;

      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        this.#db.exec("UPDATE _jse_queue SET status = 'dead', locked_until = 0, lease_token = NULL WHERE status = 'pending' AND locked_until <= ? AND attempts >= max_retries", now);
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
          const token = crypto.randomUUID();
          this.#db.exec(
            "UPDATE _jse_queue SET locked_until = ?, attempts = attempts + 1, lease_token = ? WHERE id = ?",
            lockExpiry, token, r.id
          );
          let parsed;
          try {
            parsed = JSON.parse(r.payload);
          } catch (_) {
            parsed = r.payload;
          }
          claimed = {
            id: r.id,
            token,
            leaseUntil: lockExpiry,
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

    ack(id, token) {
      if (typeof token !== 'string' || !token) return false;
      return this.#db.exec("DELETE FROM _jse_queue WHERE id = ? AND lease_token = ? AND status = 'pending' AND locked_until > ?", Number(id), token, Date.now()) === 1;
    }

    nack(id, token, backoffMs = 1000) {
      this.#duration(backoffMs, 'backoffMs');
      if (typeof token !== 'string' || !token) return false;
      const now = Date.now();
      return this.#db.exec(`UPDATE _jse_queue SET
        status = CASE WHEN attempts >= max_retries THEN 'dead' ELSE 'pending' END,
        locked_until = CASE WHEN attempts >= max_retries THEN 0 ELSE ? END,
        lease_token = NULL
        WHERE id = ? AND lease_token = ? AND status = 'pending' AND locked_until > ?`,
        now + backoffMs, Number(id), token, now) === 1;
    }

    renew(id, token, leaseMs = 30000) {
      this.#duration(leaseMs, 'leaseMs', 1);
      if (typeof token !== 'string' || !token) return false;
      const now = Date.now();
      return this.#db.exec("UPDATE _jse_queue SET locked_until = ? WHERE id = ? AND lease_token = ? AND status = 'pending' AND locked_until > ?", now + leaseMs, Number(id), token, now) === 1;
    }

    replay(id) {
      return this.#db.exec("UPDATE _jse_queue SET status = 'pending', attempts = 0, locked_until = 0, lease_token = NULL WHERE id = ? AND status = 'dead'", Number(id)) === 1;
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
