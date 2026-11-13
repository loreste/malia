//! N-API externals, object wrapping, type tags, finalizers, and references.

use std::ffi::c_void;

use deno_core::v8;

use super::env::*;
use super::types::*;

enum RefStorage {
  Strong(v8::Global<v8::Value>),
  Weak(v8::Weak<v8::Value>),
}

struct NapiRefInner {
  refcount: u32,
  storage: Option<RefStorage>,
}

impl NapiRefInner {
  fn get_local<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Value>> {
    match self.storage.as_ref()? {
      RefStorage::Strong(g) => Some(v8::Local::new(scope, g)),
      RefStorage::Weak(w) => w.to_local(scope),
    }
  }
}

// ---------------------------------------------------------------------------
// Externals
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_external(
  env: NapiEnv,
  data: *mut c_void,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let ext = v8::External::new(scope, data);
      if let Some(cb) = finalize_cb {
        attach_finalizer(scope, inner, ext.into(), data, cb, finalize_hint);
      }
      write_out(result, to_napi_value(ext))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_external(
  env: NapiEnv,
  value: NapiValue,
  result: *mut *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(value)?;
      if !v.is_external() {
        return Err(NAPI_INVALID_ARG);
      }
      let ext = v8::Local::<v8::External>::try_from(v).map_err(|_| NAPI_INVALID_ARG)?;
      write_out(result, ext.value())
    })
  }
}

// ---------------------------------------------------------------------------
// Object Wrap & Finalizers
// ---------------------------------------------------------------------------

fn wrap_impl(
  env: NapiEnv,
  js_object: NapiValue,
  native_object: *mut c_void,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiRef,
  store_wrap: bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, js_object)?;
      if store_wrap {
        let key = v8::Local::new(scope, &inner.wrap_private_key);
        if obj.has_private(scope, key) == Some(true) {
          return Err(NAPI_INVALID_ARG);
        }
        let ext = v8::External::new(scope, native_object);
        obj.set_private(scope, key, ext.into());
      }
      if let Some(cb) = finalize_cb {
        attach_finalizer(scope, inner, obj.into(), native_object, cb, finalize_hint);
      }
      if !result.is_null() {
        let weak = v8::Weak::new(scope, v8::Local::<v8::Value>::from(obj));
        let boxed = Box::new(NapiRefInner {
          refcount: 0,
          storage: Some(RefStorage::Weak(weak)),
        });
        *result = Box::into_raw(boxed) as NapiRef;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_wrap(
  env: NapiEnv,
  js_object: NapiValue,
  native_object: *mut c_void,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiRef,
) -> NapiStatus {
  wrap_impl(env, js_object, native_object, finalize_cb, finalize_hint, result, true)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_add_finalizer(
  env: NapiEnv,
  js_object: NapiValue,
  native_object: *mut c_void,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiRef,
) -> NapiStatus {
  wrap_impl(env, js_object, native_object, finalize_cb, finalize_hint, result, false)
}

fn unwrap_impl(env: NapiEnv, js_object: NapiValue, result: *mut *mut c_void, remove: bool) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, js_object)?;
      let key = v8::Local::new(scope, &inner.wrap_private_key);
      let val = obj.get_private(scope, key).ok_or(NAPI_INVALID_ARG)?;
      if !val.is_external() {
        return Err(NAPI_INVALID_ARG);
      }
      let ext = v8::Local::<v8::External>::try_from(val).map_err(|_| NAPI_INVALID_ARG)?;
      let ptr = ext.value();
      if remove {
        obj.delete_private(scope, key);
      }
      write_out(result, ptr)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_unwrap(env: NapiEnv, js_object: NapiValue, result: *mut *mut c_void) -> NapiStatus {
  unwrap_impl(env, js_object, result, false)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_remove_wrap(env: NapiEnv, js_object: NapiValue, result: *mut *mut c_void) -> NapiStatus {
  unwrap_impl(env, js_object, result, true)
}

// ---------------------------------------------------------------------------
// Type Tagging
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_type_tag_object(
  env: NapiEnv,
  js_object: NapiValue,
  type_tag: *const NapiTypeTag,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      if type_tag.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let obj = from_napi_object(scope, js_object)?;
      let key = v8::Local::new(scope, &inner.type_tag_private_key);
      if obj.has_private(scope, key) == Some(true) {
        return Err(NAPI_INVALID_ARG);
      }
      let tag_ptr = Box::into_raw(Box::new(*type_tag)) as *mut c_void;
      let ext = v8::External::new(scope, tag_ptr);
      obj.set_private(scope, key, ext.into());
      let weak = v8::Weak::with_guaranteed_finalizer(
        scope,
        v8::Local::<v8::Value>::from(obj),
        Box::new(move || {
          drop(Box::from_raw(tag_ptr as *mut NapiTypeTag));
        }),
      );
      inner.weak_handles.push(weak);
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_check_object_type_tag(
  env: NapiEnv,
  js_object: NapiValue,
  type_tag: *const NapiTypeTag,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      if type_tag.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let obj = from_napi_object(scope, js_object)?;
      let key = v8::Local::new(scope, &inner.type_tag_private_key);
      let matches = if let Some(val) = obj.get_private(scope, key)
        && let Ok(ext) = v8::Local::<v8::External>::try_from(val)
      {
        let stored = &*(ext.value() as *const NapiTypeTag);
        *stored == *type_tag
      } else {
        false
      };
      write_out(result, matches)
    })
  }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_reference(
  env: NapiEnv,
  value: NapiValue,
  initial_refcount: u32,
  result: *mut NapiRef,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if result.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let v = from_napi_value(value)?;
      let storage = if initial_refcount > 0 {
        RefStorage::Strong(v8::Global::new(scope, v))
      } else {
        RefStorage::Weak(v8::Weak::new(scope, v))
      };
      let boxed = Box::new(NapiRefInner {
        refcount: initial_refcount,
        storage: Some(storage),
      });
      *result = Box::into_raw(boxed) as NapiRef;
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_delete_reference(env: NapiEnv, ref_: NapiRef) -> NapiStatus {
  unsafe {
    with_env_basic(env, |_| {
      if ref_.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      drop(Box::from_raw(ref_ as *mut NapiRefInner));
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_reference_ref(env: NapiEnv, ref_: NapiRef, result: *mut u32) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if ref_.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let r = &mut *(ref_ as *mut NapiRefInner);
      r.refcount += 1;
      if r.refcount == 1
        && let Some(RefStorage::Weak(w)) = r.storage.take()
        && let Some(local) = w.to_local(scope)
      {
        r.storage = Some(RefStorage::Strong(v8::Global::new(scope, local)));
      }
      if !result.is_null() {
        *result = r.refcount;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_reference_unref(env: NapiEnv, ref_: NapiRef, result: *mut u32) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if ref_.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let r = &mut *(ref_ as *mut NapiRefInner);
      if r.refcount == 0 {
        return Err(NAPI_GENERIC_FAILURE);
      }
      r.refcount -= 1;
      if r.refcount == 0
        && let Some(RefStorage::Strong(g)) = r.storage.take()
      {
        let local = v8::Local::new(scope, &g);
        r.storage = Some(RefStorage::Weak(v8::Weak::new(scope, local)));
      }
      if !result.is_null() {
        *result = r.refcount;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_reference_value(env: NapiEnv, ref_: NapiRef, result: *mut NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if ref_.is_null() || result.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let r = &*(ref_ as *const NapiRefInner);
      *result = r.get_local(scope).map_or(std::ptr::null_mut(), to_napi_value);
      Ok(())
    })
  }
}
