//! N-API function, class, callback, and script execution functions.

use std::ffi::c_char;
use std::ffi::c_void;

use deno_core::v8;

use super::env::*;
use super::objects::define_property_on_object;
use super::types::*;

struct CallbackData {
  env: NapiEnv,
  cb: NapiCallback,
  data: *mut c_void,
}

struct CbInfo<'a, 's> {
  args: &'a v8::FunctionCallbackArguments<'s>,
  data: *mut c_void,
}

fn v8_callback_trampoline(
  scope: &mut v8::PinScope<'_, '_>,
  args: v8::FunctionCallbackArguments,
  mut rv: v8::ReturnValue,
) {
  let Ok(ext) = v8::Local::<v8::External>::try_from(args.data()) else {
    return;
  };
  let cb_data = unsafe { &*(ext.value() as *const CallbackData) };
  let env_ptr = cb_data.env;
  let _guard = unsafe { ScopeGuard::enter(env_ptr, scope) };

  let cb_info = CbInfo {
    args: &args,
    data: cb_data.data,
  };
  let ret = unsafe { (cb_data.cb)(env_ptr, &cb_info as *const CbInfo as NapiCallbackInfo) };

  let inner = unsafe { &mut *env_ptr };
  if inner.active_async_count.load(std::sync::atomic::Ordering::SeqCst) > 0 {
    notify_js_async_ref(scope);
  }
  if let Some(exc_global) = inner.pending_exception.take() {
    let exc = v8::Local::new(scope, exc_global);
    scope.throw_exception(exc);
    return;
  }

  if !ret.is_null()
    && let Ok(val) = unsafe { from_napi_value(ret) }
  {
    rv.set(val);
  }
}

pub(crate) fn make_v8_function<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  env_ptr: NapiEnv,
  name: &str,
  cb: NapiCallback,
  data: *mut c_void,
) -> Result<v8::Local<'s, v8::Function>, NapiStatus> {
  let cb_data = Box::into_raw(Box::new(CallbackData {
    env: env_ptr,
    cb,
    data,
  }));
  let ext = v8::External::new(scope, cb_data as *mut c_void);
  let func = v8::Function::builder(v8_callback_trampoline)
    .data(ext.into())
    .build(scope)
    .ok_or(NAPI_GENERIC_FAILURE)?;
  if !name.is_empty()
    && let Some(v8_name) = v8::String::new(scope, name)
  {
    func.set_name(v8_name);
  }
  Ok(func)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_function(
  env: NapiEnv,
  utf8name: *const c_char,
  length: usize,
  cb: Option<NapiCallback>,
  data: *mut c_void,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let cb = cb.ok_or(NAPI_INVALID_ARG)?;
      let name = if utf8name.is_null() {
        String::new()
      } else {
        read_c_str(utf8name, length)?
      };
      let func = make_v8_function(scope, env, &name, cb, data)?;
      write_out(result, to_napi_value(func))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_cb_info(
  env: NapiEnv,
  cbinfo: NapiCallbackInfo,
  argc: *mut usize,
  argv: *mut NapiValue,
  this_arg: *mut NapiValue,
  data: *mut *mut c_void,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      if cbinfo.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let info = &*(cbinfo as *const CbInfo<'_, '_>);
      let actual_argc = info.args.length() as usize;

      if !argc.is_null() {
        let requested = *argc;
        if !argv.is_null() {
          let copy_count = requested.min(actual_argc);
          for i in 0..copy_count {
            *argv.add(i) = to_napi_value(info.args.get(i as i32));
          }
          if requested > copy_count {
            let undef = to_napi_value(v8::undefined(scope));
            for i in copy_count..requested {
              *argv.add(i) = undef;
            }
          }
        }
        *argc = actual_argc;
      }

      if !this_arg.is_null() {
        *this_arg = to_napi_value(info.args.this());
      }
      if !data.is_null() {
        *data = info.data;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_new_target(
  env: NapiEnv,
  cbinfo: NapiCallbackInfo,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      if cbinfo.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let info = &*(cbinfo as *const CbInfo<'_, '_>);
      let nt = info.args.new_target();
      if nt.is_undefined() {
        write_out(result, std::ptr::null_mut())
      } else {
        write_out(result, to_napi_value(nt))
      }
    })
  }
}

unsafe fn collect_args<'s>(
  argc: usize,
  argv: *const NapiValue,
) -> Result<Vec<v8::Local<'s, v8::Value>>, NapiStatus> {
  if argc == 0 {
    return Ok(Vec::new());
  }
  if argv.is_null() {
    return Err(NAPI_INVALID_ARG);
  }
  let mut args = Vec::with_capacity(argc);
  for i in 0..argc {
    args.push(unsafe { from_napi_value(*argv.add(i))? });
  }
  Ok(args)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_call_function(
  env: NapiEnv,
  recv: NapiValue,
  func: NapiValue,
  argc: usize,
  argv: *const NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let f_val = from_napi_value(func)?;
      let f = v8::Local::<v8::Function>::try_from(f_val).map_err(|_| NAPI_FUNCTION_EXPECTED)?;
      let receiver = if recv.is_null() {
        v8::undefined(scope).into()
      } else {
        from_napi_value(recv)?
      };
      let args = collect_args(argc, argv)?;
      let ret = run_with_try_catch(scope, inner, |tc| f.call(tc, receiver, &args))?;
      if !result.is_null() {
        *result = to_napi_value(ret);
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_make_callback(
  env: NapiEnv,
  _async_context: NapiAsyncContext,
  recv: NapiValue,
  func: NapiValue,
  argc: usize,
  argv: *const NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe { napi_call_function(env, recv, func, argc, argv, result) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_new_instance(
  env: NapiEnv,
  constructor: NapiValue,
  argc: usize,
  argv: *const NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let c_val = from_napi_value(constructor)?;
      let ctor = v8::Local::<v8::Function>::try_from(c_val).map_err(|_| NAPI_FUNCTION_EXPECTED)?;
      let args = collect_args(argc, argv)?;
      let inst = run_with_try_catch(scope, inner, |tc| ctor.new_instance(tc, &args))?;
      write_out(result, to_napi_value(inst))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_define_class(
  env: NapiEnv,
  utf8name: *const c_char,
  length: usize,
  constructor: Option<NapiCallback>,
  data: *mut c_void,
  property_count: usize,
  properties: *const NapiPropertyDescriptor,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let ctor_cb = constructor.ok_or(NAPI_INVALID_ARG)?;
      let name = if utf8name.is_null() {
        String::new()
      } else {
        read_c_str(utf8name, length)?
      };
      let cb_data = Box::into_raw(Box::new(CallbackData {
        env,
        cb: ctor_cb,
        data,
      }));
      let ext = v8::External::new(scope, cb_data as *mut c_void);
      let tpl = v8::FunctionTemplate::builder(v8_callback_trampoline)
        .data(ext.into())
        .build(scope);
      if !name.is_empty()
        && let Some(v8_name) = v8::String::new(scope, &name)
      {
        tpl.set_class_name(v8_name);
      }
      let func = tpl.get_function(scope).ok_or(NAPI_GENERIC_FAILURE)?;
      let ctor_obj: v8::Local<'_, v8::Object> = func.into();

      let proto_key = v8::String::new(scope, "prototype").ok_or(NAPI_GENERIC_FAILURE)?;
      let proto_val = ctor_obj
        .get(scope, proto_key.into())
        .ok_or(NAPI_GENERIC_FAILURE)?;
      let proto_obj = proto_val.to_object(scope).ok_or(NAPI_OBJECT_EXPECTED)?;

      if property_count > 0 {
        if properties.is_null() {
          return Err(NAPI_INVALID_ARG);
        }
        let slice = std::slice::from_raw_parts(properties, property_count);
        for prop in slice {
          let target = if prop.attributes & NAPI_STATIC != 0 {
            ctor_obj
          } else {
            proto_obj
          };
          define_property_on_object(scope, inner, env, target, prop)?;
        }
      }

      write_out(result, to_napi_value(func))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_run_script(
  env: NapiEnv,
  script: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let v = from_napi_value(script)?;
      if !v.is_string() {
        return Err(NAPI_STRING_EXPECTED);
      }
      let code = v8::Local::<v8::String>::try_from(v).map_err(|_| NAPI_STRING_EXPECTED)?;
      let val = run_with_try_catch(scope, inner, |tc| {
        v8::Script::compile(tc, code, None).and_then(|s| s.run(tc))
      })?;
      write_out(result, to_napi_value(val))
    })
  }
}
