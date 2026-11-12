//! N-API (Node-API) -- C ABI bridge for native addons (.node files).
//!
//! Loads .node shared libraries via dlopen, verifies napi_register_module_v1.
//! The N-API function table (napi_create_string, napi_get_property, etc.)
//! requires bridging extern "C" functions to V8's HandleScope-based API.
//! This module provides the loading infrastructure and type definitions.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::Mutex;

// -- Types -------------------------------------------------------------------

pub type NapiStatus = i32;
pub const NAPI_OK: NapiStatus = 0;
pub const NAPI_INVALID_ARG: NapiStatus = 1;
pub const NAPI_GENERIC_FAILURE: NapiStatus = 9;

pub type NapiValue = *mut c_void;

/// Opaque env handle passed to every N-API call.
#[repr(C)]
pub struct NapiEnv {
  _opaque: [u8; 0],
}

type InitFn = unsafe extern "C" fn(env: *mut NapiEnv, exports: NapiValue) -> NapiValue;

// -- Addon loading -----------------------------------------------------------

static LOADED_ADDONS: Mutex<Option<HashMap<String, libloading::Library>>> = Mutex::new(None);

/// Load a .node file: dlopen + verify init symbol. Returns JS wrapper source.
pub fn load_native_addon(path: &Path) -> Result<String, String> {
  let path_str = path.display().to_string();
  let lib = unsafe { libloading::Library::new(path).map_err(|e| format!("dlopen {path_str}: {e}"))? };

  // Verify init symbol exists
  let _init: libloading::Symbol<InitFn> = unsafe {
    lib
      .get(b"napi_register_module_v1")
      .map_err(|_| format!("{path_str}: missing napi_register_module_v1"))?
  };

  // Keep loaded
  let mut guard = LOADED_ADDONS.lock().unwrap();
  let map = guard.get_or_insert_with(HashMap::new);
  map.insert(path_str.clone(), lib);

  Ok(format!(
    "module.exports = Deno.core.ops.op_napi_init({path:?});",
    path = path_str
  ))
}

/// Check if an addon is loaded.
pub fn is_loaded(path: &str) -> bool {
  LOADED_ADDONS
    .lock()
    .unwrap()
    .as_ref()
    .is_some_and(|m| m.contains_key(path))
}

pub fn available() -> bool {
  true
}
