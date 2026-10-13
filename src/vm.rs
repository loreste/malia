// node:vm contexts: code runs in a fresh V8 context whose global object starts
// with the sandbox's properties; afterwards, globals the code created or
// changed are copied back onto the sandbox. Like Node, this scopes code; it is
// not a security boundary.
use deno_core::op2;
use deno_core::v8;

fn own_names<'s>(scope: &v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>) -> Vec<v8::Local<'s, v8::Value>> {
  let Some(names) = obj.get_own_property_names(scope, v8::GetPropertyNamesArgs::default()) else {
    return Vec::new();
  };
  (0..names.length()).filter_map(|i| names.get_index(scope, i)).collect()
}

/// Runs `code` with `sandbox` as its global object and returns the completion
/// value. Exceptions (including SyntaxError) are rethrown to the caller.
#[op2]
pub fn op_vm_run_in_context<'s, 'i>(
  scope: &mut v8::PinScope<'s, 'i>,
  code: v8::Local<'s, v8::String>,
  sandbox: v8::Local<'s, v8::Object>,
  #[string] filename: String,
) -> v8::Local<'s, v8::Value> {
  let caller = scope.get_current_context();
  let context = v8::Context::new(scope, Default::default());
  // Same security token as the caller, so objects can flow both ways.
  let token = caller.get_security_token(scope);
  context.set_security_token(token);
  let global = context.global(scope);

  // Builtins of a fresh global are never copied back to the sandbox.
  let baseline: std::collections::HashSet<String> = own_names(scope, global)
    .into_iter()
    .map(|k| k.to_rust_string_lossy(scope))
    .collect();

  for key in own_names(scope, sandbox) {
    if let Some(value) = sandbox.get(scope, key) {
      global.set(scope, key, value);
    }
  }

  let result = {
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let tc, scope);
    let name = v8::String::new(tc, &filename).unwrap_or_else(|| v8::String::empty(tc));
    let origin = v8::ScriptOrigin::new(tc, name.into(), 0, 0, false, 0, None, false, false, false, None);
    let value = v8::Script::compile(tc, code, Some(&origin)).and_then(|script| script.run(tc));
    match value {
      Some(v) => Ok(v),
      None => Err(tc.exception()),
    }
  };

  // Copy back what the code defined or changed, even if it threw part way.
  for key in own_names(scope, global) {
    if baseline.contains(&key.to_rust_string_lossy(scope)) {
      continue;
    }
    if let Some(value) = global.get(scope, key) {
      sandbox.set(scope, key, value);
    }
  }

  match result {
    Ok(v) => v,
    Err(exception) => {
      if let Some(exception) = exception {
        scope.throw_exception(exception);
      }
      v8::undefined(scope).into()
    }
  }
}
