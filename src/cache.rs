// Shared on-disk cache helpers (TS transpile cache, V8 code cache).
//
// Cache root: $JSE_CACHE_DIR, else $TMPDIR/jse-cache-v<pkg>[-<v8>]/<subdir>.
// All writes are atomic (tmp file + rename) and all failures are ignored:
// caches are optimizations, never hard dependencies.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::path::PathBuf;

/// Deterministic hash of source contents (DefaultHasher::new is stable
/// across processes; only RandomState is randomized).
pub fn stable_hash(code: &str) -> u64 {
  let mut hasher = DefaultHasher::new();
  env!("CARGO_PKG_VERSION").hash(&mut hasher);
  code.hash(&mut hasher);
  hasher.finish()
}

fn cache_root() -> Option<PathBuf> {
  if let Ok(dir) = std::env::var("JSE_CACHE_DIR") {
    return Some(PathBuf::from(dir));
  }
  // The V8 code cache is only valid for one V8 build; the transpile cache
  // does not care but shares the directory for simplicity.
  let v8_version = deno_core::v8::V8::get_version();
  Some(
    std::env::temp_dir().join(format!(
      "jse-cache-v{}-{}",
      env!("CARGO_PKG_VERSION"),
      v8_version
    )),
  )
}

pub fn cache_dir(subdir: &str) -> Option<PathBuf> {
  cache_root().map(|root| root.join(subdir))
}

pub fn read(dir: &Path, name: &str) -> Option<Vec<u8>> {
  std::fs::read(dir.join(name)).ok()
}

pub fn write(dir: &Path, name: &str, bytes: &[u8]) {
  if std::fs::create_dir_all(dir).is_err() {
    return;
  }
  let tmp = dir.join(format!("{name}.tmp-{}", std::process::id()));
  if std::fs::write(&tmp, bytes).is_ok() {
    let _ = std::fs::rename(&tmp, dir.join(name));
  }
}
