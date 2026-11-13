//! N-API primitive, string, BigInt, Date, Symbol, and type-inspection functions.

use std::ffi::c_char;
use std::ffi::c_void;

use deno_core::v8;

use super::env::*;
use super::types::*;

// ---------------------------------------------------------------------------
// DRY macros for repetitive families
// ---------------------------------------------------------------------------

macro_rules! impl_napi_singleton {
  ($name:ident, $scope:ident => $build:expr) => {
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn $name(env: NapiEnv, result: *mut NapiValue) -> NapiStatus {
      unsafe {
        with_env(env, |_inner, $scope| {
          let val: v8::Local<'_, v8::Value> = ($build).into();
          write_out(result, to_napi_value(val))
        })
      }
    }
  };
}

macro_rules! impl_napi_create_num {
  ($name:ident, $ty:ty, $scope:ident, $val:ident => $build:expr) => {
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn $name(env: NapiEnv, $val: $ty, result: *mut NapiValue) -> NapiStatus {
      unsafe {
        with_env(env, |_inner, $scope| {
          let out: v8::Local<'_, v8::Value> = ($build).into();
          write_out(result, to_napi_value(out))
        })
      }
    }
  };
}

macro_rules! impl_napi_get_num {
  ($name:ident, $ty:ty, $check:expr, $expected:expr, $extract:expr) => {
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn $name(env: NapiEnv, value: NapiValue, result: *mut $ty) -> NapiStatus {
      unsafe {
        with_env(env, |_inner, scope| {
          let v = from_napi_value(value)?;
          if !($check)(&v) {
            return Err($expected);
          }
          let out = ($extract)(scope, v).ok_or($expected)?;
          write_out(result, out)
        })
      }
    }
  };
}

macro_rules! impl_napi_is {
  ($name:ident, $pred:expr) => {
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn $name(env: NapiEnv, value: NapiValue, result: *mut bool) -> NapiStatus {
      unsafe {
        with_env(env, |_inner, scope| {
          let v = from_napi_value(value)?;
          write_out(result, ($pred)(scope, v))
        })
      }
    }
  };
}

macro_rules! impl_napi_coerce {
  ($name:ident, $tc:ident, $v:ident => $conv:expr) => {
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn $name(env: NapiEnv, value: NapiValue, result: *mut NapiValue) -> NapiStatus {
      unsafe {
        with_env(env, |inner, scope| {
          let $v = from_napi_value(value)?;
          let out = run_with_try_catch(scope, inner, |$tc| $conv)?;
          write_out(result, to_napi_value(out))
        })
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Singletons & Numbers & Dates & Symbols
// ---------------------------------------------------------------------------

impl_napi_singleton!(napi_get_undefined, scope => v8::undefined(scope));
impl_napi_singleton!(napi_get_null, scope => v8::null(scope));
impl_napi_singleton!(napi_get_global, scope => scope.get_current_context().global(scope));

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_boolean(env: NapiEnv, value: bool, result: *mut NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      write_out(result, to_napi_value(v8::Boolean::new(scope, value)))
    })
  }
}

impl_napi_create_num!(napi_create_double, f64, scope, v => v8::Number::new(scope, v));
impl_napi_create_num!(napi_create_int32, i32, scope, v => v8::Integer::new(scope, v));
impl_napi_create_num!(napi_create_uint32, u32, scope, v => v8::Integer::new_from_unsigned(scope, v));
impl_napi_create_num!(napi_create_int64, i64, scope, v => v8::Number::new(scope, v as f64));
impl_napi_create_num!(napi_create_bigint_int64, i64, scope, v => v8::BigInt::new_from_i64(scope, v));
impl_napi_create_num!(napi_create_bigint_uint64, u64, scope, v => v8::BigInt::new_from_u64(scope, v));

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_bigint_words(
  env: NapiEnv,
  sign_bit: i32,
  word_count: usize,
  words: *const u64,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let slice = if word_count == 0 {
        &[]
      } else {
        if words.is_null() {
          return Err(NAPI_INVALID_ARG);
        }
        std::slice::from_raw_parts(words, word_count)
      };
      let bi = v8::BigInt::new_from_words(scope, sign_bit != 0, slice).ok_or(NAPI_GENERIC_FAILURE)?;
      write_out(result, to_napi_value(bi))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_date(env: NapiEnv, time: f64, result: *mut NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let d = v8::Date::new(scope, time).ok_or(NAPI_GENERIC_FAILURE)?;
      write_out(result, to_napi_value(d))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_symbol(
  env: NapiEnv,
  description: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let desc = if description.is_null() {
        None
      } else {
        let v = from_napi_value(description)?;
        if !v.is_string() {
          return Err(NAPI_STRING_EXPECTED);
        }
        Some(v8::Local::<v8::String>::try_from(v).map_err(|_| NAPI_STRING_EXPECTED)?)
      };
      let sym = v8::Symbol::new(scope, desc);
      write_out(result, to_napi_value(sym))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_symbol_for(
  env: NapiEnv,
  utf8description: *const c_char,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let s = read_c_str(utf8description, length)?;
      let v8_str = v8::String::new(scope, &s).ok_or(NAPI_GENERIC_FAILURE)?;
      let sym = v8::Symbol::for_key(scope, v8_str);
      write_out(result, to_napi_value(sym))
    })
  }
}

// ---------------------------------------------------------------------------
// Strings (DRY shared creators & extractors)
// ---------------------------------------------------------------------------

unsafe fn create_utf8_str_impl(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  result: *mut NapiValue,
  internalized: bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let s = read_c_str(str_ptr, length)?;
      let v8_str = if internalized {
        v8::String::new_from_utf8(scope, s.as_bytes(), v8::NewStringType::Internalized)
      } else {
        v8::String::new_from_utf8(scope, s.as_bytes(), v8::NewStringType::Normal)
      }
      .ok_or(NAPI_GENERIC_FAILURE)?;
      write_out(result, to_napi_value(v8_str))
    })
  }
}

unsafe fn create_latin1_str_impl(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  result: *mut NapiValue,
  internalized: bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let bytes = read_c_bytes(str_ptr, length)?;
      let kind = if internalized {
        v8::NewStringType::Internalized
      } else {
        v8::NewStringType::Normal
      };
      let v8_str = v8::String::new_from_one_byte(scope, bytes, kind).ok_or(NAPI_GENERIC_FAILURE)?;
      write_out(result, to_napi_value(v8_str))
    })
  }
}

unsafe fn create_utf16_str_impl(
  env: NapiEnv,
  str_ptr: *const u16,
  length: usize,
  result: *mut NapiValue,
  internalized: bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if str_ptr.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let slice = if length == NAPI_AUTO_LENGTH {
        let mut n = 0;
        while *str_ptr.add(n) != 0 {
          n += 1;
        }
        std::slice::from_raw_parts(str_ptr, n)
      } else {
        std::slice::from_raw_parts(str_ptr, length)
      };
      let kind = if internalized {
        v8::NewStringType::Internalized
      } else {
        v8::NewStringType::Normal
      };
      let v8_str = v8::String::new_from_two_byte(scope, slice, kind).ok_or(NAPI_GENERIC_FAILURE)?;
      write_out(result, to_napi_value(v8_str))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_string_utf8(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_utf8_str_impl(env, str_ptr, length, result, false) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_string_latin1(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_latin1_str_impl(env, str_ptr, length, result, false) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_string_utf16(
  env: NapiEnv,
  str_ptr: *const u16,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_utf16_str_impl(env, str_ptr, length, result, false) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_property_key_utf8(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_utf8_str_impl(env, str_ptr, length, result, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_property_key_latin1(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_latin1_str_impl(env, str_ptr, length, result, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_property_key_utf16(
  env: NapiEnv,
  str_ptr: *const u16,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_utf16_str_impl(env, str_ptr, length, result, true) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_external_string_latin1(
  env: NapiEnv,
  str_ptr: *const c_char,
  length: usize,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiValue,
  copied: *mut bool,
) -> NapiStatus {
  let status = unsafe { create_latin1_str_impl(env, str_ptr, length, result, false) };
  if status == NAPI_OK {
    if !copied.is_null() {
      unsafe { *copied = true };
    }
    if let Some(cb) = finalize_cb {
      unsafe { cb(env, str_ptr as *mut c_void, finalize_hint) };
    }
  }
  status
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_external_string_utf16(
  env: NapiEnv,
  str_ptr: *const u16,
  length: usize,
  finalize_cb: Option<NapiFinalize>,
  finalize_hint: *mut c_void,
  result: *mut NapiValue,
  copied: *mut bool,
) -> NapiStatus {
  let status = unsafe { create_utf16_str_impl(env, str_ptr, length, result, false) };
  if status == NAPI_OK {
    if !copied.is_null() {
      unsafe { *copied = true };
    }
    if let Some(cb) = finalize_cb {
      unsafe { cb(env, str_ptr as *mut c_void, finalize_hint) };
    }
  }
  status
}

unsafe fn get_v8_string<'s>(val: NapiValue) -> Result<v8::Local<'s, v8::String>, NapiStatus> {
  let v = unsafe { from_napi_value(val)? };
  if !v.is_string() {
    return Err(NAPI_STRING_EXPECTED);
  }
  v8::Local::<v8::String>::try_from(v).map_err(|_| NAPI_STRING_EXPECTED)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_string_utf8(
  env: NapiEnv,
  value: NapiValue,
  buf: *mut c_char,
  bufsize: usize,
  result: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let s = get_v8_string(value)?.to_rust_string_lossy(scope);
      let bytes = s.as_bytes();
      if buf.is_null() {
        return write_out(result, bytes.len());
      }
      if bufsize == 0 {
        if !result.is_null() {
          *result = 0;
        }
        return Ok(());
      }
      // Copy up to bufsize - 1 bytes without splitting a multi-byte UTF-8 sequence.
      let mut n = bytes.len().min(bufsize - 1);
      while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
      }
      std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, n);
      *buf.add(n) = 0;
      if !result.is_null() {
        *result = n;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_string_latin1(
  env: NapiEnv,
  value: NapiValue,
  buf: *mut c_char,
  bufsize: usize,
  result: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let s = get_v8_string(value)?.to_rust_string_lossy(scope);
      let latin1: Vec<u8> = s.chars().map(|c| c as u8).collect();
      if buf.is_null() {
        return write_out(result, latin1.len());
      }
      if bufsize == 0 {
        if !result.is_null() {
          *result = 0;
        }
        return Ok(());
      }
      let n = latin1.len().min(bufsize - 1);
      std::ptr::copy_nonoverlapping(latin1.as_ptr(), buf as *mut u8, n);
      *buf.add(n) = 0;
      if !result.is_null() {
        *result = n;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_string_utf16(
  env: NapiEnv,
  value: NapiValue,
  buf: *mut u16,
  bufsize: usize,
  result: *mut usize,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let s = get_v8_string(value)?.to_rust_string_lossy(scope);
      let utf16: Vec<u16> = s.encode_utf16().collect();
      if buf.is_null() {
        return write_out(result, utf16.len());
      }
      if bufsize == 0 {
        if !result.is_null() {
          *result = 0;
        }
        return Ok(());
      }
      let n = utf16.len().min(bufsize - 1);
      std::ptr::copy_nonoverlapping(utf16.as_ptr(), buf, n);
      *buf.add(n) = 0;
      if !result.is_null() {
        *result = n;
      }
      Ok(())
    })
  }
}

// ---------------------------------------------------------------------------
// Typeof, Value Extraction, Predicates, Coercion
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_typeof(env: NapiEnv, value: NapiValue, result: *mut NapiValueType) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(value)?;
      let ty = if v.is_undefined() {
        NAPI_UNDEFINED
      } else if v.is_null() {
        NAPI_NULL
      } else if v.is_boolean() {
        NAPI_BOOLEAN
      } else if v.is_number() {
        NAPI_NUMBER
      } else if v.is_string() {
        NAPI_STRING
      } else if v.is_symbol() {
        NAPI_SYMBOL
      } else if v.is_external() {
        NAPI_EXTERNAL
      } else if v.is_function() {
        NAPI_FUNCTION
      } else if v.is_big_int() {
        NAPI_BIGINT
      } else {
        NAPI_OBJECT
      };
      write_out(result, ty)
    })
  }
}

impl_napi_get_num!(
  napi_get_value_double,
  f64,
  |v: &v8::Local<'_, v8::Value>| v.is_number(),
  NAPI_NUMBER_EXPECTED,
  |scope, v: v8::Local<'_, v8::Value>| v.number_value(scope)
);
impl_napi_get_num!(
  napi_get_value_int32,
  i32,
  |v: &v8::Local<'_, v8::Value>| v.is_number(),
  NAPI_NUMBER_EXPECTED,
  |scope, v: v8::Local<'_, v8::Value>| v.int32_value(scope)
);
impl_napi_get_num!(
  napi_get_value_uint32,
  u32,
  |v: &v8::Local<'_, v8::Value>| v.is_number(),
  NAPI_NUMBER_EXPECTED,
  |scope, v: v8::Local<'_, v8::Value>| v.uint32_value(scope)
);
impl_napi_get_num!(
  napi_get_value_int64,
  i64,
  |v: &v8::Local<'_, v8::Value>| v.is_number(),
  NAPI_NUMBER_EXPECTED,
  |scope, v: v8::Local<'_, v8::Value>| v.integer_value(scope)
);
impl_napi_get_num!(
  napi_get_value_bool,
  bool,
  |v: &v8::Local<'_, v8::Value>| v.is_boolean(),
  NAPI_BOOLEAN_EXPECTED,
  |scope, v: v8::Local<'_, v8::Value>| Some(v.boolean_value(scope))
);
impl_napi_get_num!(
  napi_get_date_value,
  f64,
  |v: &v8::Local<'_, v8::Value>| v.is_date(),
  NAPI_DATE_EXPECTED,
  |_scope, v: v8::Local<'_, v8::Value>| { v8::Local::<v8::Date>::try_from(v).ok().map(|d| d.value_of()) }
);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_bigint_int64(
  env: NapiEnv,
  value: NapiValue,
  result: *mut i64,
  lossless: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(value)?;
      if !v.is_big_int() {
        return Err(NAPI_BIGINT_EXPECTED);
      }
      let bi = v8::Local::<v8::BigInt>::try_from(v).map_err(|_| NAPI_BIGINT_EXPECTED)?;
      let (val, is_lossless) = bi.i64_value();
      write_out(result, val)?;
      if !lossless.is_null() {
        *lossless = is_lossless;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_bigint_uint64(
  env: NapiEnv,
  value: NapiValue,
  result: *mut u64,
  lossless: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(value)?;
      if !v.is_big_int() {
        return Err(NAPI_BIGINT_EXPECTED);
      }
      let bi = v8::Local::<v8::BigInt>::try_from(v).map_err(|_| NAPI_BIGINT_EXPECTED)?;
      let (val, is_lossless) = bi.u64_value();
      write_out(result, val)?;
      if !lossless.is_null() {
        *lossless = is_lossless;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_value_bigint_words(
  env: NapiEnv,
  value: NapiValue,
  sign_bit: *mut i32,
  word_count: *mut usize,
  words: *mut u64,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(value)?;
      if !v.is_big_int() {
        return Err(NAPI_BIGINT_EXPECTED);
      }
      if word_count.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let bi = v8::Local::<v8::BigInt>::try_from(v).map_err(|_| NAPI_BIGINT_EXPECTED)?;
      let needed = bi.word_count();
      if words.is_null() {
        *word_count = needed;
        return Ok(());
      }
      if sign_bit.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let cap = *word_count;
      let buf = std::slice::from_raw_parts_mut(words, cap);
      let (neg, written) = bi.to_words_array(buf);
      *sign_bit = if neg { 1 } else { 0 };
      *word_count = written.len();
      Ok(())
    })
  }
}

impl_napi_is!(napi_is_array, |_, v: v8::Local<'_, v8::Value>| v.is_array());
impl_napi_is!(napi_is_date, |_, v: v8::Local<'_, v8::Value>| v.is_date());
impl_napi_is!(napi_is_error, |_, v: v8::Local<'_, v8::Value>| v.is_native_error());
impl_napi_is!(napi_is_promise, |_, v: v8::Local<'_, v8::Value>| v.is_promise());
impl_napi_is!(napi_is_arraybuffer, |_, v: v8::Local<'_, v8::Value>| v
  .is_array_buffer());
impl_napi_is!(node_api_is_sharedarraybuffer, |_, v: v8::Local<'_, v8::Value>| v
  .is_shared_array_buffer());
impl_napi_is!(napi_is_typedarray, |_, v: v8::Local<'_, v8::Value>| v.is_typed_array());
impl_napi_is!(napi_is_dataview, |_, v: v8::Local<'_, v8::Value>| v.is_data_view());
impl_napi_is!(
  napi_is_buffer,
  |scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>| {
    if v.is_uint8_array() {
      let global = scope.get_current_context().global(scope);
      let key = v8::String::new(scope, "Buffer").unwrap();
      if let Some(buf_ctor) = global.get(scope, key.into())
        && let Ok(func) = v8::Local::<v8::Function>::try_from(buf_ctor)
      {
        let is_buf_key = v8::String::new(scope, "isBuffer").unwrap();
        if let Some(is_buf_val) = func.get(scope, is_buf_key.into())
          && let Ok(is_buf_fn) = v8::Local::<v8::Function>::try_from(is_buf_val)
        {
          return is_buf_fn
            .call(scope, func.into(), &[v])
            .is_some_and(|r| r.boolean_value(scope));
        }
      }
      return true;
    }
    false
  }
);
impl_napi_is!(napi_is_detached_arraybuffer, |_, v: v8::Local<'_, v8::Value>| {
  v8::Local::<v8::ArrayBuffer>::try_from(v)
    .map(|ab| ab.was_detached())
    .unwrap_or(false)
});

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_strict_equals(
  env: NapiEnv,
  lhs: NapiValue,
  rhs: NapiValue,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let a = from_napi_value(lhs)?;
      let b = from_napi_value(rhs)?;
      write_out(result, a.strict_equals(b))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_instanceof(
  env: NapiEnv,
  object: NapiValue,
  constructor: NapiValue,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_value(object)?;
      let ctor = from_napi_value(constructor)?;
      if !ctor.is_function() {
        return Err(NAPI_FUNCTION_EXPECTED);
      }
      let ctor_obj = ctor.to_object(scope).ok_or(NAPI_FUNCTION_EXPECTED)?;
      let res = run_with_try_catch(scope, inner, |tc| obj.instance_of(tc, ctor_obj))?;
      write_out(result, res)
    })
  }
}

impl_napi_coerce!(napi_coerce_to_bool, tc, v => Some(v8::Local::<v8::Value>::from(v.to_boolean(tc))));
impl_napi_coerce!(napi_coerce_to_number, tc, v => v.to_number(tc).map(v8::Local::<v8::Value>::from));
impl_napi_coerce!(napi_coerce_to_object, tc, v => v.to_object(tc).map(v8::Local::<v8::Value>::from));
impl_napi_coerce!(napi_coerce_to_string, tc, v => v.to_string(tc).map(v8::Local::<v8::Value>::from));
