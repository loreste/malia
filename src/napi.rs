//! N-API (Node-API) -- C ABI bridge for native addons (.node files).
//!
//! Loads shared libraries via dlopen, calls napi_register_module_v1,
//! and exposes N-API functions so addons can create/read JS values.
//!
//! The V8 isolate pointer is stored in NapiEnv and passed to each call.
//! Addons run on the JS thread (same as Node) -- no thread safety issues.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::Mutex;

/// N-API status codes (matches node_api_types.h)
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub enum NapiStatus {
  Ok = 0,
  InvalidArg = 1,
  ObjectExpected = 2,
  StringExpected = 3,
  NameExpected = 4,
  FunctionExpected = 5,
  NumberExpected = 6,
  BooleanExpected = 7,
  ArrayExpected = 8,
  GenericFailure = 9,
  PendingException = 10,
  Cancelled = 11,
  EscapeCalledTwice = 12,
  HandleScopeMismatch = 13,
  CallbackScopeMismatch = 14,
  QueueFull = 15,
  Closing = 16,
  BigintExpected = 17,
  DateExpected = 18,
  ArraybufferExpected = 19,
  DetachableArraybufferExpected = 20,
  WouldDeadlock = 21,
  NoExternalBuffersAllowed = 22,
  CannotRunJs = 23,
}

/// N-API value types
#[repr(i32)]
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum NapiValueType {
  Undefined = 0,
  Null = 1,
  Boolean = 2,
  Number = 3,
  String = 4,
  Symbol = 5,
  Object = 6,
  Function = 7,
  External = 8,
  Bigint = 9,
}

/// Opaque N-API env handle. Stored per-addon, holds V8 isolate access.
#[repr(C)]
pub struct NapiEnv {
  _opaque: [u8; 0],
}

/// Opaque N-API value handle. In our impl, this is a boxed v8::Global.
#[repr(C)]
pub struct NapiValue {
  _opaque: [u8; 0],
}

/// Type for N-API callback functions
pub type NapiCallback = unsafe extern "C" fn(env: *mut NapiEnv, info: *mut c_void) -> *mut NapiValue;

/// Registry of loaded native addons (keeps libs alive).
static LOADED_ADDONS: Mutex<Option<HashMap<String, libloading::Library>>> = Mutex::new(None);

/// Load a .node native addon. Returns JS that delegates to the runtime's
/// napi bridge to call the init function and return the exports object.
pub fn load_native_addon(path: &Path) -> Result<String, String> {
  let path_str = path.display().to_string();

  let lib = unsafe { libloading::Library::new(path).map_err(|e| format!("dlopen {path_str}: {e}"))? };

  // Verify the addon has the N-API init symbol
  let _init: libloading::Symbol<unsafe extern "C" fn(*mut NapiEnv, *mut NapiValue) -> *mut NapiValue> = unsafe {
    lib
      .get(b"napi_register_module_v1")
      .map_err(|_| format!("{path_str}: missing napi_register_module_v1"))?
  };

  // Keep the library loaded
  let mut guard = LOADED_ADDONS.lock().unwrap();
  let map = guard.get_or_insert_with(HashMap::new);
  map.insert(path_str.clone(), lib);

  // The JS side calls __napi_init which invokes the C init function
  // through an op that has access to the V8 isolate.
  Ok(format!(
    "module.exports = Deno.core.ops.op_napi_init({path:?});",
    path = path_str
  ))
}

/// Called from op_napi_init -- actually invoke the addon's init function.
/// This must run on the JS thread with a valid V8 scope.
pub fn call_init(path: &str, isolate: *mut c_void, exports: *mut c_void) -> Result<*mut c_void, String> {
  let guard = LOADED_ADDONS.lock().unwrap();
  let map = guard.as_ref().ok_or("no addons loaded")?;
  let lib = map.get(path).ok_or_else(|| format!("{path}: not loaded"))?;

  let init: libloading::Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void> =
    unsafe { lib.get(b"napi_register_module_v1").map_err(|e| format!("{e}"))? };

  let result = unsafe { init(isolate, exports) };
  Ok(result)
}

pub fn available() -> bool {
  true
}
