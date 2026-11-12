//! N-API -- native addon loading (.node files via dlopen).
//!
//! The N-API function table (napi_create_string, napi_get_property, etc.)
//! requires bridging extern "C" to deno_core's PinScope<HandleScope> API.
//! This module provides the loading infrastructure. The function table
//! will use deno_core's scope management when integrated.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub type NapiStatus = i32;

type InitFn = unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void;

static LOADED: Mutex<Option<HashMap<String, libloading::Library>>> = Mutex::new(None);

/// dlopen a .node file, verify init symbol, return JS wrapper.
pub fn load_native_addon(path: &Path) -> Result<String, String> {
  let s = path.display().to_string();
  let lib = unsafe { libloading::Library::new(path).map_err(|e| format!("dlopen {s}: {e}"))? };
  let _: libloading::Symbol<InitFn> = unsafe {
    lib
      .get(b"napi_register_module_v1")
      .map_err(|_| format!("{s}: missing napi_register_module_v1"))?
  };
  LOADED
    .lock()
    .unwrap()
    .get_or_insert_with(HashMap::new)
    .insert(s.clone(), lib);
  Ok(format!("module.exports = Deno.core.ops.op_napi_init({s:?});"))
}

pub fn available() -> bool {
  true
}
