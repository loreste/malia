//! N-API object, array, and property manipulation functions.

use std::ffi::c_char;

use deno_core::v8;

use super::env::*;
use super::functions::make_v8_function;
use super::types::*;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_object(env: NapiEnv, result: *mut NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let obj = v8::Object::new(scope);
      write_out(result, to_napi_value(obj))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_create_object_with_properties(
  env: NapiEnv,
  prototype_or_null: NapiValue,
  property_names: *const NapiValue,
  property_values: *const NapiValue,
  property_count: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = v8::Object::new(scope);
      if !prototype_or_null.is_null() {
        let proto = from_napi_value(prototype_or_null)?;
        obj.set_prototype(scope, proto);
      }
      if property_count > 0 {
        if property_names.is_null() || property_values.is_null() {
          return Err(NAPI_INVALID_ARG);
        }
        for i in 0..property_count {
          let k = from_napi_value(*property_names.add(i))?;
          let v = from_napi_value(*property_values.add(i))?;
          let ok = run_with_try_catch(scope, inner, |tc| obj.set(tc, k, v))?;
          if !ok {
            return Err(NAPI_GENERIC_FAILURE);
          }
        }
      }
      write_out(result, to_napi_value(obj))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn node_api_set_prototype(env: NapiEnv, object: NapiValue, value: NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let proto = from_napi_value(value)?;
      if obj.set_prototype(scope, proto) == Some(true) {
        Ok(())
      } else {
        Err(NAPI_GENERIC_FAILURE)
      }
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_array(env: NapiEnv, result: *mut NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let arr = v8::Array::new(scope, 0);
      write_out(result, to_napi_value(arr))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_create_array_with_length(
  env: NapiEnv,
  length: usize,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let arr = v8::Array::new(scope, length as i32);
      write_out(result, to_napi_value(arr))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_array_length(env: NapiEnv, value: NapiValue, result: *mut u32) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, _scope| {
      let v = from_napi_value(value)?;
      if !v.is_array() {
        return Err(NAPI_ARRAY_EXPECTED);
      }
      let arr = v8::Local::<v8::Array>::try_from(v).map_err(|_| NAPI_ARRAY_EXPECTED)?;
      write_out(result, arr.length())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_prototype(env: NapiEnv, object: NapiValue, result: *mut NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |_inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let proto = obj.get_prototype(scope).ok_or(NAPI_GENERIC_FAILURE)?;
      write_out(result, to_napi_value(proto))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_property_names(
  env: NapiEnv,
  object: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    napi_get_all_property_names(
      env,
      object,
      NAPI_KEY_INCLUDE_PROTOTYPES,
      NAPI_KEY_ENUMERABLE | NAPI_KEY_SKIP_SYMBOLS,
      NAPI_KEY_NUMBERS_TO_STRINGS,
      result,
    )
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_all_property_names(
  env: NapiEnv,
  object: NapiValue,
  key_mode: i32,
  key_filter: i32,
  key_conversion: i32,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let mode = if key_mode == NAPI_KEY_OWN_ONLY {
        v8::KeyCollectionMode::OwnOnly
      } else {
        v8::KeyCollectionMode::IncludePrototypes
      };
      let mut filter = v8::PropertyFilter::ALL_PROPERTIES;
      if key_filter & NAPI_KEY_WRITABLE != 0 {
        filter = filter | v8::PropertyFilter::ONLY_WRITABLE;
      }
      if key_filter & NAPI_KEY_ENUMERABLE != 0 {
        filter = filter | v8::PropertyFilter::ONLY_ENUMERABLE;
      }
      if key_filter & NAPI_KEY_CONFIGURABLE != 0 {
        filter = filter | v8::PropertyFilter::ONLY_CONFIGURABLE;
      }
      if key_filter & NAPI_KEY_SKIP_STRINGS != 0 {
        filter = filter | v8::PropertyFilter::SKIP_STRINGS;
      }
      if key_filter & NAPI_KEY_SKIP_SYMBOLS != 0 {
        filter = filter | v8::PropertyFilter::SKIP_SYMBOLS;
      }
      let key_conv = if key_conversion == NAPI_KEY_KEEP_NUMBERS {
        v8::KeyConversionMode::KeepNumbers
      } else {
        v8::KeyConversionMode::ConvertToString
      };
      let args = v8::GetPropertyNamesArgsBuilder::new()
        .mode(mode)
        .property_filter(filter)
        .key_conversion(key_conv)
        .build();
      let names = run_with_try_catch(scope, inner, |tc| obj.get_property_names(tc, args))?;
      write_out(result, to_napi_value(names))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_set_property(
  env: NapiEnv,
  object: NapiValue,
  key: NapiValue,
  value: NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = from_napi_value(key)?;
      let v = from_napi_value(value)?;
      let ok = run_with_try_catch(scope, inner, |tc| obj.set(tc, k, v))?;
      if ok { Ok(()) } else { Err(NAPI_GENERIC_FAILURE) }
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_has_property(
  env: NapiEnv,
  object: NapiValue,
  key: NapiValue,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = from_napi_value(key)?;
      let has = run_with_try_catch(scope, inner, |tc| obj.has(tc, k))?;
      write_out(result, has)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_property(
  env: NapiEnv,
  object: NapiValue,
  key: NapiValue,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = from_napi_value(key)?;
      let val = run_with_try_catch(scope, inner, |tc| obj.get(tc, k))?;
      write_out(result, to_napi_value(val))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_delete_property(
  env: NapiEnv,
  object: NapiValue,
  key: NapiValue,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = from_napi_value(key)?;
      let deleted = run_with_try_catch(scope, inner, |tc| obj.delete(tc, k))?;
      if !result.is_null() {
        *result = deleted;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_has_own_property(
  env: NapiEnv,
  object: NapiValue,
  key: NapiValue,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = from_napi_value(key)?;
      let name = v8::Local::<v8::Name>::try_from(k).map_err(|_| NAPI_NAME_EXPECTED)?;
      let has = run_with_try_catch(scope, inner, |tc| obj.has_own_property(tc, name))?;
      write_out(result, has)
    })
  }
}

fn named_key<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  utf8name: *const c_char,
) -> Result<v8::Local<'s, v8::Value>, NapiStatus> {
  let s = unsafe { read_c_str(utf8name, NAPI_AUTO_LENGTH)? };
  v8::String::new(scope, &s)
    .map(v8::Local::<v8::Value>::from)
    .ok_or(NAPI_GENERIC_FAILURE)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_set_named_property(
  env: NapiEnv,
  object: NapiValue,
  utf8name: *const c_char,
  value: NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = named_key(scope, utf8name)?;
      let v = from_napi_value(value)?;
      let ok = run_with_try_catch(scope, inner, |tc| obj.set(tc, k, v))?;
      if ok { Ok(()) } else { Err(NAPI_GENERIC_FAILURE) }
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_has_named_property(
  env: NapiEnv,
  object: NapiValue,
  utf8name: *const c_char,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = named_key(scope, utf8name)?;
      let has = run_with_try_catch(scope, inner, |tc| obj.has(tc, k))?;
      write_out(result, has)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_named_property(
  env: NapiEnv,
  object: NapiValue,
  utf8name: *const c_char,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let k = named_key(scope, utf8name)?;
      let val = run_with_try_catch(scope, inner, |tc| obj.get(tc, k))?;
      write_out(result, to_napi_value(val))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_set_element(env: NapiEnv, object: NapiValue, index: u32, value: NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let v = from_napi_value(value)?;
      let ok = run_with_try_catch(scope, inner, |tc| obj.set_index(tc, index, v))?;
      if ok { Ok(()) } else { Err(NAPI_GENERIC_FAILURE) }
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_has_element(
  env: NapiEnv,
  object: NapiValue,
  index: u32,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let has = run_with_try_catch(scope, inner, |tc| obj.has_index(tc, index))?;
      write_out(result, has)
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_get_element(
  env: NapiEnv,
  object: NapiValue,
  index: u32,
  result: *mut NapiValue,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let val = run_with_try_catch(scope, inner, |tc| obj.get_index(tc, index))?;
      write_out(result, to_napi_value(val))
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_delete_element(
  env: NapiEnv,
  object: NapiValue,
  index: u32,
  result: *mut bool,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let deleted = run_with_try_catch(scope, inner, |tc| obj.delete_index(tc, index))?;
      if !result.is_null() {
        *result = deleted;
      }
      Ok(())
    })
  }
}

/// Shared property-definition helper used by both `napi_define_properties`
/// and `napi_define_class`.
pub(crate) unsafe fn define_property_on_object<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  inner: &mut NapiEnvInner,
  env_ptr: NapiEnv,
  obj: v8::Local<'s, v8::Object>,
  prop: &NapiPropertyDescriptor,
) -> Result<(), NapiStatus> {
  let key_name: v8::Local<'s, v8::Name> = if !prop.utf8name.is_null() {
    let s = unsafe { read_c_str(prop.utf8name, NAPI_AUTO_LENGTH)? };
    v8::String::new(scope, &s).ok_or(NAPI_GENERIC_FAILURE)?.into()
  } else if !prop.name.is_null() {
    let v = unsafe { from_napi_value(prop.name)? };
    v8::Local::<v8::Name>::try_from(v).map_err(|_| NAPI_NAME_EXPECTED)?
  } else {
    return Err(NAPI_INVALID_ARG);
  };

  let writable = prop.attributes & NAPI_WRITABLE != 0;
  let enumerable = prop.attributes & NAPI_ENUMERABLE != 0;
  let configurable = prop.attributes & NAPI_CONFIGURABLE != 0;

  if prop.getter.is_some() || prop.setter.is_some() {
    let getter = prop
      .getter
      .map(|cb| make_v8_function(scope, env_ptr, "getter", cb, prop.data))
      .transpose()?;
    let setter = prop
      .setter
      .map(|cb| make_v8_function(scope, env_ptr, "setter", cb, prop.data))
      .transpose()?;
    let mut desc = match (getter, setter) {
      (Some(g), Some(s)) => v8::PropertyDescriptor::new_from_get_set(g.into(), s.into()),
      (Some(g), None) => v8::PropertyDescriptor::new_from_get_set(g.into(), v8::undefined(scope).into()),
      (None, Some(s)) => v8::PropertyDescriptor::new_from_get_set(v8::undefined(scope).into(), s.into()),
      (None, None) => unreachable!(),
    };
    desc.set_enumerable(enumerable);
    desc.set_configurable(configurable);
    let ok = run_with_try_catch(scope, inner, |tc| obj.define_property(tc, key_name, &desc))?;
    if !ok {
      return Err(NAPI_GENERIC_FAILURE);
    }
  } else if let Some(method_cb) = prop.method {
    let name_str = key_name.to_rust_string_lossy(scope);
    let func = make_v8_function(scope, env_ptr, &name_str, method_cb, prop.data)?;
    let mut desc = v8::PropertyDescriptor::new_from_value_writable(func.into(), writable);
    desc.set_enumerable(enumerable);
    desc.set_configurable(configurable);
    let ok = run_with_try_catch(scope, inner, |tc| obj.define_property(tc, key_name, &desc))?;
    if !ok {
      return Err(NAPI_GENERIC_FAILURE);
    }
  } else {
    let val = if prop.value.is_null() {
      v8::undefined(scope).into()
    } else {
      unsafe { from_napi_value(prop.value)? }
    };
    let mut desc = v8::PropertyDescriptor::new_from_value_writable(val, writable);
    desc.set_enumerable(enumerable);
    desc.set_configurable(configurable);
    let ok = run_with_try_catch(scope, inner, |tc| obj.define_property(tc, key_name, &desc))?;
    if !ok {
      return Err(NAPI_GENERIC_FAILURE);
    }
  }
  Ok(())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_define_properties(
  env: NapiEnv,
  object: NapiValue,
  property_count: usize,
  properties: *const NapiPropertyDescriptor,
) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      if property_count == 0 {
        return Ok(());
      }
      if properties.is_null() {
        return Err(NAPI_INVALID_ARG);
      }
      let slice = std::slice::from_raw_parts(properties, property_count);
      for prop in slice {
        define_property_on_object(scope, inner, env, obj, prop)?;
      }
      Ok(())
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_object_freeze(env: NapiEnv, object: NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let ok = run_with_try_catch(scope, inner, |tc| {
        obj.set_integrity_level(tc, v8::IntegrityLevel::Frozen)
      })?;
      if ok { Ok(()) } else { Err(NAPI_GENERIC_FAILURE) }
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_object_seal(env: NapiEnv, object: NapiValue) -> NapiStatus {
  unsafe {
    with_env(env, |inner, scope| {
      let obj = from_napi_object(scope, object)?;
      let ok = run_with_try_catch(scope, inner, |tc| {
        obj.set_integrity_level(tc, v8::IntegrityLevel::Sealed)
      })?;
      if ok { Ok(()) } else { Err(NAPI_GENERIC_FAILURE) }
    })
  }
}
