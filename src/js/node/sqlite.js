// node:sqlite — Node.js 22+ official built-in SQLite module
const ops = Deno.core.ops;

function flattenParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0];
  }
  return params;
}

export class StatementSync {
  #db;
  #sql;

  constructor(db, sql) {
    if (typeof sql !== "string") {
      throw new TypeError("The 'sql' argument must be a string");
    }
    this.#db = db;
    this.#sql = sql;
  }

  get sourceSQL() {
    return this.#sql;
  }

  get expandedSQL() {
    return this.#sql;
  }

  all(...params) {
    if (this.#db._closed || this.#db._id === null) {
      throw new Error("Database is closed");
    }
    const flat = flattenParams(params);
    return ops.op_sql_query(this.#db._id, this.#sql, flat);
  }

  get(...params) {
    const rows = this.all(...params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  run(...params) {
    if (this.#db._closed || this.#db._id === null) {
      throw new Error("Database is closed");
    }
    const flat = flattenParams(params);
    const changes = ops.op_sql_exec(this.#db._id, this.#sql, flat);
    const lastInsertRowid = ops.op_sql_last_insert_rowid(this.#db._id);
    return {
      changes,
      lastInsertRowid,
    };
  }

  *iterate(...params) {
    const rows = this.all(...params);
    for (const row of rows) {
      yield row;
    }
  }
}

export class DatabaseSync {
  _id = null;
  _closed = false;
  _location;

  constructor(location = ":memory:", options = {}) {
    if (typeof location !== "string") {
      throw new TypeError("The 'location' argument must be a string");
    }
    this._location = location;
    if (options?.open !== false) {
      this.open();
    }
  }

  open() {
    if (this._id !== null && !this._closed) return;
    this._id = ops.op_sql_open(this._location);
    this._closed = false;
  }

  close() {
    if (!this._closed && this._id !== null) {
      ops.op_sql_close(this._id);
      this._id = null;
      this._closed = true;
    }
  }

  exec(sql) {
    if (this._closed || this._id === null) {
      throw new Error("Database is closed");
    }
    if (typeof sql !== "string") {
      throw new TypeError("The 'sql' argument must be a string");
    }
    return ops.op_sql_exec(this._id, sql, []);
  }

  prepare(sql) {
    if (this._closed || this._id === null) {
      throw new Error("Database is closed");
    }
    return new StatementSync(this, sql);
  }
}

export default {
  DatabaseSync,
  StatementSync,
};
