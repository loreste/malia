// TypeScript -> JavaScript transpilation (transpile-only, no typecheck).
//
// Transpiles are cached on disk (see src/cache.rs) keyed by a hash of
// version+source: SWC costs milliseconds even for small files, which would
// otherwise dominate startup time on every run.
use deno_ast::MediaType;
use deno_ast::ParseParams;
use deno_ast::SourceMapOption;
use deno_core::ModuleSpecifier;
use deno_error::JsErrorBox;

/// Transpile TS/JSX/TSX source to JavaScript, consulting the disk cache.
/// Returns (js_code, source_map).
pub fn transpile(
  specifier: &ModuleSpecifier,
  media_type: MediaType,
  code: String,
) -> Result<(String, Vec<u8>), JsErrorBox> {
  let key = format!("{:016x}", crate::cache::stable_hash(&code));
  if let Some(hit) = cache_read(&key) {
    return Ok(hit);
  }
  let result = transpile_uncached(specifier, media_type, &code)?;
  if let Some(dir) = crate::cache::cache_dir("ts") {
    crate::cache::write(&dir, &format!("{key}.js"), result.0.as_bytes());
    crate::cache::write(&dir, &format!("{key}.map"), &result.1);
  }
  Ok(result)
}

fn cache_read(key: &str) -> Option<(String, Vec<u8>)> {
  let dir = crate::cache::cache_dir("ts")?;
  let js = crate::cache::read(&dir, &format!("{key}.js"))?;
  let map = crate::cache::read(&dir, &format!("{key}.map"))?;
  Some((String::from_utf8(js).ok()?, map))
}

fn transpile_uncached(
  specifier: &ModuleSpecifier,
  media_type: MediaType,
  code: &str,
) -> Result<(String, Vec<u8>), JsErrorBox> {
  let parsed = deno_ast::parse_module(ParseParams {
    specifier: specifier.clone(),
    text: code.into(),
    media_type,
    capture_tokens: false,
    scope_analysis: false,
    maybe_syntax: None,
  })
  .map_err(JsErrorBox::from_err)?;
  let res = parsed
    .transpile(
      &deno_ast::TranspileOptions {
        imports_not_used_as_values: deno_ast::ImportsNotUsedAsValues::Remove,
        decorators: deno_ast::DecoratorsTranspileOption::Ecma,
        ..Default::default()
      },
      &deno_ast::TranspileModuleOptions { module_kind: None },
      &deno_ast::EmitOptions {
        source_map: SourceMapOption::Separate,
        inline_sources: true,
        ..Default::default()
      },
    )
    .map_err(JsErrorBox::from_err)?;
  let res = res.into_source();
  let source_map = res.source_map.unwrap_or_default().into_bytes();
  Ok((res.text, source_map))
}

/// Returns (should_transpile, media_type) for a path.
pub fn should_transpile(media_type: &MediaType) -> bool {
  matches!(
    media_type,
    MediaType::Jsx
      | MediaType::TypeScript
      | MediaType::Mts
      | MediaType::Cts
      | MediaType::Dts
      | MediaType::Dmts
      | MediaType::Dcts
      | MediaType::Tsx
  )
}

/// Parse a file without running it (`--check`): Err holds the syntax error.
pub fn check_syntax(path: &std::path::Path) -> Result<(), String> {
  let code = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
  let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
  let specifier =
    deno_ast::ModuleSpecifier::from_file_path(&absolute).map_err(|_| format!("invalid path: {}", path.display()))?;
  let media_type = MediaType::from_specifier(&specifier);
  deno_ast::parse_program(ParseParams {
    specifier,
    text: code.into(),
    media_type,
    capture_tokens: false,
    scope_analysis: false,
    maybe_syntax: None,
  })
  .map(|_| ())
  .map_err(|e| e.to_string())
}
