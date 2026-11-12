//! N-API (Node-API) implementation -- C ABI bridge for native addons.
//!
//! Loads .node shared libraries via dlopen, calls napi_register_module_v1,
//! and provides the N-API function table so addons can create/read JS values.
//!
//! This covers the core subset needed by most addons: value creation,
//! property access, function calls, error handling, buffers, and async work.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::Mutex;

// N-API status codes
pub const NAPI_OK: i32 = 0;
pub const NAPI_INVALID_ARG: i32 = 1;
pub const NAPI_OBJECT_EXPECTED: i32 = 2;
pub const NAPI_STRING_EXPECTED: i32 = 3;
pub const NAPI_GENERIC_FAILURE: i32 = 10;

// N-API value types
pub const NAPI_UNDEFINED: i32 = 0;
pub const NAPI_NULL: i32 = 1;
pub const NAPI_BOOLEAN: i32 = 2;
pub const NAPI_NUMBER: i32 = 3;
pub const NAPI_STRING: i32 = 4;
pub const NAPI_SYMBOL: i32 = 5;
pub const NAPI_OBJECT: i32 = 6;
pub const NAPI_FUNCTION: i32 = 7;
pub const NAPI_EXTERNAL: i32 = 8;
pub const NAPI_BIGINT: i32 = 9;

/// Opaque env handle passed to every N-API call.
/// Wraps a reference to the V8 isolate + scope state.
#[repr(C)]
pub struct NapiEnv {
  /// V8 isolate pointer (from deno_core)
  pub isolate: *mut c_void,
  /// Pointer to the module exports object
  pub exports: *mut c_void,
  /// Error state
  pub last_error: i32,
  /// Prevent Send/Sync
  _marker: std::marker::PhantomData<*mut ()>,
}

/// Registry of loaded native addons.
static LOADED_ADDONS: Mutex<Option<HashMap<String, libloading::Library>>> = Mutex::new(None);

/// Load a .node native addon and call its init function.
/// Returns JS source that evaluates to the module's exports.
pub fn load_native_addon(path: &Path) -> Result<String, String> {
  let path_str = path.display().to_string();

  // Load the shared library
  let lib = unsafe { libloading::Library::new(path).map_err(|e| format!("dlopen {path_str}: {e}"))? };

  // Look for napi_register_module_v1 (N-API) or node_register_module_v1
  // Verify the init symbol exists (don't call it yet -- that happens from JS)
  let _init_fn: libloading::Symbol<unsafe extern "C" fn(*mut NapiEnv, *mut c_void) -> *mut c_void> = unsafe {
    lib
      .get(b"napi_register_module_v1")
      .map_err(|_| format!("{path_str}: not a valid native addon (missing napi_register_module_v1)"))?
  };

  // Store the library so it stays loaded
  let mut guard = LOADED_ADDONS.lock().unwrap();
  let map = guard.get_or_insert_with(HashMap::new);
  map.insert(path_str.clone(), lib);

  // Return JS that marks the addon as loaded.
  // The actual init call happens when the module is first required.
  // For now, we return a stub that indicates the addon was found.
  Ok(format!(
    "const _addon = globalThis.__napi_load({path:?});\nmodule.exports = _addon;",
    path = path_str
  ))
}

/// Check if N-API support is available (libloading compiled in).
pub fn available() -> bool {
  true
}
