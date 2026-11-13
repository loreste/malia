//! N-API error creation, exception throwing, and fatal error functions.

use std::ffi::c_char;

use deno_core::v8;

use super::env::*;
use super::types::*;

#[derive(Clone, Copy)]
enum ErrorKind {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
}

fn make_v8_error<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  kind: ErrorKind,
  msg: v8::Local<'s, v8::String>,
) -> v8::Local<'s, v8::Value> {
  match kind {
    ErrorKind::Error => v8::Exception::error(scope, msg),
    ErrorKind::TypeError => v8::Exception::type_error(scope, msg),
    ErrorKind::RangeError => v8::Exception::range_error(scope, msg),
    ErrorKind::SyntaxError => v8::Exception::syntax_error(scope, msg),
  }
}

unsafe fn create_error_impl(
  env: NapiEnv,
  kind: ErrorKind,
  code: NapiValue,
  msg: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let msg_val = from_napi_value(msg)?;
      if !msg_val.is_string() {
        return Err(NAPI_STRING_EXPECTED);
      }
      let msg_str = v8::Local::<v8::String>::try_from(msg_val).map_err(|_| NAPI_STRING_EXPECTED)?;
      let err_val = make_v8_error(scope, kind, msg_str);
      if !code.is_null() {
        let code_val = from_napi_value(code)?;
        if let Ok(err_obj) = v8::Local::<v8::Object>::try_from(err_val)
          && let Some(k) = v8::String::new(scope, "code")
        {
          err_obj.set(scope, k.into(), code_val);
        }
      }
      write_out(result, to_napi_value(err_val))
    })
  }
}

unsafe fn throw_error_impl(
  env: NapiEnv,
  kind: ErrorKind,
  code: *const c_char,
  msg: *const c_char,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let msg_s = read_c_str(msg, NAPI_AUTO_LENGTH)?;
      let msg_v8 = v8::String::new(scope, &msg_s).ok_or(NAPI_GENERIC_FAILURE)?;
      let err_val = make_v8_error(scope, kind, msg_v8);
      if !code.is_null() {
        let code_s = read_c_str(code, NAPI_AUTO_LENGTH)?;
        if let Some(code_v8) = v8::String::new(scope, &code_s)
          && let Ok(err_obj) = v8::Local::<v8::Object>::try_from(err_val)
          && let Some(k) = v8::String::new(scope, "code")
        {
          err_obj.set(scope, k.into(), code_v8.into());
        }
      }
      inner.pending_exception = Some(v8::Global::new(scope, err_val));
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_error(
  env: NapiEnv,
  code: NapiValue,
  msg: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_error_impl(env, ErrorKind::Error, code, msg, result) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_type_error(
  env: NapiEnv,
  code: NapiValue,
  msg: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_error_impl(env, ErrorKind::TypeError, code, msg, result) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_range_error(
  env: NapiEnv,
  code: NapiValue,
  msg: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_error_impl(env, ErrorKind::RangeError, code, msg, result) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_syntax_error(
  env: NapiEnv,
  code: NapiValue,
  msg: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { create_error_impl(env, ErrorKind::SyntaxError, code, msg, result) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_throw(env: NapiEnv, error: NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let val = from_napi_value(error)?;
      inner.pending_exception = Some(v8::Global::new(scope, val));
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_throw_error(
  env: NapiEnv,
  code: *const c_char,
  msg: *const c_char,
) -> NapiStatus {
  unsafe { throw_error_impl(env, ErrorKind::Error, code, msg) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_throw_type_error(
  env: NapiEnv,
  code: *const c_char,
  msg: *const c_char,
) -> NapiStatus {
  unsafe { throw_error_impl(env, ErrorKind::TypeError, code, msg) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_throw_range_error(
  env: NapiEnv,
  code: *const c_char,
  msg: *const c_char,
) -> NapiStatus {
  unsafe { throw_error_impl(env, ErrorKind::RangeError, code, msg) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_throw_syntax_error(
  env: NapiEnv,
  code: *const c_char,
  msg: *const c_char,
) -> NapiStatus {
  unsafe { throw_error_impl(env, ErrorKind::SyntaxError, code, msg) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_is_exception_pending(
  env: NapiEnv,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env_basic(env, |inner| {
      write_out(result, inner.pending_exception.is_some())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_and_clear_last_exception(
  env: NapiEnv,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let val = match inner.pending_exception.take() {
        Some(exc) => v8::Local::new(scope, exc),
        None => v8::undefined(scope).into(),
      };
      write_out(result, to_napi_value(val))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_fatal_error(
  location: *const c_char,
  location_len: usize,
  message: *const c_char,
  message_len: usize,
) -> ! {
  let loc = unsafe { read_c_str(location, location_len) }.unwrap_or_else(|_| "<unknown>".into());
  let msg = unsafe { read_c_str(message, message_len) }.unwrap_or_else(|_| "<fatal>".into());
  eprintln!("FATAL ERROR: {loc}: {msg}");
  std::process::abort();
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_fatal_exception(env: NapiEnv, err: NapiValue) -> NapiStatus {
  unsafe { napi_throw(env, err) }
}

