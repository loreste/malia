//! N-API Buffer, ArrayBuffer, SharedArrayBuffer, TypedArray, and DataView functions.

use std::ffi::c_void;

use deno_core::v8;

use super::env::*;
use super::types::*;

struct ExternalBackingDeleter {
  env: NapiEnv,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
}

unsafe extern "C" fn external_backing_deleter(
  data: *mut c_void,
  _byte_length: usize,
  deleter_data: *mut c_void,
) {
  if deleter_data.is_null() {
    return;
  }
  let boxed = unsafe { Box::from_raw(deleter_data as *mut ExternalBackingDeleter) };
  if let Some(cb) = boxed.finalize_cb {
    unsafe { cb(boxed.env, data, boxed.finalize_hint) };
  }
}

fn make_external_ab<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  env: NapiEnv,
  data: *mut c_void,
  byte_length: usize,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
) -> v8::Local<'s, v8::ArrayBuffer> {
  let deleter = Box::into_raw(Box::new(ExternalBackingDeleter {
    env,
    finalize_cb,
    finalize_hint,
  }));
  let store = unsafe {
    v8::ArrayBuffer::new_backing_store_from_ptr(
      data,
      byte_length,
      external_backing_deleter,
      deleter as *mut c_void,
    )
  };
  let shared = store.make_shared();
  v8::ArrayBuffer::with_backing_store(scope, &shared)
}

fn wrap_ab_as_buffer<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  ab: v8::Local<'s, v8::ArrayBuffer>,
  byte_offset: usize,
  length: usize,
) -> Result<v8::Local<'s, v8::Uint8Array>, NapiStatus> {
  let u8arr = v8::Uint8Array::new(scope, ab, byte_offset, length).ok_or(NAPI_GENERIC_FAILURE)?;
  let global = scope.get_current_context().global(scope);
  if let Some(buf_key) = v8::String::new(scope, "Buffer")
    && let Some(buf_ctor) = global.get(scope, buf_key.into())
    && let Ok(buf_obj) = v8::Local::<v8::Object>::try_from(buf_ctor)
    && let Some(proto_key) = v8::String::new(scope, "prototype")
    && let Some(proto) = buf_obj.get(scope, proto_key.into())
  {
    u8arr.set_prototype(scope, proto);
  }
  Ok(u8arr)
}

fn ab_data_ptr(ab: v8::Local<'_, v8::ArrayBuffer>) -> *mut c_void {
  ab.get_backing_store()
    .data()
    .map_or(std::ptr::null_mut(), |ptr| ptr.as_ptr())
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_buffer(
  env: NapiEnv,
  length: usize,
  data: *mut *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let ab = v8::ArrayBuffer::new(scope, length);
      let ptr = ab_data_ptr(ab);
      let buf = wrap_ab_as_buffer(scope, ab, 0, length)?;
      if !data.is_null() {
        *data = ptr;
      }
      write_out(result, to_napi_value(buf))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_external_buffer(
  env: NapiEnv,
  length: usize,
  data: *mut c_void,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let ab = make_external_ab(scope, env, data, length, finalize_cb, finalize_hint);
      let buf = wrap_ab_as_buffer(scope, ab, 0, length)?;
      write_out(result, to_napi_value(buf))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_buffer_copy(
  env: NapiEnv,
  length: usize,
  data: *const c_void,
  result_data: *mut *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if length > 0 && data.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let ab = v8::ArrayBuffer::new(scope, length);
      let ptr = ab_data_ptr(ab);
      if length > 0 && !ptr.is_null() {
        std::ptr::copy_nonoverlapping(data as *const u8, ptr as *mut u8, length);
      }
      let buf = wrap_ab_as_buffer(scope, ab, 0, length)?;
      if !result_data.is_null() {
        *result_data = ptr;
      }
      write_out(result, to_napi_value(buf))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_buffer_info(
  env: NapiEnv,
  value: NapiValue,
  data: *mut *mut c_void,
  length: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let v = from_napi_value(value)?;
      let view =
        v8::Local::<v8::ArrayBufferView>::try_from(v).map_err(|_| NAPI_INVALID_ARG)?;
      if !length.is_null() {
        *length = view.byte_length();
      }
      if !data.is_null() {
        let ab = view.buffer(scope).ok_or(NAPI_GENERIC_FAILURE)?;
        let base = ab_data_ptr(ab);
        *data = if base.is_null() {
          std::ptr::null_mut()
        } else {
          (base as *mut u8).add(view.byte_offset()) as *mut c_void
        };
      }
      Ok(())
    })
  }
}

// ---------------------------------------------------------------------------
// ArrayBuffer & SharedArrayBuffer
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_arraybuffer(
  env: NapiEnv,
  byte_length: usize,
  data: *mut *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let ab = v8::ArrayBuffer::new(scope, byte_length);
      if !data.is_null() {
        *data = ab_data_ptr(ab);
      }
      write_out(result, to_napi_value(ab))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_external_arraybuffer(
  env: NapiEnv,
  external_data: *mut c_void,
  byte_length: usize,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let ab = make_external_ab(
        scope,
        env,
        external_data,
        byte_length,
        finalize_cb,
        finalize_hint,
      );
      write_out(result, to_napi_value(ab))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_arraybuffer_info(
  env: NapiEnv,
  arraybuffer: NapiValue,
  data: *mut *mut c_void,
  byte_length: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(arraybuffer)?;
      let ab =
        v8::Local::<v8::ArrayBuffer>::try_from(v).map_err(|_| NAPI_ARRAYBUFFER_EXPECTED)?;
      if !byte_length.is_null() {
        *byte_length = ab.byte_length();
      }
      if !data.is_null() {
        *data = ab_data_ptr(ab);
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_detach_arraybuffer(
  env: NapiEnv,
  arraybuffer: NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(arraybuffer)?;
      let ab =
        v8::Local::<v8::ArrayBuffer>::try_from(v).map_err(|_| NAPI_ARRAYBUFFER_EXPECTED)?;
      if !ab.is_detachable() {
        return Err(NAPI_DETACHABLE_ARRAYBUFFER_EXPECTED);
      }
      ab.detach(None);
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_buffer_from_arraybuffer(
  env: NapiEnv,
  arraybuffer: NapiValue,
  byte_offset: usize,
  byte_length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let v = from_napi_value(arraybuffer)?;
      let ab =
        v8::Local::<v8::ArrayBuffer>::try_from(v).map_err(|_| NAPI_ARRAYBUFFER_EXPECTED)?;
      let buf = wrap_ab_as_buffer(scope, ab, byte_offset, byte_length)?;
      write_out(result, to_napi_value(buf))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_sharedarraybuffer(
  env: NapiEnv,
  byte_length: usize,
  data: *mut *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let sab = v8::SharedArrayBuffer::new(scope, byte_length).ok_or(NAPI_GENERIC_FAILURE)?;
      if !data.is_null() {
        *data = sab
          .get_backing_store()
          .data()
          .map_or(std::ptr::null_mut(), |p| p.as_ptr());
      }
      write_out(result, to_napi_value(sab))
    })
  }
}

struct NoenvBackingDeleter {
  finalize_cb: Option<NodeApiNoenvFinalize>,
  finalize_hint: *mut c_void,
}

unsafe extern "C" fn noenv_backing_deleter(
  data: *mut c_void,
  _byte_length: usize,
  deleter_data: *mut c_void,
) {
  if deleter_data.is_null() {
    return;
  }
  let boxed = unsafe { Box::from_raw(deleter_data as *mut NoenvBackingDeleter) };
  if let Some(cb) = boxed.finalize_cb {
    unsafe { cb(data, boxed.finalize_hint) };
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_external_sharedarraybuffer(
  env: NapiEnv,
  external_data: *mut c_void,
  byte_length: usize,
  finalize_cb: Option<NodeApiNoenvFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let deleter = Box::into_raw(Box::new(NoenvBackingDeleter {
        finalize_cb,
        finalize_hint,
      }));
      let store = v8::ArrayBuffer::new_backing_store_from_ptr(
        external_data,
        byte_length,
        noenv_backing_deleter,
        deleter as *mut c_void,
      );
      let shared = store.make_shared();
      let sab = v8::SharedArrayBuffer::with_backing_store(scope, &shared);
      write_out(result, to_napi_value(sab))
    })
  }
}

// ---------------------------------------------------------------------------
// TypedArray & DataView
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_typedarray(
  env: NapiEnv,
  type_: NapiTypedArrayType,
  length: usize,
  arraybuffer: NapiValue,
  byte_offset: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let v = from_napi_value(arraybuffer)?;
      let ab =
        v8::Local::<v8::ArrayBuffer>::try_from(v).map_err(|_| NAPI_ARRAYBUFFER_EXPECTED)?;
      let ta: v8::Local<'_, v8::TypedArray> = match type_ {
        NAPI_INT8_ARRAY => v8::Int8Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_UINT8_ARRAY => v8::Uint8Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_UINT8_CLAMPED_ARRAY => v8::Uint8ClampedArray::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_INT16_ARRAY => v8::Int16Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_UINT16_ARRAY => v8::Uint16Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_INT32_ARRAY => v8::Int32Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_UINT32_ARRAY => v8::Uint32Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_FLOAT32_ARRAY => v8::Float32Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_FLOAT64_ARRAY => v8::Float64Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_BIGINT64_ARRAY => v8::BigInt64Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        NAPI_BIGUINT64_ARRAY => v8::BigUint64Array::new(scope, ab, byte_offset, length)
          .ok_or(NAPI_GENERIC_FAILURE)?
          .into(),
        _ => return Err(NAPI_INVALID_ARG),
      };
      write_out(result, to_napi_value(ta))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_typedarray_info(
  env: NapiEnv,
  typedarray: NapiValue,
  type_: *mut NapiTypedArrayType,
  length: *mut usize,
  data: *mut *mut c_void,
  arraybuffer: *mut NapiValue,
  byte_offset: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let v = from_napi_value(typedarray)?;
      let ta = v8::Local::<v8::TypedArray>::try_from(v).map_err(|_| NAPI_INVALID_ARG)?;

      if !type_.is_null() {
        let t = if v.is_int8_array() {
          NAPI_INT8_ARRAY
        } else if v.is_uint8_array() {
          NAPI_UINT8_ARRAY
        } else if v.is_uint8_clamped_array() {
          NAPI_UINT8_CLAMPED_ARRAY
        } else if v.is_int16_array() {
          NAPI_INT16_ARRAY
        } else if v.is_uint16_array() {
          NAPI_UINT16_ARRAY
        } else if v.is_int32_array() {
          NAPI_INT32_ARRAY
        } else if v.is_uint32_array() {
          NAPI_UINT32_ARRAY
        } else if v.is_float32_array() {
          NAPI_FLOAT32_ARRAY
        } else if v.is_float64_array() {
          NAPI_FLOAT64_ARRAY
        } else if v.is_big_int64_array() {
          NAPI_BIGINT64_ARRAY
        } else if v.is_big_uint64_array() {
          NAPI_BIGUINT64_ARRAY
        } else {
          return Err(NAPI_INVALID_ARG);
        };
        *type_ = t;
      }
      if !length.is_null() {
        *length = ta.length();
      }
      let offset = ta.byte_offset();
      if !byte_offset.is_null() {
        *byte_offset = offset;
      }
      if !data.is_null() || !arraybuffer.is_null() {
        let ab = ta.buffer(scope).ok_or(NAPI_GENERIC_FAILURE)?;
        if !data.is_null() {
          let base = ab_data_ptr(ab);
          *data = if base.is_null() {
            std::ptr::null_mut()
          } else {
            (base as *mut u8).add(offset) as *mut c_void
          };
        }
        if !arraybuffer.is_null() {
          *arraybuffer = to_napi_value(ab);
        }
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_dataview(
  env: NapiEnv,
  length: usize,
  arraybuffer: NapiValue,
  byte_offset: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let v = from_napi_value(arraybuffer)?;
      let ab =
        v8::Local::<v8::ArrayBuffer>::try_from(v).map_err(|_| NAPI_ARRAYBUFFER_EXPECTED)?;
      let dv = v8::DataView::new(scope, ab, byte_offset, length);
      write_out(result, to_napi_value(dv))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_dataview_info(
  env: NapiEnv,
  dataview: NapiValue,
  byte_length: *mut usize,
  data: *mut *mut c_void,
  arraybuffer: *mut NapiValue,
  byte_offset: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let v = from_napi_value(dataview)?;
      let dv = v8::Local::<v8::DataView>::try_from(v).map_err(|_| NAPI_INVALID_ARG)?;
      let offset = dv.byte_offset();
      if !byte_length.is_null() {
        *byte_length = dv.byte_length();
      }
      if !byte_offset.is_null() {
        *byte_offset = offset;
      }
      if !data.is_null() || !arraybuffer.is_null() {
        let ab = dv.buffer(scope).ok_or(NAPI_GENERIC_FAILURE)?;
        if !data.is_null() {
          let base = ab_data_ptr(ab);
          *data = if base.is_null() {
            std::ptr::null_mut()
          } else {
            (base as *mut u8).add(offset) as *mut c_void
          };
        }
        if !arraybuffer.is_null() {
          *arraybuffer = to_napi_value(ab);
        }
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_adjust_external_memory(
  env: NapiEnv,
  change_in_bytes: i64,
  adjusted_value: *mut i64,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let new_val = scope.adjust_amount_of_external_allocated_memory(change_in_bytes);
      if !adjusted_value.is_null() {
        *adjusted_value = new_val;
      }
      Ok(())
    })
  }
}
