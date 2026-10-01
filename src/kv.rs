// src/kv.rs - Process-local native shared key-value store.
// Provides high-performance, thread-safe, concurrent key-value caching living in
// native Rust memory outside the V8 heap. Reads still allocate on the JS heap.

use deno_core::op2;
use deno_error::JsErrorBox;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct KvEntry {
  pub value: Vec<u8>,
  pub expires_at: Option<Instant>,
  pub version: u64,
}
#[derive(Default)]
struct KvState {
  entries: HashMap<String, KvEntry>,
  expiry: BTreeSet<(Instant, String)>,
  bytes: usize,
}
impl KvState {
  fn cost(key: &str, entry: &KvEntry) -> usize {
    key.len()
      + entry.value.len()
      + std::mem::size_of::<KvEntry>()
      + if entry.expires_at.is_some() {
        key.len() + std::mem::size_of::<(Instant, String)>()
      } else {
        0
      }
  }
  fn remove(&mut self, key: &str) -> Option<KvEntry> {
    let entry = self.entries.remove(key)?;
    self.bytes -= Self::cost(key, &entry);
    if let Some(expiry) = entry.expires_at {
      self.expiry.remove(&(expiry, key.to_owned()));
    }
    Some(entry)
  }
  fn sweep(&mut self, now: Instant, budget: usize) {
    for _ in 0..budget {
      if !self.expiry.first().is_some_and(|(time, _)| *time <= now) {
        break;
      }
      let (_, key) = self.expiry.pop_first().unwrap();
      self.remove(&key);
    }
  }
}
pub struct KvStore {
  state: RwLock<KvState>,
  version_counter: std::sync::atomic::AtomicU64,
  max_keys: usize,
  max_bytes: usize,
}
impl Default for KvStore {
  fn default() -> Self {
    Self::new()
  }
}
impl KvStore {
  pub fn new() -> Self {
    Self::with_limits(100_000, 64 * 1024 * 1024)
  }
  pub fn with_limits(max_keys: usize, max_bytes: usize) -> Self {
    Self {
      state: RwLock::new(KvState::default()),
      version_counter: std::sync::atomic::AtomicU64::new(1),
      max_keys,
      max_bytes,
    }
  }
  fn put(
    &self,
    state: &mut KvState,
    key: String,
    value: Vec<u8>,
    expires_at: Option<Instant>,
  ) -> Result<u64, JsErrorBox> {
    let mut entry = KvEntry {
      value,
      expires_at,
      version: 0,
    };
    let old_cost = state.entries.get(&key).map_or(0, |old| KvState::cost(&key, old));
    let new_bytes = state.bytes - old_cost + KvState::cost(&key, &entry);
    if new_bytes > self.max_bytes || (!state.entries.contains_key(&key) && state.entries.len() >= self.max_keys) {
      return Err(JsErrorBox::range_error("KV capacity exceeded"));
    }
    entry.version = self.version_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let version = entry.version;
    state.remove(&key);
    if let Some(time) = expires_at {
      state.expiry.insert((time, key.clone()));
    }
    state.entries.insert(key, entry);
    state.bytes = new_bytes;
    Ok(version)
  }
  fn expiry(ttl_ms: Option<u64>, now: Instant) -> Result<Option<Instant>, JsErrorBox> {
    ttl_ms
      .map(|ms| {
        now
          .checked_add(Duration::from_millis(ms))
          .ok_or_else(|| JsErrorBox::range_error("KV TTL overflow"))
      })
      .transpose()
  }
  fn sweep_at(&self, now: Instant) {
    if let Ok(mut state) = self.state.write() {
      state.sweep(now, 128);
    }
  }
  pub fn get(&self, key: &str) -> Option<(Vec<u8>, u64)> {
    let now = Instant::now();
    let mut state = self.state.write().ok()?;
    state.sweep(now, 128);
    let entry = state.entries.get(key)?;
    if entry.expires_at.is_some_and(|time| time <= now) {
      state.remove(key);
      return None;
    }
    Some((entry.value.clone(), entry.version))
  }
  pub fn set(&self, key: String, value: Vec<u8>, ttl_ms: Option<u64>) -> Result<u64, JsErrorBox> {
    let now = Instant::now();
    let mut state = self.state.write().map_err(|e| JsErrorBox::generic(e.to_string()))?;
    state.sweep(now, 128);
    self.put(&mut state, key, value, Self::expiry(ttl_ms, now)?)
  }
  pub fn delete(&self, key: &str) -> bool {
    self.state.write().is_ok_and(|mut state| state.remove(key).is_some())
  }
  pub fn has(&self, key: &str) -> bool {
    self.get(key).is_some()
  }
  pub fn clear(&self) {
    if let Ok(mut state) = self.state.write() {
      *state = KvState::default();
    }
  }
  pub fn keys(&self, prefix: Option<&str>) -> Vec<String> {
    let now = Instant::now();
    self.sweep_at(now);
    self
      .state
      .read()
      .map(|state| {
        state
          .entries
          .iter()
          .filter(|(key, entry)| {
            !entry.expires_at.is_some_and(|time| time <= now) && prefix.is_none_or(|p| key.starts_with(p))
          })
          .map(|(key, _)| key.clone())
          .collect()
      })
      .unwrap_or_default()
  }
  pub fn atomic_incr(&self, key: &str, amount: i64) -> Result<i64, JsErrorBox> {
    let now = Instant::now();
    let mut state = self.state.write().map_err(|e| JsErrorBox::generic(e.to_string()))?;
    state.sweep(now, 128);
    let entry = state
      .entries
      .get(key)
      .filter(|entry| entry.expires_at.is_none_or(|time| time > now));
    let value = match entry {
      Some(entry) => std::str::from_utf8(&entry.value)
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| JsErrorBox::type_error("KV counter is not an integer"))?,
      None => 0,
    };
    let expiry = entry.and_then(|e| e.expires_at);
    let value = value
      .checked_add(amount)
      .ok_or_else(|| JsErrorBox::range_error("KV counter overflow"))?;
    self.put(&mut state, key.to_owned(), value.to_string().into_bytes(), expiry)?;
    Ok(value)
  }
  pub fn cas(&self, key: &str, expected_version: u64, value: Vec<u8>, ttl_ms: Option<u64>) -> Result<bool, JsErrorBox> {
    let now = Instant::now();
    let mut state = self.state.write().map_err(|e| JsErrorBox::generic(e.to_string()))?;
    state.sweep(now, 128);
    let version = state
      .entries
      .get(key)
      .filter(|e| e.expires_at.is_none_or(|time| time > now))
      .map_or(0, |e| e.version);
    if version != expected_version {
      return Ok(false);
    }
    self.put(&mut state, key.to_owned(), value, Self::expiry(ttl_ms, now)?)?;
    Ok(true)
  }
  pub fn stats(&self) -> KvStats {
    let now = Instant::now();
    self.sweep_at(now);
    let Ok(state) = self.state.read() else {
      return KvStats::default();
    };
    let expired = state
      .entries
      .values()
      .filter(|e| e.expires_at.is_some_and(|time| time <= now))
      .count();
    KvStats {
      total_keys: state.entries.len(),
      active_keys: state.entries.len() - expired,
      expired_keys: expired,
      memory_bytes: state.bytes,
    }
  }
}

pub static GLOBAL_KV: LazyLock<Arc<KvStore>> = LazyLock::new(|| {
  let store = Arc::new(KvStore::new());
  let weak = Arc::downgrade(&store);
  // A bounded expiry index sweep reclaims unread keys independently of JS activity.
  std::thread::Builder::new()
    .name("malia-kv-expiry".into())
    .spawn(move || {
      loop {
        std::thread::sleep(Duration::from_millis(100));
        let Some(store) = weak.upgrade() else {
          break;
        };
        store.sweep_at(Instant::now());
      }
    })
    .expect("start KV expiry sweeper");
  store
});

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
pub fn op_kv_set(#[string] key: String, #[buffer] value: &[u8], ttl_ms: Option<f64>) -> Result<u64, JsErrorBox> {
  let ttl = validated_ttl(ttl_ms)?;
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
  if !amount.is_finite() || amount.fract() != 0.0 || amount.abs() > 9007199254740991.0 {
    return Err(JsErrorBox::range_error("KV increment must be a safe integer"));
  }
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
  let ttl = validated_ttl(ttl_ms)?;
  GLOBAL_KV.cas(&key, expected_version, new_value.to_vec(), ttl)
}

#[op2]
#[serde]
pub fn op_kv_stats() -> KvStats {
  GLOBAL_KV.stats()
}

fn validated_ttl(value: Option<f64>) -> Result<Option<u64>, JsErrorBox> {
  value
    .map(|ms| {
      if !ms.is_finite() || ms < 0.0 || ms.fract() != 0.0 || ms > 2147483647.0 {
        Err(JsErrorBox::range_error(
          "KV TTL must be an integer from 0 to 2147483647 ms",
        ))
      } else {
        Ok(ms as u64)
      }
    })
    .transpose()
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn mal_010_budgets_cas_and_expiry_index() {
    let store = KvStore::with_limits(2, 1024);
    let version = store.set("a".into(), vec![1], None).unwrap();
    store.set("b".into(), vec![2], None).unwrap();
    assert!(store.set("c".into(), vec![3], None).is_err());
    assert!(store.set("a".into(), vec![0; 2048], None).is_err());
    assert_eq!(store.get("a").unwrap().1, version);
    assert!(!store.cas("a", version + 1, vec![], None).unwrap());
    assert!(store.cas("a", version, vec![4], Some(1)).unwrap());
    store.sweep_at(Instant::now() + Duration::from_secs(1));
    assert!(store.get("a").is_none());
    assert_eq!(store.stats().total_keys, 1);
    assert!(store.state.read().unwrap().expiry.is_empty());
  }
  #[test]
  fn mal_010_expiration_reclaims_unread_entries() {
    let store = KvStore::new();
    store.set("expired".into(), vec![1; 1024], Some(0)).unwrap();
    assert_eq!(store.stats().total_keys, 0);
    assert_eq!(store.stats().memory_bytes, 0);
  }
}
