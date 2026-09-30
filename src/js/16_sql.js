// src/js/16_sql.js - Embedded Zero-Dependency SQL Engine with Tagged Template Literals
((globalThis) => {
  const { core } = globalThis.__bootstrap;
  const { ops } = core;

  if (!globalThis.jse) {
    globalThis.jse = {};
  }

  class Database {
    #id = null;
    #closed = false;

    constructor(path = ":memory:") {
      this.#id = ops.op_sql_open(path);
    }

    get id() {
      return this.#id;
    }

    exec(sql, ...params) {
      if (this.#closed) throw new Error("Database is closed");
      return ops.op_sql_exec(this.#id, sql, params);
    }

    query(sql, ...params) {
      if (this.#closed) throw new Error("Database is closed");
      return ops.op_sql_query(this.#id, sql, params);
    }

    /**
     * Run within an ACID transaction; automatically rolls back if fn throws.
     */
    async transaction(fn) {
      if (this.#closed) throw new Error("Database is closed");
      this.exec("BEGIN TRANSACTION;");
      try {
        const result = await fn(this);
        this.exec("COMMIT;");
        return result;
      } catch (err) {
        try {
          this.exec("ROLLBACK;");
        } catch (_) {}
        throw err;
      }
    }

    close() {
      if (!this.#closed && this.#id !== null) {
        ops.op_sql_close(this.#id);
        this.#closed = true;
      }
    }

    /**
     * Tagged template literal execution against this database instance
     */
    sql(strings, ...values) {
      if (this.#closed) throw new Error("Database is closed");

      let query = "";
      const params = [];

      for (let i = 0; i < strings.length; i++) {
        query += strings[i];
        if (i < values.length) {
          query += "?";
          params.push(values[i]);
        }
      }

      const trimmed = query.trim().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN")) {
        return this.query(query, ...params);
      } else {
        return this.exec(query, ...params);
      }
    }
  }

  // Lazy default in-memory database
  let defaultDb = null;
  function getDefaultDb() {
    if (!defaultDb) {
      defaultDb = new Database(":memory:");
    }
    return defaultDb;
  }

  function sql(strings, ...values) {
    return getDefaultDb().sql(strings, ...values);
  }

  sql.open = (path) => new Database(path);
  sql.memory = () => new Database(":memory:");
  sql.exec = (statement, ...params) => getDefaultDb().exec(statement, ...params);
  sql.query = (statement, ...params) => getDefaultDb().query(statement, ...params);
  sql.transaction = (fn) => getDefaultDb().transaction(fn);

  globalThis.jse.sql = sql;
  globalThis.jse.Database = Database;
})(globalThis);
