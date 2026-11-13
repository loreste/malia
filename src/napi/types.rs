//! N-API C ABI types, enums, and function pointer definitions.
//! Matches `js_native_api_types.h` and `node_api_types.h` (N-API v1..v10).

use std::ffi::c_char;
use std::ffi::c_void;

pub type NapiStatus = i32;

pub const NAPI_OK: NapiStatus = 0;
pub const NAPI_INVALID_ARG: NapiStatus = 1;
pub const NAPI_OBJECT_EXPECTED: NapiStatus = 2;
pub const NAPI_STRING_EXPECTED: NapiStatus = 3;
pub const NAPI_NAME_EXPECTED: NapiStatus = 4;
pub const NAPI_FUNCTION_EXPECTED: NapiStatus = 5;
pub const NAPI_NUMBER_EXPECTED: NapiStatus = 6;
pub const NAPI_BOOLEAN_EXPECTED: NapiStatus = 7;
pub const NAPI_ARRAY_EXPECTED: NapiStatus = 8;
pub const NAPI_GENERIC_FAILURE: NapiStatus = 9;
pub const NAPI_PENDING_EXCEPTION: NapiStatus = 10;
pub const NAPI_CANCELLED: NapiStatus = 11;
pub const NAPI_ESCAPE_CALLED_TWICE: NapiStatus = 12;
pub const NAPI_HANDLE_SCOPE_MISMATCH: NapiStatus = 13;
pub const NAPI_CALLBACK_SCOPE_MISMATCH: NapiStatus = 14;
pub const NAPI_QUEUE_FULL: NapiStatus = 15;
pub const NAPI_CLOSING: NapiStatus = 16;
pub const NAPI_BIGINT_EXPECTED: NapiStatus = 17;
pub const NAPI_DATE_EXPECTED: NapiStatus = 18;
pub const NAPI_ARRAYBUFFER_EXPECTED: NapiStatus = 19;
pub const NAPI_DETACHABLE_ARRAYBUFFER_EXPECTED: NapiStatus = 20;
pub const NAPI_WOULD_DEADLOCK: NapiStatus = 21;
pub const NAPI_NO_EXTERNAL_BUFFERS_ALLOWED: NapiStatus = 22;
pub const NAPI_CANNOT_RUN_JS: NapiStatus = 23;

pub const NAPI_AUTO_LENGTH: usize = usize::MAX;
pub const NAPI_VERSION_SUPPORTED: u32 = 9;

// napi_property_attributes
pub const NAPI_DEFAULT: i32 = 0;
pub const NAPI_WRITABLE: i32 = 1 << 0;
pub const NAPI_ENUMERABLE: i32 = 1 << 1;
pub const NAPI_CONFIGURABLE: i32 = 1 << 2;
pub const NAPI_STATIC: i32 = 1 << 10;

// napi_valuetype
pub type NapiValueType = i32;
pub const NAPI_UNDEFINED: NapiValueType = 0;
pub const NAPI_NULL: NapiValueType = 1;
pub const NAPI_BOOLEAN: NapiValueType = 2;
pub const NAPI_NUMBER: NapiValueType = 3;
pub const NAPI_STRING: NapiValueType = 4;
pub const NAPI_SYMBOL: NapiValueType = 5;
pub const NAPI_OBJECT: NapiValueType = 6;
pub const NAPI_FUNCTION: NapiValueType = 7;
pub const NAPI_EXTERNAL: NapiValueType = 8;
pub const NAPI_BIGINT: NapiValueType = 9;

// napi_typedarray_type
pub type NapiTypedArrayType = i32;
pub const NAPI_INT8_ARRAY: NapiTypedArrayType = 0;
pub const NAPI_UINT8_ARRAY: NapiTypedArrayType = 1;
pub const NAPI_UINT8_CLAMPED_ARRAY: NapiTypedArrayType = 2;
pub const NAPI_INT16_ARRAY: NapiTypedArrayType = 3;
pub const NAPI_UINT16_ARRAY: NapiTypedArrayType = 4;
pub const NAPI_INT32_ARRAY: NapiTypedArrayType = 5;
pub const NAPI_UINT32_ARRAY: NapiTypedArrayType = 6;
pub const NAPI_FLOAT32_ARRAY: NapiTypedArrayType = 7;
pub const NAPI_FLOAT64_ARRAY: NapiTypedArrayType = 8;
pub const NAPI_BIGINT64_ARRAY: NapiTypedArrayType = 9;
pub const NAPI_BIGUINT64_ARRAY: NapiTypedArrayType = 10;
pub const NAPI_FLOAT16_ARRAY: NapiTypedArrayType = 11;

// napi_key_collection_mode
pub const NAPI_KEY_INCLUDE_PROTOTYPES: i32 = 0;
pub const NAPI_KEY_OWN_ONLY: i32 = 1;

// napi_key_filter
pub const NAPI_KEY_ALL_PROPERTIES: i32 = 0;
pub const NAPI_KEY_WRITABLE: i32 = 1;
pub const NAPI_KEY_ENUMERABLE: i32 = 1 << 1;
pub const NAPI_KEY_CONFIGURABLE: i32 = 1 << 2;
pub const NAPI_KEY_SKIP_STRINGS: i32 = 1 << 3;
pub const NAPI_KEY_SKIP_SYMBOLS: i32 = 1 << 4;

// napi_key_conversion
pub const NAPI_KEY_KEEP_NUMBERS: i32 = 0;
pub const NAPI_KEY_NUMBERS_TO_STRINGS: i32 = 1;

// napi_threadsafe_function_release_mode
pub const NAPI_TSFN_RELEASE: i32 = 0;
pub const NAPI_TSFN_ABORT: i32 = 1;

// napi_threadsafe_function_call_mode
pub const NAPI_TSFN_NONBLOCKING: i32 = 0;
pub const NAPI_TSFN_BLOCKING: i32 = 1;

// Opaque C handles
pub type NapiEnv = *mut super::env::NapiEnvInner;
pub type NapiValue = *mut c_void;
pub type NapiRef = *mut c_void;
pub type NapiHandleScope = *mut c_void;
pub type NapiEscapableHandleScope = *mut c_void;
pub type NapiCallbackInfo = *mut c_void;
pub type NapiDeferred = *mut c_void;
pub type NapiAsyncContext = *mut c_void;
pub type NapiAsyncWork = *mut c_void;
pub type NapiCallbackScope = *mut c_void;
pub type NapiThreadsafeFunction = *mut c_void;
pub type NapiAsyncCleanupHookHandle = *mut c_void;

pub type NapiCallback = unsafe extern "C" fn(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue;
pub type NapiFinalize =
  unsafe extern "C" fn(env: NapiEnv, finalize_data: *mut c_void, finalize_hint: *mut c_void);
pub type NodeApiNoenvFinalize =
  unsafe extern "C" fn(finalize_data: *mut c_void, finalize_hint: *mut c_void);
pub type NapiAddonRegisterFunc =
  unsafe extern "C" fn(env: NapiEnv, exports: NapiValue) -> NapiValue;
pub type NapiCleanupHook = unsafe extern "C" fn(arg: *mut c_void);
pub type NapiAsyncCleanupHook =
  unsafe extern "C" fn(handle: NapiAsyncCleanupHookHandle, data: *mut c_void);
pub type NapiAsyncExecuteCallback = unsafe extern "C" fn(env: NapiEnv, data: *mut c_void);
pub type NapiAsyncCompleteCallback =
  unsafe extern "C" fn(env: NapiEnv, status: NapiStatus, data: *mut c_void);
pub type NapiThreadsafeFunctionCallJs = unsafe extern "C" fn(
  env: NapiEnv,
  js_callback: NapiValue,
  context: *mut c_void,
  data: *mut c_void,
);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NapiPropertyDescriptor {
  pub utf8name: *const c_char,
  pub name: NapiValue,
  pub method: Option<NapiCallback>,
  pub getter: Option<NapiCallback>,
  pub setter: Option<NapiCallback>,
  pub value: NapiValue,
  pub attributes: i32,
  pub data: *mut c_void,
}

#[repr(C)]
pub struct NapiExtendedErrorInfo {
  pub error_message: *const c_char,
  pub engine_reserved: *mut c_void,
  pub engine_error_code: u32,
  pub error_code: NapiStatus,
}

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct NapiTypeTag {
  pub lower: u64,
  pub upper: u64,
}

#[repr(C)]
pub struct NapiNodeVersion {
  pub major: u32,
  pub minor: u32,
  pub patch: u32,
  pub release: *const c_char,
}

unsafe impl Sync for NapiNodeVersion {}

#[repr(C)]
pub struct NapiModule {
  pub nm_version: i32,
  pub nm_flags: u32,
  pub nm_filename: *const c_char,
  pub nm_register_func: Option<NapiAddonRegisterFunc>,
  pub nm_modname: *const c_char,
  pub nm_priv: *mut c_void,
  pub reserved: [*mut c_void; 4],
}
