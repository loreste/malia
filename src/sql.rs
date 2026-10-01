// src/sql.rs - Embedded Zero-Dependency SQL Engine (SQLite) for jse.
// Eliminates node-gyp / better-sqlite3 build headaches with native, secure,
// bundled SQLite, prepared statements, and tagged template literals.

use deno_core::op2;
use deno_error::JsErrorBox;
use rusqlite::{Connection, ToSql, types::ValueRef};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct SqlEngine {
  connections: Mutex<HashMap<u32, Arc<Mutex<Connection>>>>,
  next_id: std::sync::atomic::AtomicU32,
}

impl Default for SqlEngine {
  fn default() -> Self {
    Self::new()
  }
}

impl SqlEngine {
  pub fn new() -> Self {
    Self {
      connections: Mutex::new(HashMap::new()),
      next_id: std::sync::atomic::AtomicU32::new(1),
    }
  }

  pub fn open(&self, path: &str) -> Result<u32, JsErrorBox> {
    let conn = if path == ":memory:" || path.is_empty() {
      Connection::open_in_memory()
    } else {
      Connection::open(path)
    }
    .map_err(|e| JsErrorBox::generic(format!("sqlite open {path}: {e}")))?;

    // Enable WAL mode and foreign keys for high-performance production workloads
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");

    let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut conns) = self.connections.lock() {
      conns.insert(id, Arc::new(Mutex::new(conn)));
    }
    Ok(id)
  }

  pub fn close(&self, id: u32) -> bool {
    if let Ok(mut conns) = self.connections.lock() {
      conns.remove(&id).is_some()
    } else {
      false
    }
  }

  pub fn get_conn(&self, id: u32) -> Result<Arc<Mutex<Connection>>, JsErrorBox> {
    if let Ok(conns) = self.connections.lock()
      && let Some(conn) = conns.get(&id)
    {
      return Ok(conn.clone());
    }
    Err(JsErrorBox::generic(format!("Invalid database connection ID: {id}")))
  }
}

pub static GLOBAL_SQL: std::sync::LazyLock<SqlEngine> = std::sync::LazyLock::new(SqlEngine::new);

fn json_to_sqlite(val: &serde_json::Value) -> Box<dyn ToSql> {
  match val {
    serde_json::Value::Null => Box::new(rusqlite::types::Null),
    serde_json::Value::Bool(b) => Box::new(*b),
    serde_json::Value::Number(n) => {
      if let Some(i) = n.as_i64() {
        Box::new(i)
      } else if let Some(f) = n.as_f64() {
        Box::new(f)
      } else {
        Box::new(n.to_string())
      }
    }
    serde_json::Value::String(s) => Box::new(s.clone()),
    serde_json::Value::Array(_) | serde_json::Value::Object(_) => Box::new(val.to_string()),
  }
}

fn sqlite_to_json(val: ValueRef) -> serde_json::Value {
  match val {
    ValueRef::Null => serde_json::Value::Null,
    ValueRef::Integer(i) => serde_json::Value::Number(i.into()),
    ValueRef::Real(f) => serde_json::Number::from_f64(f)
      .map(serde_json::Value::Number)
      .unwrap_or(serde_json::Value::Null),
    ValueRef::Text(s) => {
      let text = String::from_utf8_lossy(s).to_string();
      serde_json::Value::String(text)
    }
    ValueRef::Blob(b) => {
      let arr: Vec<serde_json::Value> = b.iter().map(|&byte| serde_json::Value::Number(byte.into())).collect();
      serde_json::Value::Array(arr)
    }
  }
}

// ---------------------------------------------------------------------------
// SQL Ops exposed to JavaScript
// ---------------------------------------------------------------------------

#[op2(fast)]
pub fn op_sql_open(#[string] path: String) -> Result<u32, JsErrorBox> {
  if path != ":memory:" && !path.is_empty() {
    crate::permissions::check_read(&path)?;
    crate::permissions::check_write(&path)?;
  }
  GLOBAL_SQL.open(&path)
}

#[op2(fast)]
pub fn op_sql_close(id: u32) -> bool {
  GLOBAL_SQL.close(id)
}

#[op2]
pub fn op_sql_exec(id: u32, #[string] sql: String, #[serde] params: Vec<serde_json::Value>) -> Result<f64, JsErrorBox> {
  let conn_arc = GLOBAL_SQL.get_conn(id)?;
  let conn = conn_arc.lock().map_err(|e| JsErrorBox::generic(e.to_string()))?;

  let sql_params: Vec<Box<dyn ToSql>> = params.iter().map(json_to_sqlite).collect();
  let param_refs: Vec<&dyn ToSql> = sql_params.iter().map(|b| b.as_ref()).collect();

  let rows_affected = conn
    .execute(&sql, param_refs.as_slice())
    .map_err(|e| JsErrorBox::generic(format!("sqlite exec error: {e}")))?;

  Ok(rows_affected as f64)
}

#[op2(fast)]
pub fn op_sql_last_insert_rowid(id: u32) -> Result<f64, JsErrorBox> {
  let conn_arc = GLOBAL_SQL.get_conn(id)?;
  let conn = conn_arc.lock().map_err(|e| JsErrorBox::generic(e.to_string()))?;
  Ok(conn.last_insert_rowid() as f64)
}

#[op2]
#[serde]
pub fn op_sql_query(
  id: u32,
  #[string] sql: String,
  #[serde] params: Vec<serde_json::Value>,
) -> Result<Vec<HashMap<String, serde_json::Value>>, JsErrorBox> {
  let conn_arc = GLOBAL_SQL.get_conn(id)?;
  let conn = conn_arc.lock().map_err(|e| JsErrorBox::generic(e.to_string()))?;

  let sql_params: Vec<Box<dyn ToSql>> = params.iter().map(json_to_sqlite).collect();
  let param_refs: Vec<&dyn ToSql> = sql_params.iter().map(|b| b.as_ref()).collect();

  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| JsErrorBox::generic(format!("sqlite prepare error: {e}")))?;

  let column_names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();

  let mut rows = stmt
    .query(param_refs.as_slice())
    .map_err(|e| JsErrorBox::generic(format!("sqlite query error: {e}")))?;

  let mut results = Vec::new();
  while let Some(row) = rows.next().map_err(|e| JsErrorBox::generic(e.to_string()))? {
    let mut obj = HashMap::new();
    for (i, name) in column_names.iter().enumerate() {
      let val_ref = row.get_ref(i).map_err(|e| JsErrorBox::generic(e.to_string()))?;
      obj.insert(name.clone(), sqlite_to_json(val_ref));
    }
    results.push(obj);
  }

  Ok(results)
}
