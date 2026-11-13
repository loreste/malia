//! N-API -- full Node-API (v1..v9) implementation for malia.
//!
//! Bridges `extern "C"` N-API functions to `deno_core` / `v8::PinScope`,
//! with native `.node` addon loading via `dlopen` and async event pumping.
//!
//! All extern "C" functions in this module are unsafe N-API C ABI entry points.

pub mod async_rt;
pub mod buffers;
pub mod env;
pub mod errors;
pub mod functions;
pub mod objects;
pub mod refs;
pub mod types;
pub mod values;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use deno_core::OpState;
use deno_core::v8;
use tokio::sync::mpsc;

use env::*;
use types::*;

// Re-export all `#[unsafe(no_mangle)] pub unsafe extern "C" fn` symbols
// so they are linked and referenced in `NAPI_SYMBOL_TABLE`.
use async_rt::*;
use buffers::*;
use errors::*;
use functions::*;
use objects::*;
use refs::*;
use values::*;

struct LoadedAddon {
  _lib: libloading::Library,
  init_fn: NapiAddonRegisterFunc,
}

static LOADED: Mutex<Option<HashMap<String, LoadedAddon>>> = Mutex::new(None);
static PENDING_REGISTER: Mutex<Option<NapiAddonRegisterFunc>> = Mutex::new(None);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_module_register(mod_: *mut NapiModule) {
  if mod_.is_null() {
    return;
  }
  let m = unsafe { &*mod_ };
  if let Some(func) = m.nm_register_func {
    *PENDING_REGISTER.lock().unwrap() = Some(func);
  }
}

/// dlopen a `.node` file, locate its N-API initializer (`napi_register_module_v1`
/// or `napi_module_register`), and cache it for `init_addon`.
pub fn load_native_addon(path: &Path) -> Result<String, String> {
  let s = path.display().to_string();
  {
    let guard = LOADED.lock().unwrap();
    if let Some(map) = guard.as_ref()
      && map.contains_key(&s)
    {
      return Ok(format!(
        "module.exports = Deno.core.ops.op_napi_init({s:?}, module.exports);"
      ));
    }
  }

  *PENDING_REGISTER.lock().unwrap() = None;
  let lib = unsafe { libloading::Library::new(path).map_err(|e| format!("dlopen {s}: {e}"))? };

  let init_fn: NapiAddonRegisterFunc =
    if let Ok(sym) = unsafe { lib.get::<NapiAddonRegisterFunc>(b"napi_register_module_v1") } {
      *sym
    } else if let Some(reg) = PENDING_REGISTER.lock().unwrap().take() {
      reg
    } else {
      return Err(format!("{s}: missing napi_register_module_v1 or napi_module_register"));
    };

  LOADED
    .lock()
    .unwrap()
    .get_or_insert_with(HashMap::new)
    .insert(s.clone(), LoadedAddon { _lib: lib, init_fn });

  Ok(format!(
    "module.exports = Deno.core.ops.op_napi_init({s:?}, module.exports);"
  ))
}

pub fn available() -> bool {
  true
}

// ---------------------------------------------------------------------------
// Per-JsRuntime N-API State
// ---------------------------------------------------------------------------

pub struct NapiRuntimeState {
  pub env: Box<NapiEnvInner>,
  pub event_rx: Option<Rc<tokio::sync::Mutex<mpsc::UnboundedReceiver<NapiEvent>>>>,
}

pub fn ensure_env(scope: &mut v8::PinScope<'_, '_>, state: &mut OpState) -> *mut NapiEnvInner {
  if !state.has::<NapiRuntimeState>() {
    let mut env = NapiEnvInner::new(scope);
    let rx = env.event_rx.take().map(|r| Rc::new(tokio::sync::Mutex::new(r)));
    state.put(NapiRuntimeState { env, event_rx: rx });
  }
  let rt_state = state.borrow_mut::<NapiRuntimeState>();
  rt_state.env.as_mut() as *mut NapiEnvInner
}

pub fn init_addon<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  state: Rc<RefCell<OpState>>,
  path: String,
  exports: v8::Local<'s, v8::Value>,
) -> Result<v8::Local<'s, v8::Value>, deno_error::JsErrorBox> {
  // Ensure the .node library is loaded (handles direct process.dlopen calls).
  {
    let already = LOADED.lock().unwrap().as_ref().is_some_and(|m| m.contains_key(&path));
    if !already {
      load_native_addon(Path::new(&path)).map_err(deno_error::JsErrorBox::generic)?;
    }
  }

  let init_fn = {
    let guard = LOADED.lock().unwrap();
    guard
      .as_ref()
      .and_then(|m| m.get(&path))
      .map(|a| a.init_fn)
      .ok_or_else(|| deno_error::JsErrorBox::generic(format!("addon not loaded: {path}")))?
  };

  let env_ptr = {
    let mut st = state.borrow_mut();
    ensure_env(scope, &mut st)
  };
  unsafe {
    (*env_ptr).module_filename = std::ffi::CString::new(path.as_str()).unwrap_or_default();
  }

  let _guard = unsafe { ScopeGuard::enter(env_ptr, scope) };
  let exports_napi = to_napi_value(exports);
  let ret = unsafe { init_fn(env_ptr, exports_napi) };

  let inner = unsafe { &mut *env_ptr };
  if inner.active_async_count.load(Ordering::SeqCst) > 0 {
    notify_js_async_ref(scope);
  }
  if let Some(exc_global) = inner.pending_exception.take() {
    let exc = v8::Local::new(scope, exc_global);
    scope.throw_exception(exc);
    return Ok(v8::undefined(scope).into());
  }

  if ret.is_null() {
    Ok(exports)
  } else {
    Ok(unsafe { from_napi_value(ret) }.unwrap_or(exports))
  }
}

pub struct PendingNapiEvent(pub Option<NapiEvent>);

pub async fn next_event(state: Rc<RefCell<OpState>>) -> bool {
  let rx = {
    let st = state.borrow();
    st.try_borrow::<NapiRuntimeState>().and_then(|r| r.event_rx.clone())
  };
  let Some(rx) = rx else {
    return false;
  };
  let mut guard = rx.lock().await;
  match guard.recv().await {
    Some(ev) => {
      state.borrow_mut().put(PendingNapiEvent(Some(ev)));
      true
    }
    None => false,
  }
}

pub fn drain_event(scope: &mut v8::PinScope<'_, '_>, state: &mut OpState) {
  let ev = state.try_borrow_mut::<PendingNapiEvent>().and_then(|p| p.0.take());
  if let Some(event) = ev {
    let env_ptr = ensure_env(scope, state);
    async_rt::dispatch_event(scope, env_ptr, event);
  }
}

pub fn active_async_count(state: &OpState) -> usize {
  state
    .try_borrow::<NapiRuntimeState>()
    .map_or(0, |r| r.env.active_async_count.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// Keep all N-API symbols alive for dynamic lookup by dlopen'd .node addons
// ---------------------------------------------------------------------------

#[repr(transparent)]
struct SyncPtr(*const std::ffi::c_void);
unsafe impl Sync for SyncPtr {}

macro_rules! sym_table {
  ($($sym:ident),* $(,)?) => {
    #[used]
    static NAPI_SYMBOL_TABLE: [SyncPtr; 161] = [
      $(SyncPtr($sym as *const std::ffi::c_void)),*
    ];
  };
}

sym_table!(
  napi_module_register,
  napi_get_last_error_info,
  napi_get_version,
  napi_get_node_version,
  napi_get_uv_event_loop,
  napi_set_instance_data,
  napi_get_instance_data,
  napi_open_handle_scope,
  napi_close_handle_scope,
  napi_open_escapable_handle_scope,
  napi_close_escapable_handle_scope,
  napi_escape_handle,
  napi_get_undefined,
  napi_get_null,
  napi_get_global,
  napi_get_boolean,
  napi_create_double,
  napi_create_int32,
  napi_create_uint32,
  napi_create_int64,
  napi_create_bigint_int64,
  napi_create_bigint_uint64,
  napi_create_bigint_words,
  napi_create_date,
  napi_create_symbol,
  node_api_symbol_for,
  napi_create_string_utf8,
  napi_create_string_latin1,
  napi_create_string_utf16,
  node_api_create_external_string_latin1,
  node_api_create_external_string_utf16,
  node_api_create_property_key_latin1,
  node_api_create_property_key_utf8,
  node_api_create_property_key_utf16,
  napi_get_value_string_utf8,
  napi_get_value_string_latin1,
  napi_get_value_string_utf16,
  napi_typeof,
  napi_get_value_double,
  napi_get_value_int32,
  napi_get_value_uint32,
  napi_get_value_int64,
  napi_get_value_bool,
  napi_get_value_bigint_int64,
  napi_get_value_bigint_uint64,
  napi_get_value_bigint_words,
  napi_get_date_value,
  napi_is_array,
  napi_is_date,
  napi_is_error,
  napi_is_promise,
  napi_is_arraybuffer,
  napi_is_typedarray,
  napi_is_dataview,
  napi_is_buffer,
  napi_is_detached_arraybuffer,
  napi_strict_equals,
  napi_instanceof,
  napi_coerce_to_bool,
  napi_coerce_to_number,
  napi_coerce_to_object,
  napi_coerce_to_string,
  napi_create_object,
  napi_create_array,
  napi_create_array_with_length,
  napi_get_array_length,
  napi_get_prototype,
  napi_get_property_names,
  napi_get_all_property_names,
  napi_set_property,
  napi_has_property,
  napi_get_property,
  napi_delete_property,
  napi_has_own_property,
  napi_set_named_property,
  napi_has_named_property,
  napi_get_named_property,
  napi_set_element,
  napi_has_element,
  napi_get_element,
  napi_delete_element,
  napi_define_properties,
  napi_object_freeze,
  napi_object_seal,
  napi_create_function,
  napi_get_cb_info,
  napi_get_new_target,
  napi_call_function,
  napi_make_callback,
  napi_new_instance,
  napi_define_class,
  napi_run_script,
  napi_create_external,
  napi_get_value_external,
  napi_wrap,
  napi_unwrap,
  napi_remove_wrap,
  napi_add_finalizer,
  napi_type_tag_object,
  napi_check_object_type_tag,
  napi_create_reference,
  napi_delete_reference,
  napi_reference_ref,
  napi_reference_unref,
  napi_get_reference_value,
  napi_create_error,
  napi_create_type_error,
  napi_create_range_error,
  node_api_create_syntax_error,
  napi_throw,
  napi_throw_error,
  napi_throw_type_error,
  napi_throw_range_error,
  node_api_throw_syntax_error,
  napi_is_exception_pending,
  napi_get_and_clear_last_exception,
  napi_fatal_error,
  napi_fatal_exception,
  napi_create_buffer,
  napi_create_external_buffer,
  napi_create_buffer_copy,
  napi_get_buffer_info,
  napi_create_arraybuffer,
  napi_create_external_arraybuffer,
  napi_get_arraybuffer_info,
  napi_detach_arraybuffer,
  node_api_create_sharedarraybuffer,
  napi_create_typedarray,
  napi_get_typedarray_info,
  napi_create_dataview,
  napi_get_dataview_info,
  napi_adjust_external_memory,
  napi_create_promise,
  napi_resolve_deferred,
  napi_reject_deferred,
  napi_async_init,
  napi_async_destroy,
  napi_open_callback_scope,
  napi_close_callback_scope,
  napi_create_async_work,
  napi_delete_async_work,
  napi_queue_async_work,
  napi_cancel_async_work,
  napi_create_threadsafe_function,
  napi_get_threadsafe_function_context,
  napi_call_threadsafe_function,
  napi_acquire_threadsafe_function,
  napi_release_threadsafe_function,
  napi_unref_threadsafe_function,
  napi_ref_threadsafe_function,
  napi_add_env_cleanup_hook,
  napi_remove_env_cleanup_hook,
  napi_add_async_cleanup_hook,
  napi_remove_async_cleanup_hook,
  node_api_post_finalizer,
  node_api_get_module_file_name,
  node_api_create_object_with_properties,
  node_api_set_prototype,
  node_api_is_sharedarraybuffer,
  node_api_create_buffer_from_arraybuffer,
  node_api_create_external_sharedarraybuffer,
);
