// src/kv.rs - Off-Heap Zero-GC Shared Key-Value Store.
// Provides high-performance, thread-safe, concurrent key-value caching living in
// native Rust memory outside the V8 heap. Eliminates GC pause overhead for large datasets.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};
use deno_core::op2;
use deno_error::JsErrorBox;

#[derive(Clone)]
pub struct KvEntry {
  pub value: Vec<u8>,
  pub expires_at: Option<Instant>,
  pub version: u64,
}

pub struct KvStore {
  entries: RwLock<HashMap<String, KvEntry>>,
  version_counter: std::sync::atomic::AtomicU64,
}

impl Default for KvStore {
  fn default() -> Self {
    Self::new()
  }
}

impl KvStore {
  pub fn new() -> Self {
    Self {
      entries: RwLock::new(HashMap::new()),
      version_counter: std::sync::atomic::AtomicU64::new(1),
    }
  }

  pub fn get(&self, key: &str) -> Option<(Vec<u8>, u64)> {
    let now = Instant::now();
    let map = self.entries.read().ok()?;
    if let Some(entry) = map.get(key) {
      if let Some(exp) = entry.expires_at
        && now >= exp
      {
        return None;
      }
      return Some((entry.value.clone(), entry.version));
    }
    None
  }

  pub fn set(&self, key: String, value: Vec<u8>, ttl_ms: Option<u64>) -> u64 {
    let now = Instant::now();
    let expires_at = ttl_ms.map(|ms| now + Duration::from_millis(ms));
    let version = self.version_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    if let Ok(mut map) = self.entries.write() {
      map.insert(key, KvEntry {
        value,
        expires_at,
        version,
      });
    }
    version
  }

  pub fn delete(&self, key: &str) -> bool {
    if let Ok(mut map) = self.entries.write() {
      map.remove(key).is_some()
    } else {
      false
    }
  }

  pub fn has(&self, key: &str) -> bool {
    self.get(key).is_some()
  }

  pub fn clear(&self) {
    if let Ok(mut map) = self.entries.write() {
      map.clear();
    }
  }

  pub fn keys(&self, prefix: Option<&str>) -> Vec<String> {
    let now = Instant::now();
    let map = match self.entries.read() {
      Ok(m) => m,
      Err(_) => return Vec::new(),
    };

    map
      .iter()
      .filter_map(|(k, v)| {
        if let Some(exp) = v.expires_at
          && now >= exp
        {
          return None;
        }
        if let Some(p) = prefix
          && !k.starts_with(p)
        {
          return None;
        }
        Some(k.clone())
      })
      .collect()
  }

  pub fn atomic_incr(&self, key: &str, amount: i64) -> Result<i64, JsErrorBox> {
    let mut map = self.entries.write().map_err(|e| JsErrorBox::generic(format!("lock error: {e}")))?;
    let now = Instant::now();

    let current_val: i64 = if let Some(entry) = map.get(key) {
      if let Some(exp) = entry.expires_at {
        if now >= exp {
          0
        } else {
          let s = std::str::from_utf8(&entry.value).unwrap_or("0");
          s.parse::<i64>().unwrap_or(0)
        }
      } else {
        let s = std::str::from_utf8(&entry.value).unwrap_or("0");
        s.parse::<i64>().unwrap_or(0)
      }
    } else {
      0
    };

    let new_val = current_val.saturating_add(amount);
    let version = self.version_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    map.insert(key.to_string(), KvEntry {
      value: new_val.to_string().into_bytes(),
      expires_at: None,
      version,
    });

    Ok(new_val)
  }

  pub fn cas(&self, key: &str, expected_version: u64, new_value: Vec<u8>, ttl_ms: Option<u64>) -> Result<bool, JsErrorBox> {
    let mut map = self.entries.write().map_err(|e| JsErrorBox::generic(format!("lock error: {e}")))?;
    let now = Instant::now();

    let current_version = if let Some(entry) = map.get(key) {
      if let Some(exp) = entry.expires_at {
        if now >= exp {
          0
        } else {
          entry.version
        }
      } else {
        entry.version
      }
    } else {
      0
    };

    if current_version != expected_version {
      return Ok(false);
    }

    let expires_at = ttl_ms.map(|ms| now + Duration::from_millis(ms));
    let version = self.version_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    map.insert(key.to_string(), KvEntry {
      value: new_value,
      expires_at,
      version,
    });

    Ok(true)
  }

  pub fn stats(&self) -> KvStats {
    let now = Instant::now();
    let map = match self.entries.read() {
      Ok(m) => m,
      Err(_) => return KvStats::default(),
    };

    let mut active = 0;
    let mut expired = 0;
    let mut total_bytes = 0;

    for (k, v) in map.iter() {
      let is_expired = v.expires_at.map(|exp| now >= exp).unwrap_or(false);
      if is_expired {
        expired += 1;
      } else {
        active += 1;
        total_bytes += k.len() + v.value.len() + std::mem::size_of::<KvEntry>();
      }
    }

    KvStats {
      total_keys: map.len(),
      active_keys: active,
      expired_keys: expired,
      memory_bytes: total_bytes,
    }
  }
}

pub static GLOBAL_KV: LazyLock<Arc<KvStore>> = LazyLock::new(|| Arc::new(KvStore::new()));

#[derive(serde::Serialize, Default)]
pub struct KvStats {
  pub total_keys: usize,
  pub active_keys: usize,
  pub expired_keys: usize,
  pub memory_bytes: usize,
}

#[derive(serde::Serialize)]
pub struct KvGetResult {
  pub found: bool,
  pub value: Option<Vec<u8>>,
  pub version: u64,
}

// ---------------------------------------------------------------------------
// Rust Ops exposed to JavaScript
// ---------------------------------------------------------------------------

#[op2]
#[serde]
pub fn op_kv_get(#[string] key: String) -> KvGetResult {
  if let Some((value, version)) = GLOBAL_KV.get(&key) {
    KvGetResult {
      found: true,
      value: Some(value),
      version,
    }
  } else {
    KvGetResult {
      found: false,
      value: None,
      version: 0,
    }
  }
}

#[op2]
#[serde]
pub fn op_kv_set(
  #[string] key: String,
  #[buffer] value: &[u8],
  ttl_ms: Option<f64>,
) -> u64 {
  let ttl = ttl_ms.filter(|&ms| ms > 0.0).map(|ms| ms as u64);
  GLOBAL_KV.set(key, value.to_vec(), ttl)
}

#[op2(fast)]
pub fn op_kv_delete(#[string] key: String) -> bool {
  GLOBAL_KV.delete(&key)
}

#[op2(fast)]
pub fn op_kv_has(#[string] key: String) -> bool {
  GLOBAL_KV.has(&key)
}

#[op2(fast)]
pub fn op_kv_clear() {
  GLOBAL_KV.clear();
}

#[op2]
#[serde]
pub fn op_kv_keys(#[string] prefix: Option<String>) -> Vec<String> {
  GLOBAL_KV.keys(prefix.as_deref())
}

#[op2(fast)]
pub fn op_kv_incr(#[string] key: String, amount: f64) -> Result<f64, JsErrorBox> {
  let res = GLOBAL_KV.atomic_incr(&key, amount as i64)?;
  Ok(res as f64)
}

#[op2]
pub fn op_kv_cas(
  #[string] key: String,
  #[serde] expected_version: u64,
  #[buffer] new_value: &[u8],
  ttl_ms: Option<f64>,
) -> Result<bool, JsErrorBox> {
  let ttl = ttl_ms.filter(|&ms| ms > 0.0).map(|ms| ms as u64);
  GLOBAL_KV.cas(&key, expected_version, new_value.to_vec(), ttl)
}

#[op2]
#[serde]
pub fn op_kv_stats() -> KvStats {
  GLOBAL_KV.stats()
}
