//! N-API Promises, AsyncWork, ThreadsafeFunction, CallbackScope, and CleanupHooks.

use std::ffi::c_void;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use deno_core::v8;
use tokio::sync::mpsc;

use super::env::*;
use super::types::*;

// ---------------------------------------------------------------------------
// Promises
// ---------------------------------------------------------------------------

struct NapiDeferredInner {
  resolver: v8::Global<v8::PromiseResolver>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_promise(
  env: NapiEnv,
  deferred: *mut NapiDeferred,
  promise: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if deferred.is_null() || promise.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let resolver = v8::PromiseResolver::new(scope).ok_or(NAPI_GENERIC_FAILURE)?;
      let p = resolver.get_promise(scope);
      let boxed = Box::new(NapiDeferredInner {
        resolver: v8::Global::new(scope, resolver),
      });
      *deferred = Box::into_raw(boxed) as NapiDeferred;
      *promise = to_napi_value(p);
      Ok(())
    })
  }
}

unsafe fn settle_deferred(env: NapiEnv, deferred: NapiDeferred, value: NapiValue, resolve: bool) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if deferred.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let val = from_napi_value(value)?;
      let boxed = Box::from_raw(deferred as *mut NapiDeferredInner);
      let resolver = v8::Local::new(scope, boxed.resolver);
      let ok = if resolve {
        resolver.resolve(scope, val)
      } else {
        resolver.reject(scope, val)
      };
      if ok == Some(true) {
        Ok(())
      } else {
        Err(NAPI_GENERIC_FAILURE)
      }
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_resolve_deferred(
  env: NapiEnv,
  deferred: NapiDeferred,
  resolution: NapiValue,
) -> NapiStatus {
  unsafe { settle_deferred(env, deferred, resolution, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_reject_deferred(
  env: NapiEnv,
  deferred: NapiDeferred,
  rejection: NapiValue,
) -> NapiStatus {
  unsafe { settle_deferred(env, deferred, rejection, false) }
}

// ---------------------------------------------------------------------------
// Async Context & Callback Scope
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_async_init(
  env: NapiEnv,
  _async_resource: NapiValue,
  _async_resource_name: NapiValue,
  result: *mut NapiAsyncContext,
) -> NapiStatus {
  unsafe { with_env_basic(env, |_| write_out(result, 1usize as NapiAsyncContext)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_async_destroy(env: NapiEnv, async_context: NapiAsyncContext) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if async_context.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_open_callback_scope(
  env: NapiEnv,
  _resource_object: NapiValue,
  _context: NapiAsyncContext,
  result: *mut NapiCallbackScope,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      inner.callback_scope_depth += 1;
      write_out(result, inner.callback_scope_depth as NapiCallbackScope)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_close_callback_scope(env: NapiEnv, scope: NapiCallbackScope) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      if scope.is_null() || scope != inner.callback_scope_depth as NapiCallbackScope {
        return Err(NAPI_CALLBACK_SCOPE_MISMATCH);
      }
      inner.callback_scope_depth -= 1;
      Ok(())
    })
  }
}

// ---------------------------------------------------------------------------
// Async Work
// ---------------------------------------------------------------------------

struct NapiAsyncWorkInner {
  env: NapiEnv,
  execute: NapiAsyncExecuteCallback,
  complete: Option<NapiAsyncCompleteCallback>,
  data: *mut c_void,
  event_tx: mpsc::UnboundedSender<NapiEvent>,
  active_async_count: Arc<AtomicUsize>,
  cancelled: AtomicBool,
  queued: AtomicBool,
  status: Mutex<NapiStatus>,
}

unsafe impl Send for NapiAsyncWorkInner {}
unsafe impl Sync for NapiAsyncWorkInner {}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_async_work(
  env: NapiEnv,
  _async_resource: NapiValue,
  _async_resource_name: NapiValue,
  execute: Option<NapiAsyncExecuteCallback>,
  complete: Option<NapiAsyncCompleteCallback>,
  data: *mut c_void,
  result: *mut NapiAsyncWork,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let execute = execute.ok_or(NAPI_INVALID_ARG)?;
      let work = Box::new(NapiAsyncWorkInner {
        env,
        execute,
        complete,
        data,
        event_tx: inner.event_tx.clone(),
        active_async_count: inner.active_async_count.clone(),
        cancelled: AtomicBool::new(false),
        queued: AtomicBool::new(false),
        status: Mutex::new(NAPI_OK),
      });
      write_out(result, Box::into_raw(work) as NapiAsyncWork)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_delete_async_work(env: NapiEnv, work: NapiAsyncWork) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if work.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      drop(Box::from_raw(work as *mut NapiAsyncWorkInner));
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_queue_async_work(env: NapiEnv, work: NapiAsyncWork) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if work.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let w = &*(work as *const NapiAsyncWorkInner);
      if w.queued.swap(true, Ordering::SeqCst) {
        return Err(NAPI_GENERIC_FAILURE);
      }
      w.active_async_count.fetch_add(1, Ordering::SeqCst);
      let work_addr = work as usize;
      let run_work = move || {
        let w = &*(work_addr as *const NapiAsyncWorkInner);
        if w.cancelled.load(Ordering::SeqCst) {
          *w.status.lock().unwrap() = NAPI_CANCELLED;
        } else {
          (w.execute)(w.env, w.data);
          *w.status.lock().unwrap() = if w.cancelled.load(Ordering::SeqCst) {
            NAPI_CANCELLED
          } else {
            NAPI_OK
          };
        }
        let _ = w.event_tx.send(NapiEvent::AsyncWorkComplete { work: work_addr });
      };
      if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::spawn_blocking(run_work);
      } else {
        std::thread::spawn(run_work);
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_cancel_async_work(env: NapiEnv, work: NapiAsyncWork) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if work.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let w = &*(work as *const NapiAsyncWorkInner);
      w.cancelled.store(true, Ordering::SeqCst);
      Ok(())
    })
  }
}

// ---------------------------------------------------------------------------
// Threadsafe Functions
// ---------------------------------------------------------------------------

struct TsfnInner {
  #[allow(dead_code)]
  env: NapiEnv,
  func: Option<v8::Global<v8::Function>>,
  context: *mut c_void,
  call_js_cb: Option<NapiThreadsafeFunctionCallJs>,
  thread_finalize_cb: Option<NapiFinalize>,
  thread_finalize_data: *mut c_void,
  event_tx: mpsc::UnboundedSender<NapiEvent>,
  active_async_count: Arc<AtomicUsize>,
  max_queue_size: usize,
  state: Mutex<TsfnState>,
}

struct TsfnState {
  thread_count: usize,
  queued_count: usize,
  closing: bool,
  refed: bool,
}

unsafe impl Send for TsfnInner {}
unsafe impl Sync for TsfnInner {}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_threadsafe_function(
  env: NapiEnv,
  func: NapiValue,
  _async_resource: NapiValue,
  _async_resource_name: NapiValue,
  max_queue_size: usize,
  initial_thread_count: usize,
  thread_finalize_data: *mut c_void,
  thread_finalize_cb: Option<NapiFinalize>,
  context: *mut c_void,
  call_js_cb: Option<NapiThreadsafeFunctionCallJs>,
  result: *mut NapiThreadsafeFunction,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      if initial_thread_count == 0 || result.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let js_func = if func.is_null() {
        None
      } else {
        let v = from_napi_value(func)?;
        let f = v8::Local::<v8::Function>::try_from(v).map_err(|_| NAPI_FUNCTION_EXPECTED)?;
        Some(v8::Global::new(scope, f))
      };
      if js_func.is_none() && call_js_cb.is_none() {
        return Err(NAPI_INVALID_ARG);
      }
      inner.active_async_count.fetch_add(1, Ordering::SeqCst);
      let tsfn = Box::new(TsfnInner {
        env,
        func: js_func,
        context,
        call_js_cb,
        thread_finalize_cb,
        thread_finalize_data,
        event_tx: inner.event_tx.clone(),
        active_async_count: inner.active_async_count.clone(),
        max_queue_size,
        state: Mutex::new(TsfnState {
          thread_count: initial_thread_count,
          queued_count: 0,
          closing: false,
          refed: true,
        }),
      });
      *result = Box::into_raw(tsfn) as NapiThreadsafeFunction;
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_threadsafe_function_context(
  func: NapiThreadsafeFunction,
  result: *mut *mut c_void,
) -> NapiStatus {
  if func.is_null() || result.is_null() {
    return NAPI_INVALID_ARG;
  }
  let tsfn = unsafe { &*(func as *const TsfnInner) };
  unsafe { *result = tsfn.context };
  NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_call_threadsafe_function(
  func: NapiThreadsafeFunction,
  data: *mut c_void,
  is_blocking: i32,
) -> NapiStatus {
  if func.is_null() {
    return NAPI_INVALID_ARG;
  }
  let tsfn = unsafe { &*(func as *const TsfnInner) };
  let mut st = tsfn.state.lock().unwrap();
  if st.closing {
    return NAPI_CLOSING;
  }
  if tsfn.max_queue_size > 0 && st.queued_count >= tsfn.max_queue_size && is_blocking == NAPI_TSFN_NONBLOCKING {
    return NAPI_QUEUE_FULL;
  }
  st.queued_count += 1;
  drop(st);
  let _ = tsfn.event_tx.send(NapiEvent::ThreadsafeCall {
    tsfn: func as usize,
    data: data as usize,
  });
  NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_acquire_threadsafe_function(func: NapiThreadsafeFunction) -> NapiStatus {
  if func.is_null() {
    return NAPI_INVALID_ARG;
  }
  let tsfn = unsafe { &*(func as *const TsfnInner) };
  let mut st = tsfn.state.lock().unwrap();
  if st.closing {
    return NAPI_CLOSING;
  }
  st.thread_count += 1;
  NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_release_threadsafe_function(func: NapiThreadsafeFunction, mode: i32) -> NapiStatus {
  if func.is_null() {
    return NAPI_INVALID_ARG;
  }
  let tsfn = unsafe { &*(func as *const TsfnInner) };
  let mut st = tsfn.state.lock().unwrap();
  if st.closing {
    return NAPI_CLOSING;
  }
  if st.thread_count > 0 {
    st.thread_count -= 1;
  }
  if mode == NAPI_TSFN_ABORT || st.thread_count == 0 {
    st.closing = true;
    let _ = tsfn
      .event_tx
      .send(NapiEvent::ThreadsafeFinalize { tsfn: func as usize });
  }
  NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_unref_threadsafe_function(env: NapiEnv, func: NapiThreadsafeFunction) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if func.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let tsfn = &*(func as *const TsfnInner);
      let mut st = tsfn.state.lock().unwrap();
      if st.refed {
        st.refed = false;
        tsfn.active_async_count.fetch_sub(1, Ordering::SeqCst);
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_ref_threadsafe_function(env: NapiEnv, func: NapiThreadsafeFunction) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if func.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let tsfn = &*(func as *const TsfnInner);
      let mut st = tsfn.state.lock().unwrap();
      if !st.refed {
        st.refed = true;
        tsfn.active_async_count.fetch_add(1, Ordering::SeqCst);
      }
      Ok(())
    })
  }
}

// ---------------------------------------------------------------------------
// Cleanup Hooks
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_add_env_cleanup_hook(
  env: NapiEnv,
  fun: Option<NapiCleanupHook>,
  arg: *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let fun = fun.ok_or(NAPI_INVALID_ARG)?;
      inner.cleanup_hooks.push((fun, arg));
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_remove_env_cleanup_hook(
  env: NapiEnv,
  fun: Option<NapiCleanupHook>,
  arg: *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let fun = fun.ok_or(NAPI_INVALID_ARG)?;
      if let Some(pos) = inner
        .cleanup_hooks
        .iter()
        .rposition(|(f, a)| std::ptr::fn_addr_eq(*f, fun) && *a == arg)
      {
        inner.cleanup_hooks.remove(pos);
      }
      Ok(())
    })
  }
}

#[allow(dead_code)]
struct AsyncCleanupHandle {
  hook: NapiAsyncCleanupHook,
  data: *mut c_void,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_add_async_cleanup_hook(
  env: NapiEnv,
  hook: Option<NapiAsyncCleanupHook>,
  arg: *mut c_void,
  remove_handle: *mut NapiAsyncCleanupHookHandle,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      let hook = hook.ok_or(NAPI_INVALID_ARG)?;
      let handle = Box::into_raw(Box::new(AsyncCleanupHandle { hook, data: arg })) as NapiAsyncCleanupHookHandle;
      if !remove_handle.is_null() {
        *remove_handle = handle;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_remove_async_cleanup_hook(remove_handle: NapiAsyncCleanupHookHandle) -> NapiStatus {
  if remove_handle.is_null() {
    return NAPI_INVALID_ARG;
  }
  let _ = unsafe { Box::from_raw(remove_handle as *mut AsyncCleanupHandle) };
  NAPI_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_post_finalizer(
  env: NapiEnv,
  finalize_cb: Option<NapiFinalize>,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      let cb = finalize_cb.ok_or(NAPI_INVALID_ARG)?;
      let _ = inner.event_tx.send(NapiEvent::PostFinalizer {
        cb,
        data: finalize_data as usize,
        hint: finalize_hint as usize,
      });
      Ok(())
    })
  }
}

// ---------------------------------------------------------------------------
// Event Dispatcher (runs on JS thread with live v8::PinScope)
// ---------------------------------------------------------------------------

pub fn dispatch_event(scope: &mut v8::PinScope<'_, '_>, env_ptr: NapiEnv, event: NapiEvent) {
  let _guard = unsafe { ScopeGuard::enter(env_ptr, scope) };
  match event {
    NapiEvent::AsyncWorkComplete { work } => {
      let w = unsafe { &*(work as *const NapiAsyncWorkInner) };
      w.queued.store(false, Ordering::SeqCst);
      let status = *w.status.lock().unwrap();
      let complete = w.complete;
      let data = w.data;
      let active_async_count = w.active_async_count.clone();
      if let Some(complete) = complete {
        unsafe { complete(env_ptr, status, data) };
      }
      active_async_count.fetch_sub(1, Ordering::SeqCst);
    }
    NapiEvent::ThreadsafeCall { tsfn, data } => {
      let t = unsafe { &*(tsfn as *const TsfnInner) };
      {
        let mut st = t.state.lock().unwrap();
        if st.queued_count > 0 {
          st.queued_count -= 1;
        }
      }
      let js_cb: NapiValue = match &t.func {
        Some(g) => to_napi_value(v8::Local::new(scope, g)),
        None => std::ptr::null_mut(),
      };
      if let Some(call_js) = t.call_js_cb {
        unsafe { call_js(env_ptr, js_cb, t.context, data as *mut c_void) };
      } else if let Some(g) = &t.func {
        let f = v8::Local::new(scope, g);
        let undef = v8::undefined(scope).into();
        f.call(scope, undef, &[]);
      }
    }
    NapiEvent::ThreadsafeFinalize { tsfn } => {
      let boxed = unsafe { Box::from_raw(tsfn as *mut TsfnInner) };
      if let Some(cb) = boxed.thread_finalize_cb {
        unsafe { cb(env_ptr, boxed.thread_finalize_data, boxed.context) };
      }
      let st = boxed.state.lock().unwrap();
      if st.refed {
        boxed.active_async_count.fetch_sub(1, Ordering::SeqCst);
      }
    }
    NapiEvent::PostFinalizer { cb, data, hint } => {
      unsafe { cb(env_ptr, data as *mut c_void, hint as *mut c_void) };
    }
  }
}
