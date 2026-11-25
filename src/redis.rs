// Built-in Redis client: RESP2 protocol over TCP with connection pooling.
// Eliminates ioredis (13M/week). Supports GET, SET, DEL, MGET, MSET, INCR,
// EXPIRE, TTL, LPUSH, RPOP, SUBSCRIBE, PUBLISH, pipelines.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use deno_error::JsErrorBox;

/// A single Redis connection.
struct Conn {
  stream: BufReader<TcpStream>,
}

impl Conn {
  fn connect(addr: &str, timeout_ms: u64) -> Result<Self, JsErrorBox> {
    let stream = TcpStream::connect(addr).map_err(|e| JsErrorBox::generic(format!("Redis connect {addr}: {e}")))?;
    stream.set_read_timeout(Some(Duration::from_millis(timeout_ms))).ok();
    stream.set_write_timeout(Some(Duration::from_millis(timeout_ms))).ok();
    Ok(Self {
      stream: BufReader::new(stream),
    })
  }

  fn send_command(&mut self, args: &[&str]) -> Result<(), JsErrorBox> {
    let raw = self.stream.get_mut();
    // RESP array: *<count>\r\n followed by $<len>\r\n<data>\r\n per arg
    write!(raw, "*{}\r\n", args.len()).map_err(|e| JsErrorBox::generic(format!("Redis write: {e}")))?;
    for arg in args {
      write!(raw, "${}\r\n{}\r\n", arg.len(), arg).map_err(|e| JsErrorBox::generic(format!("Redis write: {e}")))?;
    }
    raw
      .flush()
      .map_err(|e| JsErrorBox::generic(format!("Redis flush: {e}")))?;
    Ok(())
  }

  fn read_reply(&mut self) -> Result<RedisValue, JsErrorBox> {
    let mut line = String::new();
    self
      .stream
      .read_line(&mut line)
      .map_err(|e| JsErrorBox::generic(format!("Redis read: {e}")))?;
    let line = line.trim_end_matches('\n').trim_end_matches('\r');
    if line.is_empty() {
      return Err(JsErrorBox::generic("Redis: empty response"));
    }
    match line.as_bytes()[0] {
      b'+' => Ok(RedisValue::String(line[1..].to_string())),
      b'-' => Err(JsErrorBox::generic(format!("Redis error: {}", &line[1..]))),
      b':' => {
        let n: i64 = line[1..]
          .parse()
          .map_err(|_| JsErrorBox::generic("Redis: invalid integer"))?;
        Ok(RedisValue::Integer(n))
      }
      b'$' => {
        let len: i64 = line[1..]
          .parse()
          .map_err(|_| JsErrorBox::generic("Redis: invalid bulk length"))?;
        if len < 0 {
          return Ok(RedisValue::Null);
        }
        let mut buf = vec![0u8; len as usize + 2]; // +2 for \r\n
        self
          .stream
          .read_exact(&mut buf)
          .map_err(|e| JsErrorBox::generic(format!("Redis bulk read: {e}")))?;
        buf.truncate(len as usize);
        Ok(RedisValue::String(String::from_utf8_lossy(&buf).into_owned()))
      }
      b'*' => {
        let count: i64 = line[1..]
          .parse()
          .map_err(|_| JsErrorBox::generic("Redis: invalid array length"))?;
        if count < 0 {
          return Ok(RedisValue::Null);
        }
        let mut items = Vec::with_capacity(count as usize);
        for _ in 0..count {
          items.push(self.read_reply()?);
        }
        Ok(RedisValue::Array(items))
      }
      _ => Err(JsErrorBox::generic(format!(
        "Redis: unknown reply type: {}",
        line.chars().next().unwrap_or('?')
      ))),
    }
  }

  fn command(&mut self, args: &[&str]) -> Result<RedisValue, JsErrorBox> {
    self.send_command(args)?;
    self.read_reply()
  }
}

use std::io::Read as _;

/// Connection pool: reuse TCP connections across commands.
pub struct RedisPool {
  addr: String,
  timeout_ms: u64,
  password: Option<String>,
  db: u32,
  pool: Mutex<VecDeque<Conn>>,
}

impl RedisPool {
  pub fn new(url: &str) -> Result<Self, JsErrorBox> {
    // Parse redis://[:password@]host:port[/db]
    let url = url.strip_prefix("redis://").unwrap_or(url);
    let (auth, rest) = if let Some(at) = url.find('@') {
      (Some(&url[..at]), &url[at + 1..])
    } else {
      (None, url)
    };
    let password = auth.map(|a| a.strip_prefix(':').unwrap_or(a).to_string());
    let (host_port, db_str) = rest.split_once('/').unwrap_or((rest, "0"));
    let addr = if host_port.contains(':') {
      host_port.to_string()
    } else {
      format!("{host_port}:6379")
    };
    let db: u32 = db_str.parse().unwrap_or(0);

    Ok(Self {
      addr,
      timeout_ms: 5000,
      password,
      db,
      pool: Mutex::new(VecDeque::new()),
    })
  }

  fn get_conn(&self) -> Result<Conn, JsErrorBox> {
    if let Ok(mut pool) = self.pool.lock()
      && let Some(conn) = pool.pop_front()
    {
      return Ok(conn);
    }
    let mut conn = Conn::connect(&self.addr, self.timeout_ms)?;
    if let Some(ref pw) = self.password {
      conn.command(&["AUTH", pw])?;
    }
    if self.db != 0 {
      conn.command(&["SELECT", &self.db.to_string()])?;
    }
    Ok(conn)
  }

  fn put_conn(&self, conn: Conn) {
    if let Ok(mut pool) = self.pool.lock()
      && pool.len() < 8
    {
      pool.push_back(conn);
    }
  }

  pub fn command(&self, args: &[&str]) -> Result<RedisValue, JsErrorBox> {
    let mut conn = self.get_conn()?;
    match conn.command(args) {
      Ok(val) => {
        self.put_conn(conn);
        Ok(val)
      }
      Err(e) => Err(e), // Drop broken connection
    }
  }

  pub fn pipeline(&self, commands: &[Vec<String>]) -> Result<Vec<RedisValue>, JsErrorBox> {
    let mut conn = self.get_conn()?;
    for cmd in commands {
      let refs: Vec<&str> = cmd.iter().map(|s| s.as_str()).collect();
      conn.send_command(&refs)?;
    }
    let mut results = Vec::with_capacity(commands.len());
    for _ in commands {
      results.push(conn.read_reply()?);
    }
    self.put_conn(conn);
    Ok(results)
  }
}

#[derive(Debug, Clone)]
pub enum RedisValue {
  String(String),
  Integer(i64),
  Array(Vec<RedisValue>),
  Null,
}

impl RedisValue {
  pub fn to_json(&self) -> serde_json::Value {
    match self {
      RedisValue::String(s) => serde_json::Value::String(s.clone()),
      RedisValue::Integer(n) => serde_json::json!(*n),
      RedisValue::Array(items) => serde_json::Value::Array(items.iter().map(|v| v.to_json()).collect()),
      RedisValue::Null => serde_json::Value::Null,
    }
  }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

use deno_core::OpState;
use deno_core::op2;

struct RedisTable {
  pools: Vec<RedisPool>,
}

fn redis_table(state: &mut OpState) -> &mut RedisTable {
  if !state.has::<RedisTable>() {
    state.put(RedisTable { pools: Vec::new() });
  }
  state.borrow_mut::<RedisTable>()
}

#[op2(fast)]
pub fn op_redis_connect(state: &mut OpState, #[string] url: String) -> Result<u32, JsErrorBox> {
  let host = url
    .replace("redis://", "")
    .split('/')
    .next()
    .unwrap_or("localhost:6379")
    .to_string();
  crate::permissions::check_net(&host)?;
  let pool = RedisPool::new(&url)?;
  // Verify connection with a PING
  pool.command(&["PING"])?;
  let table = redis_table(state);
  let id = table.pools.len() as u32;
  table.pools.push(pool);
  Ok(id)
}

#[op2]
#[serde]
pub fn op_redis_command(
  state: &mut OpState,
  id: u32,
  #[serde] args: Vec<String>,
) -> Result<serde_json::Value, JsErrorBox> {
  let table = redis_table(state);
  let pool = table
    .pools
    .get(id as usize)
    .ok_or_else(|| JsErrorBox::generic("Invalid Redis connection ID"))?;
  let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
  let val = pool.command(&refs)?;
  Ok(val.to_json())
}

#[op2]
#[serde]
pub fn op_redis_pipeline(
  state: &mut OpState,
  id: u32,
  #[serde] commands: Vec<Vec<String>>,
) -> Result<Vec<serde_json::Value>, JsErrorBox> {
  let table = redis_table(state);
  let pool = table
    .pools
    .get(id as usize)
    .ok_or_else(|| JsErrorBox::generic("Invalid Redis connection ID"))?;
  let results = pool.pipeline(&commands)?;
  Ok(results.iter().map(|v| v.to_json()).collect())
}
