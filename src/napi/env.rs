//! N-API environment state and DRY FFI helpers.

use std::ffi::CStr;
use std::ffi::CString;
use std::ffi::c_char;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use deno_core::v8;
use tokio::sync::mpsc;

use super::types::*;

// Compile-time guarantee that `v8::Local<'s, v8::Value>` is pointer-sized.
const _: () = assert!(
  std::mem::size_of::<v8::Local<'static, v8::Value>>() == std::mem::size_of::<NapiValue>()
);

pub enum NapiEvent {
  AsyncWorkComplete {
    work: usize,
  },
  ThreadsafeCall {
    tsfn: usize,
    data: usize,
  },
  ThreadsafeFinalize {
    tsfn: usize,
  },
  PostFinalizer {
    cb: NapiFinalize,
    data: usize,
    hint: usize,
  },
}

pub struct InstanceData {
  pub data: *mut c_void,
  pub finalize_cb: Option<NapiFinalize>,
  pub finalize_hint: *mut c_void,
}

pub struct NapiEnvInner {
  pub scope_ptr: *mut c_void,
  pub last_error: NapiExtendedErrorInfo,
  pub last_error_msg: CString,
  pub pending_exception: Option<v8::Global<v8::Value>>,
  pub handle_scope_stack: Vec<bool>,
  pub callback_scope_depth: usize,
  pub instance_data: Option<InstanceData>,
  pub cleanup_hooks: Vec<(NapiCleanupHook, *mut c_void)>,
  pub weak_handles: Vec<v8::Weak<v8::Value>>,
  pub wrap_private_key: v8::Global<v8::Private>,
  pub type_tag_private_key: v8::Global<v8::Private>,
  pub event_tx: mpsc::UnboundedSender<NapiEvent>,
  pub event_rx: Option<mpsc::UnboundedReceiver<NapiEvent>>,
  pub active_async_count: Arc<AtomicUsize>,
  pub module_filename: CString,
}

impl NapiEnvInner {
  pub fn new(scope: &mut v8::PinScope<'_, '_>) -> Box<Self> {
    let wrap_key = v8::Private::for_api(scope, Some(v8::String::new(scope, "__napi_wrap").unwrap()));
    let tag_key =
      v8::Private::for_api(scope, Some(v8::String::new(scope, "__napi_type_tag").unwrap()));
    let wrap_private_key = v8::Global::new(scope, wrap_key);
    let type_tag_private_key = v8::Global::new(scope, tag_key);
    let (event_tx, event_rx) = mpsc::unbounded_channel();

    Box::new(Self {
      scope_ptr: std::ptr::null_mut(),
      last_error: NapiExtendedErrorInfo {
        error_message: std::ptr::null(),
        engine_reserved: std::ptr::null_mut(),
        engine_error_code: 0,
        error_code: NAPI_OK,
      },
      last_error_msg: CString::default(),
      pending_exception: None,
      handle_scope_stack: Vec::new(),
      callback_scope_depth: 0,
      instance_data: None,
      cleanup_hooks: Vec::new(),
      weak_handles: Vec::new(),
      wrap_private_key,
      type_tag_private_key,
      event_tx,
      event_rx: Some(event_rx),
      active_async_count: Arc::new(AtomicUsize::new(0)),
      module_filename: CString::default(),
    })
  }

  pub fn set_last_error(&mut self, status: NapiStatus, msg: &str) {
    self.last_error_msg = CString::new(msg).unwrap_or_default();
    self.last_error.error_code = status;
    self.last_error.error_message = self.last_error_msg.as_ptr();
  }

  pub fn clear_last_error(&mut self) {
    self.last_error.error_code = NAPI_OK;
    self.last_error.error_message = std::ptr::null();
    self.last_error.engine_error_code = 0;
  }
}

impl Drop for NapiEnvInner {
  fn drop(&mut self) {
    let env_ptr: NapiEnv = self as *mut NapiEnvInner;
    let hooks = std::mem::take(&mut self.cleanup_hooks);
    for (hook, arg) in hooks.into_iter().rev() {
      unsafe { hook(arg) };
    }
    if let Some(inst) = self.instance_data.take()
      && let Some(cb) = inst.finalize_cb
    {
      unsafe { cb(env_ptr, inst.data, inst.finalize_hint) };
    }
  }
}

/// RAII guard that binds a live `v8::PinScope` to `NapiEnvInner` and restores
/// the previous pointer on drop (supporting re-entrant JS <-> C calls).
pub struct ScopeGuard {
  env: *mut NapiEnvInner,
  prev_scope: *mut c_void,
}

impl ScopeGuard {
  pub unsafe fn enter<'s, 'i>(env: *mut NapiEnvInner, scope: &mut v8::PinScope<'s, 'i>) -> Self {
    let prev_scope = unsafe { (*env).scope_ptr };
    unsafe {
      (*env).scope_ptr = scope as *mut v8::PinScope<'s, 'i> as *mut c_void;
    }
    Self { env, prev_scope }
  }
}

impl Drop for ScopeGuard {
  fn drop(&mut self) {
    unsafe {
      (*self.env).scope_ptr = self.prev_scope;
    }
  }
}

pub fn status_message(status: NapiStatus) -> &'static str {
  match status {
    NAPI_OK => "",
    NAPI_INVALID_ARG => "Invalid argument",
    NAPI_OBJECT_EXPECTED => "An object was expected",
    NAPI_STRING_EXPECTED => "A string was expected",
    NAPI_NAME_EXPECTED => "A string or symbol was expected",
    NAPI_FUNCTION_EXPECTED => "A function was expected",
    NAPI_NUMBER_EXPECTED => "A number was expected",
    NAPI_BOOLEAN_EXPECTED => "A boolean was expected",
    NAPI_ARRAY_EXPECTED => "An array was expected",
    NAPI_GENERIC_FAILURE => "Generic failure",
    NAPI_PENDING_EXCEPTION => "Pending exception",
    NAPI_CANCELLED => "Cancelled",
    NAPI_ESCAPE_CALLED_TWICE => "Escape called twice",
    NAPI_HANDLE_SCOPE_MISMATCH => "Handle scope mismatch",
    NAPI_CALLBACK_SCOPE_MISMATCH => "Callback scope mismatch",
    NAPI_QUEUE_FULL => "Queue full",
    NAPI_CLOSING => "Closing",
    NAPI_BIGINT_EXPECTED => "A BigInt was expected",
    NAPI_DATE_EXPECTED => "A Date was expected",
    NAPI_ARRAYBUFFER_EXPECTED => "An ArrayBuffer was expected",
    NAPI_DETACHABLE_ARRAYBUFFER_EXPECTED => "A detachable ArrayBuffer was expected",
    NAPI_WOULD_DEADLOCK => "Would deadlock",
    NAPI_NO_EXTERNAL_BUFFERS_ALLOWED => "No external buffers allowed",
    NAPI_CANNOT_RUN_JS => "Cannot run JS",
    _ => "Unknown N-API error",
  }
}

/// Execute an N-API operation that requires both a valid `NapiEnv` and an active `v8::PinScope`.
#[inline]
pub unsafe fn with_env<F>(env: NapiEnv, f: F) -> NapiStatus
where
  F: for<'s, 'i> FnOnce(&mut NapiEnvInner, &mut v8::PinScope<'s, 'i>) -> Result<(), NapiStatus>,
{
  if env.is_null() {
    return NAPI_INVALID_ARG;
  }
  let inner = unsafe { &mut *env };
  if inner.scope_ptr.is_null() {
    inner.set_last_error(NAPI_GENERIC_FAILURE, "No active V8 scope");
    return NAPI_GENERIC_FAILURE;
  }
  inner.clear_last_error();
  let scope = unsafe { &mut *(inner.scope_ptr as *mut v8::PinScope<'_, '_>) };
  match f(inner, scope) {
    Ok(()) => NAPI_OK,
    Err(status) => {
      inner.set_last_error(status, status_message(status));
      status
    }
  }
}

/// Execute an N-API operation that only needs `NapiEnvInner` (e.g. `node_api_basic_env`).
#[inline]
pub unsafe fn with_env_basic<F>(env: NapiEnv, f: F) -> NapiStatus
where
  F: FnOnce(&mut NapiEnvInner) -> Result<(), NapiStatus>,
{
  if env.is_null() {
    return NAPI_INVALID_ARG;
  }
  let inner = unsafe { &mut *env };
  inner.clear_last_error();
  match f(inner) {
    Ok(()) => NAPI_OK,
    Err(status) => {
      inner.set_last_error(status, status_message(status));
      status
    }
  }
}

#[inline]
pub fn to_napi_value<'s, T: Into<v8::Local<'s, v8::Value>>>(val: T) -> NapiValue {
  let local: v8::Local<'s, v8::Value> = val.into();
  unsafe { std::mem::transmute::<v8::Local<'s, v8::Value>, NapiValue>(local) }
}

#[inline]
pub unsafe fn from_napi_value<'s>(val: NapiValue) -> Result<v8::Local<'s, v8::Value>, NapiStatus> {
  if val.is_null() {
    return Err(NAPI_INVALID_ARG);
  }
  let nn = unsafe { NonNull::new_unchecked(val) };
  Ok(unsafe { std::mem::transmute::<NonNull<c_void>, v8::Local<'s, v8::Value>>(nn) })
}

#[inline]
pub unsafe fn from_napi_object<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  val: NapiValue,
) -> Result<v8::Local<'s, v8::Object>, NapiStatus> {
  let v = unsafe { from_napi_value(val)? };
  v.to_object(scope).ok_or(NAPI_OBJECT_EXPECTED)
}

#[inline]
pub unsafe fn write_out<T>(out: *mut T, val: T) -> Result<(), NapiStatus> {
  if out.is_null() {
    return Err(NAPI_INVALID_ARG);
  }
  unsafe { *out = val };
  Ok(())
}

pub unsafe fn read_c_str(ptr: *const c_char, len: usize) -> Result<String, NapiStatus> {
  if ptr.is_null() {
    return Err(NAPI_INVALID_ARG);
  }
  if len == NAPI_AUTO_LENGTH {
    let cstr = unsafe { CStr::from_ptr(ptr) };
    Ok(cstr.to_string_lossy().into_owned())
  } else {
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
    Ok(String::from_utf8_lossy(bytes).into_owned())
  }
}

pub unsafe fn read_c_bytes(ptr: *const c_char, len: usize) -> Result<&'static [u8], NapiStatus> {
  if ptr.is_null() {
    return Err(NAPI_INVALID_ARG);
  }
  if len == NAPI_AUTO_LENGTH {
    Ok(unsafe { CStr::from_ptr(ptr) }.to_bytes())
  } else {
    Ok(unsafe { std::slice::from_raw_parts(ptr as *const u8, len) })
  }
}

/// Run a V8 operation inside a `TryCatch` scope; if V8 throws, store the
/// exception in `env.pending_exception` and return `Err(NAPI_PENDING_EXCEPTION)`.
pub fn run_with_try_catch<'s, R>(
  scope: &mut v8::PinScope<'s, '_>,
  env: &mut NapiEnvInner,
  f: impl FnOnce(&mut v8::PinScope<'s, '_>) -> Option<R>,
) -> Result<R, NapiStatus> {
  v8::tc_scope!(let tc, scope);
  match f(tc) {
    Some(res) => Ok(res),
    None => {
      if let Some(exc) = tc.exception() {
        env.pending_exception = Some(v8::Global::new(tc, exc));
        Err(NAPI_PENDING_EXCEPTION)
      } else {
        Err(NAPI_GENERIC_FAILURE)
      }
    }
  }
}

/// Attach a guaranteed V8 weak finalizer to a `v8::Value`.
pub fn attach_finalizer<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  env: &mut NapiEnvInner,
  val: v8::Local<'s, v8::Value>,
  data: *mut c_void,
  finalize_cb: NapiFinalize,
  finalize_hint: *mut c_void,
) {
  let env_addr = env as *mut NapiEnvInner as usize;
  let data_addr = data as usize;
  let hint_addr = finalize_hint as usize;
  let weak = v8::Weak::with_guaranteed_finalizer(
    scope,
    val,
    Box::new(move || unsafe {
      finalize_cb(
        env_addr as NapiEnv,
        data_addr as *mut c_void,
        hint_addr as *mut c_void,
      );
    }),
  );
  env.weak_handles.push(weak);
}

/// Notify JS event loop to ref the N-API event pump when async work / TSFNs are active.
pub fn notify_js_async_ref(scope: &mut v8::PinScope<'_, '_>) {
  let global = scope.get_current_context().global(scope);
  if let Some(key) = v8::String::new(scope, "__jseNapiRefresh")
    && let Some(val) = global.get(scope, key.into())
    && let Ok(func) = v8::Local::<v8::Function>::try_from(val)
  {
    let undef = v8::undefined(scope).into();
    func.call(scope, undef, &[]);
  }
}

// ---------------------------------------------------------------------------
// Exported N-API env, version, and handle-scope functions
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_last_error_info(
  env: NapiEnv,
  result: *mut *const NapiExtendedErrorInfo,
) -> NapiStatus {
  if env.is_null() || result.is_null() {
    return NAPI_INVALID_ARG;
  }
  unsafe {
    *result = &(*env).last_error as *const NapiExtendedErrorInfo;
  }
  NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_version(env: NapiEnv, result: *mut u32) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| write_out(result, NAPI_VERSION_SUPPORTED))
  }
}

static NODE_RELEASE: &[u8] = b"node\0";
static NODE_VERSION_INFO: NapiNodeVersion = NapiNodeVersion {
  major: 22,
  minor: 0,
  patch: 0,
  release: NODE_RELEASE.as_ptr() as *const c_char,
};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_node_version(
  env: NapiEnv,
  version: *mut *const NapiNodeVersion,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| write_out(version, &NODE_VERSION_INFO as *const NapiNodeVersion))
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_get_module_file_name(
  env: NapiEnv,
  result: *mut *const c_char,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| write_out(result, inner.module_filename.as_ptr()))
  }
}

static mut DUMMY_UV_LOOP: usize = 0;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_uv_event_loop(
  env: NapiEnv,
  loop_: *mut *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| write_out(loop_, &raw mut DUMMY_UV_LOOP as *mut c_void))
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_set_instance_data(
  env: NapiEnv,
  data: *mut c_void,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      inner.instance_data = Some(InstanceData {
        data,
        finalize_cb,
        finalize_hint,
      });
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_instance_data(
  env: NapiEnv,
  data: *mut *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let ptr = inner
        .instance_data
        .as_ref()
        .map_or(std::ptr::null_mut(), |d| d.data);
      write_out(data, ptr)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_open_handle_scope(
  env: NapiEnv,
  result: *mut NapiHandleScope,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      inner.handle_scope_stack.push(false);
      let handle = inner.handle_scope_stack.len() as NapiHandleScope;
      write_out(result, handle)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_close_handle_scope(
  env: NapiEnv,
  scope: NapiHandleScope,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let expected = inner.handle_scope_stack.len() as NapiHandleScope;
      if scope.is_null() || scope != expected {
        return Err(NAPI_HANDLE_SCOPE_MISMATCH);
      }
      inner.handle_scope_stack.pop();
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_open_escapable_handle_scope(
  env: NapiEnv,
  result: *mut NapiEscapableHandleScope,
) -> NapiStatus {
  unsafe { napi_open_handle_scope(env, result) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_close_escapable_handle_scope(
  env: NapiEnv,
  scope: NapiEscapableHandleScope,
) -> NapiStatus {
  unsafe { napi_close_handle_scope(env, scope) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_escape_handle(
  env: NapiEnv,
  scope: NapiEscapableHandleScope,
  escapee: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let expected = inner.handle_scope_stack.len() as NapiEscapableHandleScope;
      if scope.is_null() || scope != expected {
        return Err(NAPI_HANDLE_SCOPE_MISMATCH);
      }
      let escaped = inner
        .handle_scope_stack
        .last_mut()
        .ok_or(NAPI_HANDLE_SCOPE_MISMATCH)?;
      if *escaped {
        return Err(NAPI_ESCAPE_CALLED_TWICE);
      }
      *escaped = true;
      write_out(result, escapee)
    })
  }
}
