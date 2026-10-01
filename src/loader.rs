// Module resolution & loading: ESM, TypeScript transpile hook, CommonJS
// wrapping, and npm (node_modules) resolution.
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;

use deno_ast::MediaType;
use deno_core::ModuleLoadOptions;
use deno_core::ModuleLoadReferrer;
use deno_core::ModuleLoadResponse;
use deno_core::ModuleLoader;
use deno_core::ModuleSource;
use deno_core::ModuleSourceCode;
use deno_core::ModuleSpecifier;
use deno_core::ModuleType;
use deno_core::RequestedModuleType;
use deno_core::ResolutionKind;
use deno_core::error::ModuleLoaderError;
use deno_error::JsErrorBox;

/// URL fragment marking the lazy CommonJS variant (see load_inner).
const LAZY_CJS_FRAGMENT: &str = "jse-cjs-lazy";

/// Bare specifiers that map to builtin shims.
const BUILTINS: &[&str] = &[
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "test",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "ws",
  "zlib",
  "sqlite",
];

/// Apply `.` and `..` without touching the filesystem, so one file always
/// maps to one module URL.
fn normalize_lexically(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for component in path.components() {
    match component {
      std::path::Component::CurDir => {}
      std::path::Component::ParentDir => {
        out.pop();
      }
      other => out.push(other),
    }
  }
  out
}

fn builtin_source(spec: &str) -> Option<&'static str> {
  match spec {
    "jse:internal/cjs" => Some(include_str!("js/internal/cjs.js")),
    "jse:internal/cjs-missing" => Some(include_str!("js/internal/cjs-missing.js")),
    "jse:internal/readable_stream" => Some(include_str!("js/internal/readable_stream.js")),
    "node:assert" => Some(include_str!("js/node/assert.js")),
    "node:assert/strict" => Some(include_str!("js/node/assert_strict.js")),
    "node:async_hooks" => Some(include_str!("js/node/async_hooks.js")),
    "node:buffer" => Some(include_str!("js/node/buffer.js")),
    "node:child_process" => Some(include_str!("js/node/child_process.js")),
    "node:cluster" => Some(include_str!("js/node/cluster.js")),
    "node:console" => Some(include_str!("js/node/console.js")),
    "node:constants" => Some(include_str!("js/node/constants.js")),
    "node:crypto" => Some(include_str!("js/node/crypto.js")),
    "node:dgram" => Some(include_str!("js/node/dgram.js")),
    "node:diagnostics_channel" => Some(include_str!("js/node/diagnostics_channel.js")),
    "node:dns" => Some(include_str!("js/node/dns.js")),
    "node:dns/promises" => Some(include_str!("js/node/dns_promises.js")),
    "node:domain" => Some(include_str!("js/node/domain.js")),
    "node:events" => Some(include_str!("js/node/events.js")),
    "node:fs" => Some(include_str!("js/node/fs.js")),
    "node:fs/promises" => Some(include_str!("js/node/fs_promises.js")),
    "node:http" => Some(include_str!("js/node/http.js")),
    "node:http2" => Some(include_str!("js/node/http2.js")),
    "node:https" => Some(include_str!("js/node/https.js")),
    "node:inspector" => Some(include_str!("js/node/inspector.js")),
    "node:module" => Some(include_str!("js/node/module.js")),
    "node:net" => Some(include_str!("js/node/net.js")),
    "node:os" => Some(include_str!("js/node/os.js")),
    "node:path" => Some(include_str!("js/node/path.js")),
    "node:path/posix" => Some(include_str!("js/node/path_posix.js")),
    "node:path/win32" => Some(include_str!("js/node/path_win32.js")),
    "node:perf_hooks" => Some(include_str!("js/node/perf_hooks.js")),
    "node:process" => Some(include_str!("js/node/process.js")),
    "node:punycode" => Some(include_str!("js/node/punycode.js")),
    "node:querystring" => Some(include_str!("js/node/querystring.js")),
    "node:readline" => Some(include_str!("js/node/readline.js")),
    "node:readline/promises" => Some(include_str!("js/node/readline_promises.js")),
    "node:repl" => Some(include_str!("js/node/repl.js")),
    "node:sqlite" => Some(include_str!("js/node/sqlite.js")),
    "node:stream" => Some(include_str!("js/node/stream.js")),
    "node:stream/consumers" => Some(include_str!("js/node/stream_consumers.js")),
    "node:stream/promises" => Some(include_str!("js/node/stream_promises.js")),
    "node:stream/web" => Some(include_str!("js/node/stream_web.js")),
    "node:string_decoder" => Some(include_str!("js/node/string_decoder.js")),
    "node:test" => Some(include_str!("js/node/test.js")),
    "node:timers" => Some(include_str!("js/node/timers.js")),
    "node:timers/promises" => Some(include_str!("js/node/timers_promises.js")),
    "node:tls" => Some(include_str!("js/node/tls.js")),
    "node:tty" => Some(include_str!("js/node/tty.js")),
    "node:url" => Some(include_str!("js/node/url.js")),
    "node:util" => Some(include_str!("js/node/util.js")),
    "node:util/types" => Some(include_str!("js/node/util_types.js")),
    "node:v8" => Some(include_str!("js/node/v8.js")),
    "node:vm" => Some(include_str!("js/node/vm.js")),
    "node:wasi" => Some(include_str!("js/node/wasi.js")),
    "node:worker_threads" => Some(include_str!("js/node/worker_threads.js")),
    "node:ws" => Some(include_str!("js/node/ws.js")),
    "node:zlib" => Some(include_str!("js/node/zlib.js")),
    _ => None,
  }
}

struct PackageJson {
  type_: Option<String>,
  main: Option<String>,
  module: Option<String>,
  exports: Option<serde_json::Value>,
  imports: Option<serde_json::Value>,
}

type SourceMapStore = Rc<RefCell<HashMap<String, Vec<u8>>>>;
type PkgCache = Rc<RefCell<HashMap<PathBuf, Option<Rc<PackageJson>>>>>;
/// Cache for has_esm_syntax results keyed by canonical path.
type EsmCache = Rc<RefCell<HashMap<PathBuf, bool>>>;
/// Directories known to have no config file (jse.json/tsconfig.json/etc).
type ConfigNegCache = Rc<RefCell<std::collections::HashSet<PathBuf>>>;

#[derive(Default)]
pub struct JseModuleLoader {
  source_maps: SourceMapStore,
  pkg_cache: PkgCache,
  esm_cache: EsmCache,
  config_neg_cache: ConfigNegCache,
}

impl JseModuleLoader {
  pub fn new() -> Self {
    Self::default()
  }

  fn cached_has_esm_syntax(&self, path: &Path, code: &str) -> bool {
    if let Some(&result) = self.esm_cache.borrow().get(path) {
      return result;
    }
    let result = has_esm_syntax(code);
    self.esm_cache.borrow_mut().insert(path.to_path_buf(), result);
    result
  }

  fn read_package_json(&self, dir: &Path) -> Option<Rc<PackageJson>> {
    let mut cache = self.pkg_cache.borrow_mut();
    if let Some(entry) = cache.get(dir) {
      return entry.clone();
    }
    let parsed = std::fs::read_to_string(dir.join("package.json"))
      .ok()
      .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
      .map(|v| PackageJson {
        type_: v.get("type").and_then(|t| t.as_str()).map(String::from),
        main: v.get("main").and_then(|t| t.as_str()).map(String::from),
        module: v.get("module").and_then(|t| t.as_str()).map(String::from),
        exports: v.get("exports").cloned(),
        imports: v.get("imports").cloned(),
      })
      .map(Rc::new);
    cache.insert(dir.to_path_buf(), parsed.clone());
    parsed
  }

  /// Nearest package.json walking up from `start` (a directory).
  fn nearest_package_json(&self, start: &Path) -> Option<Rc<PackageJson>> {
    let mut dir = Some(start);
    while let Some(d) = dir {
      if let Some(pkg) = self.read_package_json(d) {
        return Some(pkg);
      }
      dir = d.parent();
    }
    None
  }
}

fn err(msg: impl std::fmt::Display) -> ModuleLoaderError {
  JsErrorBox::generic(msg.to_string())
}

const EXTENSIONS: &[&str] = &["js", "ts", "tsx", "jsx", "mjs", "cjs", "mts", "cts", "json", "wasm"];

/// Resolve a path that may be a file (possibly missing an extension), a
/// TS/JSX file shadowing a `.js`/`.jsx` specifier, or a directory.
fn resolve_file_or_dir(loader: &JseModuleLoader, path: &Path) -> Result<PathBuf, ModuleLoaderError> {
  if path.is_file() {
    return Ok(path.to_path_buf());
  }
  // TS / JSX shadowing: "./foo.js" -> "./foo.ts", "./foo.tsx", etc.
  if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
    let candidates: &[&str] = match ext {
      "js" => &["ts", "tsx", "jsx"],
      "jsx" => &["tsx"],
      "mjs" => &["mts"],
      "cjs" => &["cts"],
      _ => &[],
    };
    for ts_ext in candidates {
      let ts_path = path.with_extension(ts_ext);
      if ts_path.is_file() {
        return Ok(ts_path);
      }
    }
  }
  // Extension search (Node appends: "./util.inspect" -> "./util.inspect.js").
  for ext in EXTENSIONS {
    let candidate = appended_extension(path, ext);
    if candidate.is_file() {
      return Ok(candidate);
    }
  }
  // Directory: package.json "main", then index files.
  if path.is_dir() {
    if let Some(pkg) = loader.read_package_json(path)
      && let Some(main) = &pkg.main
    {
      let main_path = path.join(main);
      if let Ok(resolved) = resolve_file_only(&main_path) {
        return Ok(resolved);
      }
    }
    for name in [
      "index.js",
      "index.ts",
      "index.tsx",
      "index.jsx",
      "index.mjs",
      "index.cjs",
      "index.mts",
      "index.cts",
      "index.json",
    ] {
      let candidate = path.join(name);
      if candidate.is_file() {
        return Ok(candidate);
      }
    }
  }
  Err(err(format!("Cannot find module '{}'", path.display())))
}

/// Look up tsconfig.json / jsconfig.json compilerOptions (paths and baseUrl)
/// to resolve project-level path aliases (e.g. `@/*` -> `./src/*`).
fn resolve_tsconfig_paths(loader: &JseModuleLoader, referrer_dir: &Path, specifier: &str) -> Option<PathBuf> {
  let mut dir = Some(referrer_dir);
  while let Some(d) = dir {
    // Skip directories already known to have no config files.
    if loader.config_neg_cache.borrow().contains(d) {
      dir = d.parent();
      continue;
    }
    let mut found_any_config = false;
    // 1. Check jse.json, jse.toml, jse.config.json
    for config_name in ["jse.json", "jse.toml", "jse.config.json"] {
      let config_path = d.join(config_name);
      if config_path.is_file()
        && let Ok(content) = std::fs::read_to_string(&config_path)
      {
        found_any_config = true;
        let maybe_cfg = if config_name.ends_with(".toml") {
          toml::from_str::<crate::config::JseConfig>(&content).ok()
        } else {
          crate::config::JseConfig::parse_json(&content).ok()
        };

        if let Some(cfg) = maybe_cfg {
          if let Some(paths) = &cfg.paths {
            for (pattern, targets) in paths {
              let targets_vec: Vec<String> = match targets {
                serde_json::Value::String(s) => vec![s.clone()],
                serde_json::Value::Array(arr) => arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
                _ => Vec::new(),
              };

              if let Some(prefix) = pattern.strip_suffix('*') {
                if let Some(rest) = specifier.strip_prefix(prefix) {
                  for target_str in &targets_vec {
                    let mapped = target_str.replace('*', rest);
                    let candidate = d.join(mapped);
                    if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
                      return Some(resolved);
                    }
                  }
                }
              } else if pattern == specifier {
                for target_str in &targets_vec {
                  let candidate = d.join(target_str);
                  if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
                    return Some(resolved);
                  }
                }
              }
            }
          }

          if let Some(alias) = &cfg.alias {
            for (alias_key, target_path) in alias {
              if specifier == alias_key {
                let candidate = d.join(target_path);
                if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
                  return Some(resolved);
                }
              } else if let Some(rest) = specifier.strip_prefix(alias_key) {
                let clean_rest = rest.strip_prefix('/').unwrap_or(rest);
                let candidate = d.join(target_path).join(clean_rest);
                if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
                  return Some(resolved);
                }
              }
            }
          }
        }
      }
    }

    // 2. tsconfig.json / jsconfig.json
    for config_name in ["tsconfig.json", "jsconfig.json"] {
      let config_path = d.join(config_name);
      if config_path.is_file()
        && let Ok(content) = std::fs::read_to_string(&config_path)
        && let Ok(val) = serde_json::from_str::<serde_json::Value>(&content)
      {
        found_any_config = true;
        let opts = val.get("compilerOptions");
        let base_url = opts.and_then(|o| o.get("baseUrl")).and_then(|b| b.as_str());
        let base_dir = match base_url {
          Some(b) => d.join(b),
          None => d.to_path_buf(),
        };

        if let Some(paths) = opts.and_then(|o| o.get("paths")).and_then(|p| p.as_object()) {
          for (pattern, targets) in paths {
            if let Some(targets_arr) = targets.as_array() {
              if let Some(prefix) = pattern.strip_suffix('*') {
                if let Some(rest) = specifier.strip_prefix(prefix) {
                  for target in targets_arr {
                    if let Some(target_str) = target.as_str() {
                      let mapped = target_str.replace('*', rest);
                      let candidate = base_dir.join(mapped);
                      if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
                        return Some(resolved);
                      }
                    }
                  }
                }
              } else if pattern == specifier {
                for target in targets_arr {
                  if let Some(target_str) = target.as_str() {
                    let candidate = base_dir.join(target_str);
                    if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
                      return Some(resolved);
                    }
                  }
                }
              }
            }
          }
        }

        if base_url.is_some() {
          let candidate = base_dir.join(specifier);
          if let Ok(resolved) = resolve_file_or_dir(loader, &candidate) {
            return Some(resolved);
          }
        }
      }
    }
    if !found_any_config {
      loader.config_neg_cache.borrow_mut().insert(d.to_path_buf());
    }
    dir = d.parent();
  }
  None
}

/// Like resolve_file_or_dir but never treats `path` as a directory entry
/// point of its own (used for package.json "main" targets).
fn resolve_file_only(path: &Path) -> Result<PathBuf, ModuleLoaderError> {
  if path.is_file() {
    return Ok(path.to_path_buf());
  }
  for ext in EXTENSIONS {
    let candidate = appended_extension(path, ext);
    if candidate.is_file() {
      return Ok(candidate);
    }
  }
  Err(err(format!("Cannot find module '{}'", path.display())))
}

/// Node-style extension append: "foo" -> "foo.js", "foo.bar" -> "foo.bar.js"
/// (never replaces an existing suffix).
fn appended_extension(path: &Path, ext: &str) -> PathBuf {
  let mut name = path.as_os_str().to_os_string();
  name.push(".");
  name.push(ext);
  PathBuf::from(name)
}

/// Split a bare specifier into (package_name, subpath). The subpath is
/// either "." or "./something".
fn split_package_specifier(spec: &str) -> (String, String) {
  let parts: Vec<&str> = spec.split('/').collect();
  if spec.starts_with('@') && parts.len() >= 2 {
    let name = format!("{}/{}", parts[0], parts[1]);
    let rest = parts[2..].join("/");
    (name, subpath_of(&rest))
  } else {
    let name = parts[0].to_string();
    let rest = parts[1..].join("/");
    (name, subpath_of(&rest))
  }
}

fn subpath_of(rest: &str) -> String {
  if rest.is_empty() {
    ".".to_string()
  } else {
    format!("./{rest}")
  }
}

/// Resolve a target value inside an "exports" tree using Node-style
/// condition resolution.
fn resolve_exports_target(value: &serde_json::Value, is_require: bool) -> Option<String> {
  if let Some(target) = resolve_exports_target_inner(value, is_require, false) {
    return Some(target);
  }
  resolve_exports_target_inner(value, !is_require, true)
}

fn resolve_exports_target_inner(value: &serde_json::Value, is_require: bool, fallback: bool) -> Option<String> {
  match value {
    serde_json::Value::String(s) => Some(s.clone()),
    // Array form: first entry that resolves wins (Node semantics).
    serde_json::Value::Array(items) => {
      for item in items {
        if let Some(target) = resolve_exports_target_inner(item, is_require, fallback) {
          return Some(target);
        }
      }
      None
    }
    serde_json::Value::Object(map) => {
      let is_prod = std::env::var("NODE_ENV").as_deref() == Ok("production");
      for (condition, inner) in map {
        let is_match = match condition.as_str() {
          "node" | "default" => true,
          "import" => !is_require || fallback,
          "require" => is_require || fallback,
          "production" => is_prod,
          "development" => !is_prod,
          _ => false,
        };
        if is_match && let Some(target) = resolve_exports_target_inner(inner, is_require, fallback) {
          return Some(target);
        }
      }
      None
    }
    _ => None,
  }
}

/// Resolve `subpath` (".", "./x", ...) against a package "exports" value.
fn resolve_exports(exports: &serde_json::Value, subpath: &str, is_require: bool) -> Option<String> {
  match exports {
    serde_json::Value::String(_) => {
      if subpath == "." {
        resolve_exports_target(exports, is_require)
      } else {
        None
      }
    }
    serde_json::Value::Object(map) => {
      let is_subpath_map = map.keys().any(|k| k.starts_with('.') || k.starts_with('#'));
      if !is_subpath_map {
        // Conditions object applying to ".".
        return if subpath == "." {
          resolve_exports_target(exports, is_require)
        } else {
          None
        };
      }
      // Exact subpath match.
      if let Some(value) = map.get(subpath)
        && let Some(target) = resolve_exports_target(value, is_require)
      {
        return Some(target);
      }
      // Pattern match ("./prefix*" or "./*").
      for (key, value) in map {
        if let Some(star) = key.find('*') {
          let (prefix, suffix) = (&key[..star], &key[star + 1..]);
          if subpath.starts_with(prefix) && subpath.ends_with(suffix) {
            let matched = &subpath[prefix.len()..subpath.len() - suffix.len()];
            if let Some(target) = resolve_exports_target(value, is_require) {
              return Some(target.replacen('*', matched, 1));
            }
          }
        }
      }
      None
    }
    _ => None,
  }
}

impl ModuleLoader for JseModuleLoader {
  fn resolve(
    &self,
    specifier: &str,
    referrer: &str,
    _kind: ResolutionKind,
  ) -> Result<ModuleSpecifier, ModuleLoaderError> {
    self.resolve_internal(specifier, referrer, false)
  }

  fn load(
    &self,
    module_specifier: &ModuleSpecifier,
    _maybe_referrer: Option<&ModuleLoadReferrer>,
    options: ModuleLoadOptions,
  ) -> ModuleLoadResponse {
    ModuleLoadResponse::Sync(self.load_inner(module_specifier, &options))
  }

  fn get_source_map(&self, specifier: &str) -> Option<Cow<'_, [u8]>> {
    self.source_maps.borrow().get(specifier).map(|v| v.clone().into())
  }

  /// V8 produced a fresh code cache for a module: persist it so the next
  /// run of the same source can skip compilation.
  fn code_cache_ready(
    &self,
    _module_specifier: ModuleSpecifier,
    hash: u64,
    code_cache: &[u8],
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
    let bytes = code_cache.to_vec();
    Box::pin(async move {
      if let Some(dir) = crate::cache::cache_dir("v8") {
        crate::cache::write(&dir, &format!("{hash:016x}.bin"), &bytes);
      }
    })
  }
}

impl JseModuleLoader {
  pub fn resolve_internal(
    &self,
    specifier: &str,
    referrer: &str,
    is_require: bool,
  ) -> Result<ModuleSpecifier, ModuleLoaderError> {
    // Windows absolute paths (C:\x, \\server\share) would otherwise parse
    // as URLs with a one-letter scheme.
    if cfg!(windows) && std::path::Path::new(specifier).is_absolute() {
      let resolved = resolve_file_or_dir(self, &normalize_lexically(std::path::Path::new(specifier)))?;
      return ModuleSpecifier::from_file_path(&resolved)
        .map_err(|_| err(format!("Invalid path '{}'", resolved.display())));
    }

    // Absolute URLs (including node:, jse:, file:) pass through.
    if let Ok(url) = ModuleSpecifier::parse(specifier) {
      match url.scheme() {
        "file" | "node" | "jse" => return Ok(url),
        scheme => {
          return Err(err(format!(
            "Unsupported URL scheme '{scheme}:' in specifier '{specifier}'"
          )));
        }
      }
    }

    // Bare builtin names.
    if BUILTINS.contains(&specifier) {
      return ModuleSpecifier::parse(&format!("node:{specifier}")).map_err(err);
    }

    // Referrer must be a file URL from here on.
    if !referrer.starts_with("file:") {
      return Err(err(format!(
        "Cannot resolve '{specifier}' from non-file referrer '{referrer}'"
      )));
    }
    let referrer_url = ModuleSpecifier::parse(referrer).map_err(err)?;
    let referrer_path = referrer_url
      .to_file_path()
      .map_err(|_| err(format!("Invalid file referrer '{referrer}'")))?;
    let referrer_dir = referrer_path
      .parent()
      .ok_or_else(|| err(format!("Invalid file referrer '{referrer}'")))?;

    // Backslash-relative paths (.\x, ..\x), which the URL join below
    // cannot express.
    if cfg!(windows) && (specifier.starts_with(".\\") || specifier.starts_with("..\\")) {
      let joined = normalize_lexically(&referrer_dir.join(specifier));
      let resolved = resolve_file_or_dir(self, &joined)?;
      return ModuleSpecifier::from_file_path(&resolved)
        .map_err(|_| err(format!("Invalid path '{}'", resolved.display())));
    }

    // Relative or absolute paths.
    if specifier.starts_with("./")
      || specifier.starts_with("../")
      || specifier == "."
      || specifier == ".."
      || specifier.starts_with('/')
    {
      let joined = referrer_url.join(specifier).map_err(err)?;
      let joined_path = joined
        .to_file_path()
        .map_err(|_| err(format!("Cannot resolve '{specifier}'")))?;
      let resolved = resolve_file_or_dir(self, &joined_path)?;
      return ModuleSpecifier::from_file_path(&resolved)
        .map_err(|_| err(format!("Invalid path '{}'", resolved.display())));
    }

    // Package "imports" (#-prefixed specifiers), resolved against the
    // nearest package.json scope that defines them.
    if specifier.starts_with('#') {
      let mut dir = Some(referrer_dir);
      while let Some(d) = dir {
        if let Some(pkg) = self.read_package_json(d)
          && let Some(imports) = &pkg.imports
        {
          if let Some(target) = resolve_exports(imports, specifier, is_require) {
            let target_path = d.join(target);
            let resolved = resolve_file_only(&target_path)?;
            return ModuleSpecifier::from_file_path(&resolved).map_err(|_| err("Invalid path"));
          }
          return Err(err(format!(
            "Package import '{specifier}' is not defined in '{}'",
            d.display()
          )));
        }
        dir = d.parent();
      }
      return Err(err(format!("Cannot resolve package import '{specifier}'")));
    }

    // TSConfig / jsconfig paths and baseUrl alias resolution.
    if let Some(mapped) = resolve_tsconfig_paths(self, referrer_dir, specifier) {
      return ModuleSpecifier::from_file_path(&mapped).map_err(|_| err(format!("Invalid path '{}'", mapped.display())));
    }

    // Bare specifier: node_modules walk-up.
    let (pkg_name, subpath) = split_package_specifier(specifier);
    let mut dir = Some(referrer_dir);
    while let Some(d) = dir {
      let pkg_dir = d.join("node_modules").join(&pkg_name);
      if pkg_dir.is_dir() {
        let pkg = self.read_package_json(&pkg_dir);
        // "exports" field takes precedence when present.
        if let Some(pkg) = &pkg
          && let Some(exports) = &pkg.exports
        {
          if let Some(target) = resolve_exports(exports, &subpath, is_require) {
            let target_path = pkg_dir.join(target);
            if let Ok(resolved) = resolve_file_only(&target_path) {
              return ModuleSpecifier::from_file_path(&resolved).map_err(|_| err("Invalid path"));
            }
          }
          return Err(err(format!(
            "Package subpath '{subpath}' is not defined by \"exports\" in '{specifier}'"
          )));
        }
        let target = if subpath == "." {
          match pkg.and_then(|p| p.module.clone().or_else(|| p.main.clone())) {
            Some(main) => pkg_dir.join(main),
            None => pkg_dir.clone(),
          }
        } else {
          pkg_dir.join(&subpath[2..])
        };
        match resolve_file_or_dir(self, &target) {
          Ok(resolved) => {
            return ModuleSpecifier::from_file_path(&resolved).map_err(|_| err("Invalid path"));
          }
          Err(_) => {
            return Err(err(format!(
              "Cannot find module '{specifier}' (looked in '{}')",
              pkg_dir.display()
            )));
          }
        }
      }
      dir = d.parent();
    }

    // Fallback: check NODE_PATH for global or workspace packages
    if let Ok(node_path) = std::env::var("NODE_PATH") {
      let sep = if cfg!(windows) { ';' } else { ':' };
      for part in node_path.split(sep) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
          continue;
        }
        let base_path = Path::new(trimmed);
        let candidate_dirs = [
          base_path.join(&pkg_name),
          base_path.join("node_modules").join(&pkg_name),
        ];
        for pkg_dir in candidate_dirs {
          if pkg_dir.is_dir() {
            let pkg = self.read_package_json(&pkg_dir);
            if let Some(pkg) = &pkg
              && let Some(exports) = &pkg.exports
            {
              if let Some(target) = resolve_exports(exports, &subpath, is_require) {
                let target_path = pkg_dir.join(target);
                if let Ok(resolved) = resolve_file_only(&target_path) {
                  return ModuleSpecifier::from_file_path(&resolved).map_err(|_| err("Invalid path"));
                }
              }
              return Err(err(format!(
                "Package subpath '{subpath}' is not defined by \"exports\" in '{specifier}'"
              )));
            }

            let target = if subpath == "." {
              match pkg.and_then(|p| p.module.clone().or_else(|| p.main.clone())) {
                Some(main) => pkg_dir.join(main),
                None => pkg_dir.clone(),
              }
            } else {
              pkg_dir.join(&subpath[2..])
            };

            if let Ok(resolved) = resolve_file_or_dir(self, &target) {
              return ModuleSpecifier::from_file_path(&resolved).map_err(|_| err("Invalid path"));
            }
          }
        }
      }
    }

    Err(err(format!("Cannot find package '{specifier}'")))
  }

  fn load_inner(
    &self,
    specifier: &ModuleSpecifier,
    options: &ModuleLoadOptions,
  ) -> Result<ModuleSource, ModuleLoaderError> {
    // Builtin / internal in-memory modules.
    let spec_str = specifier.as_str();
    if let Some(source) = builtin_source(spec_str) {
      return Ok(module_source(
        ModuleType::JavaScript,
        source.to_string(),
        specifier,
        None,
      ));
    }

    // CommonJS required from CommonJS is linked through a lazy variant
    // (URL fragment #jse-cjs-lazy) whose body only runs at require() time.
    let lazy_cjs = specifier.fragment() == Some(LAZY_CJS_FRAGMENT);
    let mut canonical = specifier.clone();
    canonical.set_fragment(None);
    let specifier = &canonical;

    let path = specifier
      .to_file_path()
      .map_err(|_| err(format!("Only file:// URLs are supported, got {spec_str}")))?;

    if path.extension().is_some_and(|extension| extension == "node") {
      return Err(err(
        "ERR_NATIVE_ADDON_UNSUPPORTED: Malia does not implement the Node native addon ABI",
      ));
    }

    // JSON modules requested with `with { type: "json" }`.
    if matches!(options.requested_module_type, RequestedModuleType::Json) {
      let code = std::fs::read_to_string(&path).map_err(err)?;
      // Validate so syntax errors surface here rather than in V8 internals.
      serde_json::from_str::<serde_json::Value>(&code)
        .map_err(|e| err(format!("Invalid JSON in '{}': {e}", path.display())))?;
      return Ok(module_source(ModuleType::Json, code, specifier, None));
    }
    if !matches!(options.requested_module_type, RequestedModuleType::None) {
      return Err(err(format!("Unsupported module type attribute for '{spec_str}'")));
    }

    let media_type = MediaType::from_path(&path);

    if media_type == MediaType::Json {
      let code = std::fs::read_to_string(&path).map_err(err)?;
      serde_json::from_str::<serde_json::Value>(&code)
        .map_err(|e| err(format!("Invalid JSON in '{}': {e}", path.display())))?;
      // Plain (attribute-less) JSON imports get a JS wrapper so they work
      // both as ESM default imports and via CJS require().
      return Ok(module_source(
        ModuleType::JavaScript,
        format!("export default {code};\n"),
        specifier,
        None,
      ));
    }

    if media_type == MediaType::Wasm || path.extension().and_then(|e| e.to_str()) == Some("wasm") {
      let bytes = std::fs::read(&path).map_err(err)?;
      if let Some(bundle) = crate::wasm_compiler::extract_wasm_bundle(&bytes).map_err(err)? {
        crate::optimizer::set_wasm_mode(true);
        return Ok(module_source(ModuleType::JavaScript, bundle.source, specifier, None));
      }
      use base64::Engine;
      let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
      let wrapper = format!(
        concat!(
          "const __b64 = \"{b64}\";\n",
          "const __raw = atob(__b64);\n",
          "const __bytes = new Uint8Array(__raw.length);\n",
          "for (let i = 0; i < __raw.length; i++) __bytes[i] = __raw.charCodeAt(i);\n",
          "const __mod = new WebAssembly.Module(__bytes);\n",
          "let __inst = null;\n",
          "try {{\n",
          "  __inst = new WebAssembly.Instance(__mod);\n",
          "}} catch (_) {{}}\n",
          "export const bytes = __bytes;\n",
          "export const module = __mod;\n",
          "export const instance = __inst;\n",
          "export const exports = __inst ? __inst.exports : {{}};\n",
          "export function instantiate(importObject) {{\n",
          "  return new WebAssembly.Instance(__mod, importObject);\n",
          "}}\n",
          "export default __inst ? __inst.exports : __mod;\n"
        ),
        b64 = b64
      );
      return Ok(module_source(ModuleType::JavaScript, wrapper, specifier, None));
    }

    let (is_cjs, explicit_cjs) = self.cjs_kind(&path, media_type);

    let code = std::fs::read_to_string(&path).map_err(err)?;

    let code = if crate::ts::should_transpile(&media_type) {
      let (js, source_map) = crate::ts::transpile(specifier, media_type, code).map_err(err)?;
      self.source_maps.borrow_mut().insert(specifier.to_string(), source_map);
      js
    } else {
      code
    };

    let is_cjs = is_cjs && (explicit_cjs || !self.cached_has_esm_syntax(&path, &code));

    let code = if is_cjs {
      self.wrap_cjs(specifier, &code, lazy_cjs)?
    } else {
      code
    };

    // Attach a V8 code cache entry (if we have a persisted one from a
    // previous run); V8 falls back to a full compile when it rejects the
    // cached data, and code_cache_ready then stores a fresh cache.
    let code_cache = code_cache_for(&code);
    let requested = if lazy_cjs {
      let mut url = specifier.clone();
      url.set_fragment(Some(LAZY_CJS_FRAGMENT));
      url
    } else {
      specifier.clone()
    };

    Ok(module_source(ModuleType::JavaScript, code, &requested, code_cache))
  }

  /// (is CommonJS, explicitly so): .cjs/.cts always; .js by the nearest
  /// package.json "type" (no package.json means CommonJS, as in Node).
  fn cjs_kind(&self, path: &Path, media_type: MediaType) -> (bool, bool) {
    match media_type {
      MediaType::Cjs | MediaType::Cts => (true, true),
      MediaType::JavaScript => {
        let dir = path.parent().unwrap_or(Path::new("/"));
        match self.nearest_package_json(dir) {
          Some(pkg) => (
            pkg.type_.as_deref() != Some("module"),
            pkg.type_.as_deref() == Some("commonjs"),
          ),
          None => (true, false),
        }
      }
      _ => (false, false),
    }
  }

  /// Whether the module at `url` will be wrapped as CommonJS.
  fn is_cjs_module(&self, url: &ModuleSpecifier) -> bool {
    let Ok(path) = url.to_file_path() else { return false };
    let (is_cjs, explicit) = self.cjs_kind(&path, MediaType::from_path(&path));
    is_cjs && (explicit || std::fs::read_to_string(&path).is_ok_and(|code| !self.cached_has_esm_syntax(&path, &code)))
  }

  fn collect_reexported_named_exports(
    &self,
    specifier: &ModuleSpecifier,
    code: &str,
    depth: usize,
    visited: &mut std::collections::HashSet<String>,
  ) -> Vec<String> {
    if depth > 4 {
      return Vec::new();
    }
    let mut exports = scan_cjs_exports(code);
    let is_passthrough = exports.is_empty()
      || code.contains("Object.keys(")
      || code.contains("__export")
      || code.contains("Object.assign(exports")
      || code.contains("Object.assign(module.exports");

    if is_passthrough {
      let specs = scan_requires(code);
      for spec in specs {
        if let Ok(resolved) = self.resolve_internal(&spec, specifier.as_str(), true) {
          let resolved_str = resolved.to_string();
          if visited.insert(resolved_str)
            && let Ok(file_path) = resolved.to_file_path()
            && let Ok(dep_code) = std::fs::read_to_string(&file_path)
          {
            let dep_exports = self.collect_reexported_named_exports(&resolved, &dep_code, depth + 1, visited);
            for exp in dep_exports {
              if !exports.contains(&exp) {
                exports.push(exp);
              }
            }
          }
        }
      }
    }
    exports
  }

  /// Wrap CommonJS source in an ESM module. Static `require("...")` calls
  /// are hoisted to real ESM imports (resolved through this same loader, so
  /// npm/relative/builtin specifiers all work); the `require` function
  /// becomes a lookup into the hoisted namespace objects.
  /// `lazy`: the variant CommonJS dependents link to; it exports the body
  /// without running it, so require() decides when it executes.
  fn wrap_cjs(&self, specifier: &ModuleSpecifier, code: &str, lazy: bool) -> Result<String, ModuleLoaderError> {
    let code = code.strip_prefix("#!").map_or(code, |rest| {
      // Strip shebang line.
      rest.find('\n').map_or("", |i| &rest[i + 1..])
    });

    let specs = scan_requires(code);
    let mut out = String::with_capacity(code.len() + 1024);
    out.push_str(
      "import { __makeRequire as __jse_mr, __filenameOf as __jse_fo, __dirnameOf as __jse_do, __initCjs as __jse_ic, __namedExport as __jse_ne } from \"jse:internal/cjs\";\n",
    );
    let mut map_entries = String::new();
    let mut url_entries = String::new();
    for (i, spec) in specs.iter().enumerate() {
      // Resolve through the normal pipeline; unresolvable specifiers get a
      // throwing stub so try/catch optional requires keep working.
      let url = match self.resolve_internal(spec, specifier.as_str(), true) {
        Ok(u) => {
          // Requires of unknown builtins (often dead code or comments
          // picked up by the scanner) get the throwing stub too.
          let url = u.to_string();
          if url.starts_with("node:") && builtin_source(&url).is_none() {
            "jse:internal/cjs-missing".to_string()
          } else {
            url
          }
        }
        Err(e) => {
          if std::env::var_os("JSE_DEBUG_MISSING").is_some() {
            eprintln!("[jse] stubbed require '{spec}' from {specifier}: {e}");
          }
          "jse:internal/cjs-missing".to_string()
        }
      };
      // CommonJS dependencies link to their lazy variant; the URL map keeps
      // the plain URL, which keys the shared exports cache.
      let import_url = match ModuleSpecifier::parse(&url) {
        Ok(u) if u.scheme() == "file" && self.is_cjs_module(&u) => format!("{url}#{LAZY_CJS_FRAGMENT}"),
        _ => url.clone(),
      };
      out.push_str(&format!("import * as __jse_m{i} from \"{import_url}\";\n"));
      let key = serde_json::to_string(spec).unwrap_or_else(|_| "\"?\"".into());
      map_entries.push_str(&format!("{key}: __jse_m{i},"));
      url_entries.push_str(&format!("{key}: \"{url}\","));
    }
    out.push_str(&format!(
      "export function __jse_modules() {{ return {{{map_entries}}}; }}\n"
    ));
    out.push_str(&format!(
      "export function __jse_urls() {{ return {{{url_entries}}}; }}\n"
    ));
    out.push_str("export function __jse_body(module, exports, require, __filename, __dirname) {\n");
    out.push_str(code);
    out.push_str("\n}\n");
    if lazy {
      return Ok(out);
    }
    out.push_str("const __jse_exp = __jse_ic(import.meta.url, __jse_body, __jse_modules(), __jse_urls());\n");
    let mut visited = std::collections::HashSet::new();
    visited.insert(specifier.to_string());
    let named_exports = self.collect_reexported_named_exports(specifier, code, 0, &mut visited);
    for (i, name) in named_exports.iter().enumerate() {
      let key = serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""));
      out.push_str(&format!(
        "const __jse_exp_{i} = __jse_ne(__jse_exp, {key});\nexport {{ __jse_exp_{i} as {name} }};\n"
      ));
    }
    out.push_str("export default __jse_exp;\n");
    Ok(out)
  }
}

fn module_source(
  module_type: ModuleType,
  code: String,
  specifier: &ModuleSpecifier,
  code_cache: Option<deno_core::SourceCodeCacheInfo>,
) -> ModuleSource {
  ModuleSource::new(
    module_type,
    ModuleSourceCode::String(code.into()),
    specifier,
    code_cache,
  )
}

/// Look up a persisted V8 code cache for this source. The hash keys our disk
/// entry (content-addressed, so a hit is guaranteed to match the source);
/// `data: None` still asks V8 to produce a fresh cache after compiling.
fn code_cache_for(code: &str) -> Option<deno_core::SourceCodeCacheInfo> {
  let hash = crate::cache::stable_hash(code);
  let data =
    crate::cache::cache_dir("v8").and_then(|dir| crate::cache::read(&dir, format!("{hash:016x}.bin").as_str()));
  Some(deno_core::SourceCodeCacheInfo {
    hash,
    data: data.map(std::borrow::Cow::Owned),
  })
}

/// Scan source for static `require("literal")` calls. False positives
/// (e.g. inside strings or comments) are harmless — they only add an extra
/// hoisted import.
fn scan_requires(code: &str) -> Vec<String> {
  let bytes = code.as_bytes();
  let mut out = Vec::new();
  let mut i = 0;
  while i + 7 < bytes.len() {
    if &bytes[i..i + 7] == b"require" && (i == 0 || !is_ident_char(bytes[i - 1])) && !is_ident_char(bytes[i + 7]) {
      let mut j = i + 7;
      while j < bytes.len() && (bytes[j] as char).is_whitespace() {
        j += 1;
      }
      if j < bytes.len() && bytes[j] == b'(' {
        j += 1;
        while j < bytes.len() && (bytes[j] as char).is_whitespace() {
          j += 1;
        }
        if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
          let quote = bytes[j];
          let start = j + 1;
          let mut k = start;
          while k < bytes.len() && bytes[k] != quote {
            if bytes[k] == b'\\' {
              k += 1; // skip escaped char
            }
            k += 1;
          }
          if k < bytes.len()
            && let Ok(s) = std::str::from_utf8(&bytes[start..k])
            && !s.is_empty()
            && !out.iter().any(|e| e == s)
          {
            out.push(s.to_string());
          }
        }
      }
    }
    i += 1;
  }
  out
}

fn is_ident_char(b: u8) -> bool {
  b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn is_ident_start(b: u8) -> bool {
  b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_statement_start(bytes: &[u8], idx: usize) -> bool {
  let mut k = idx;
  while k > 0 {
    k -= 1;
    let b = bytes[k];
    if b == b'\n' || b == b'\r' || b == b';' || b == b'{' || b == b'}' {
      return true;
    }
    if !b.is_ascii_whitespace() {
      return false;
    }
  }
  true
}

fn is_regex_start(bytes: &[u8], idx: usize) -> bool {
  let mut k = idx;
  while k > 0 {
    k -= 1;
    let b = bytes[k];
    if b.is_ascii_whitespace() {
      continue;
    }
    return matches!(
      b,
      b'('
        | b'['
        | b'='
        | b':'
        | b','
        | b'!'
        | b'&'
        | b'|'
        | b'?'
        | b'~'
        | b'^'
        | b'+'
        | b'-'
        | b'*'
        | b'%'
        | b'<'
        | b'>'
        | b';'
        | b'{'
        | b'}'
    );
  }
  true
}

/// Skip a comment or regex literal starting at `idx`, so their contents
/// (quotes, `exports`, ...) are not scanned as code. Returns false when
/// `idx` does not start one.
fn skip_comment_or_regex(bytes: &[u8], idx: &mut usize) -> bool {
  let len = bytes.len();
  let i = *idx;
  if bytes[i] != b'/' {
    return false;
  }
  if i + 1 < len && bytes[i + 1] == b'/' {
    *idx = i + 2;
    while *idx < len && bytes[*idx] != b'\n' {
      *idx += 1;
    }
    return true;
  }
  if i + 1 < len && bytes[i + 1] == b'*' {
    *idx = i + 2;
    while *idx + 1 < len && !(bytes[*idx] == b'*' && bytes[*idx + 1] == b'/') {
      *idx += 1;
    }
    *idx += 2;
    return true;
  }
  if !is_regex_start(bytes, i) {
    return false;
  }
  *idx = i + 1;
  let mut in_bracket = false;
  while *idx < len {
    match bytes[*idx] {
      b'\\' => {
        *idx += 2;
        continue;
      }
      b'[' => in_bracket = true,
      b']' => in_bracket = false,
      b'/' if !in_bracket => {
        *idx += 1;
        while *idx < len && bytes[*idx].is_ascii_alphabetic() {
          *idx += 1;
        }
        return true;
      }
      b'\n' => return true,
      _ => {}
    }
    *idx += 1;
  }
  true
}

/// Check if JavaScript source code has static top-level ESM syntax (`import ...`, `export ...`).
/// If present, the file must be loaded as an ES module rather than wrapped in CommonJS.
pub fn has_esm_syntax(code: &str) -> bool {
  let bytes = code.as_bytes();
  let len = bytes.len();
  let mut i = 0;
  while i < len {
    let b = bytes[i];
    if skip_comment_or_regex(bytes, &mut i) {
      continue;
    }
    if b == b'\'' || b == b'"' || b == b'`' {
      let quote = b;
      i += 1;
      while i < len && bytes[i] != quote {
        if bytes[i] == b'\\' {
          i += 1;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if is_statement_start(bytes, i) && matches_word(bytes, i, b"import") {
      let mut j = i + 6;
      skip_whitespace(bytes, &mut j);
      if j < len {
        let next = bytes[j];
        if next == b'\'' || next == b'"' || next == b'{' || next == b'*' || is_ident_start(next) {
          return true;
        }
      }
      i = j;
      continue;
    }
    if is_statement_start(bytes, i) && matches_word(bytes, i, b"export") {
      let mut j = i + 6;
      skip_whitespace(bytes, &mut j);
      if j < len {
        let next = bytes[j];
        if next == b'{' || next == b'*' || next == b'=' || is_ident_start(next) {
          return true;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  false
}

fn is_valid_ident(s: &str) -> bool {
  if s.is_empty()
    || s == "default"
    || s == "__jse_module"
    || s == "__jse_body"
    || s == "__jse_modules"
    || s == "__jse_urls"
  {
    return false;
  }
  let mut chars = s.chars();
  let first = chars.next().unwrap();
  if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
    return false;
  }
  chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn skip_whitespace(bytes: &[u8], idx: &mut usize) {
  while *idx < bytes.len() && (bytes[*idx] as char).is_whitespace() {
    *idx += 1;
  }
}

fn matches_word(bytes: &[u8], idx: usize, word: &[u8]) -> bool {
  if idx + word.len() > bytes.len() {
    return false;
  }
  if idx > 0 && is_ident_char(bytes[idx - 1]) {
    return false;
  }
  if &bytes[idx..idx + word.len()] != word {
    return false;
  }
  if idx + word.len() < bytes.len() && is_ident_char(bytes[idx + word.len()]) {
    return false;
  }
  true
}

fn read_ident<'a>(bytes: &'a [u8], idx: &mut usize) -> Option<&'a str> {
  skip_whitespace(bytes, idx);
  if *idx >= bytes.len() {
    return None;
  }
  let start = *idx;
  let first = bytes[start];
  if !(first.is_ascii_alphabetic() || first == b'_' || first == b'$') {
    return None;
  }
  *idx += 1;
  while *idx < bytes.len() && is_ident_char(bytes[*idx]) {
    *idx += 1;
  }
  std::str::from_utf8(&bytes[start..*idx]).ok()
}

fn read_string_literal<'a>(bytes: &'a [u8], idx: &mut usize) -> Option<&'a str> {
  skip_whitespace(bytes, idx);
  if *idx >= bytes.len() {
    return None;
  }
  let quote = bytes[*idx];
  if quote != b'"' && quote != b'\'' {
    return None;
  }
  *idx += 1;
  let start = *idx;
  while *idx < bytes.len() && bytes[*idx] != quote {
    if bytes[*idx] == b'\\' {
      *idx += 1;
    }
    *idx += 1;
  }
  if *idx < bytes.len() {
    let s = std::str::from_utf8(&bytes[start..*idx]).ok();
    *idx += 1; // skip closing quote
    s
  } else {
    None
  }
}

fn skip_to_next_property(bytes: &[u8], idx: &mut usize) {
  let len = bytes.len();
  let mut p_depth = 0;
  let mut b_depth = 0;
  let mut bracket_depth = 0;

  while *idx < len {
    let b = bytes[*idx];
    if skip_comment_or_regex(bytes, idx) {
      continue;
    }
    if b == b'\'' || b == b'"' || b == b'`' {
      let quote = b;
      *idx += 1;
      while *idx < len && bytes[*idx] != quote {
        if bytes[*idx] == b'\\' {
          *idx += 1;
        }
        *idx += 1;
      }
      *idx += 1;
      continue;
    }

    if b == b'(' {
      p_depth += 1;
    } else if b == b')' {
      if p_depth > 0 {
        p_depth -= 1;
      }
    } else if b == b'{' {
      b_depth += 1;
    } else if b == b'}' {
      if b_depth > 0 {
        b_depth -= 1;
      } else {
        break;
      }
    } else if b == b'[' {
      bracket_depth += 1;
    } else if b == b']' {
      if bracket_depth > 0 {
        bracket_depth -= 1;
      }
    } else if b == b',' && p_depth == 0 && b_depth == 0 && bracket_depth == 0 {
      *idx += 1;
      break;
    }
    *idx += 1;
  }
}

fn scan_object_literal(bytes: &[u8], idx: &mut usize, exports: &mut Vec<String>) {
  let len = bytes.len();
  if *idx >= len || bytes[*idx] != b'{' {
    return;
  }
  *idx += 1; // skip '{'
  let mut depth = 1;

  while *idx < len && depth > 0 {
    let b = bytes[*idx];

    if skip_comment_or_regex(bytes, idx) {
      continue;
    }
    if b == b'\'' || b == b'"' || b == b'`' {
      let quote = b;
      *idx += 1;
      while *idx < len && bytes[*idx] != quote {
        if bytes[*idx] == b'\\' {
          *idx += 1;
        }
        *idx += 1;
      }
      *idx += 1;
      continue;
    }

    if b == b'{' {
      depth += 1;
      *idx += 1;
      continue;
    }
    if b == b'}' {
      depth -= 1;
      *idx += 1;
      continue;
    }

    if depth == 1 {
      skip_whitespace(bytes, idx);
      if *idx >= len || bytes[*idx] == b'}' {
        continue;
      }
      let key = if bytes[*idx] == b'"' || bytes[*idx] == b'\'' {
        read_string_literal(bytes, idx)
      } else {
        read_ident(bytes, idx)
      };

      if let Some(name) = key {
        if name != "get" && name != "set" && name != "async" {
          if is_valid_ident(name) && !exports.iter().any(|e| e == name) {
            exports.push(name.to_string());
          }
        } else {
          skip_whitespace(bytes, idx);
          if let Some(real_name) = read_ident(bytes, idx)
            && is_valid_ident(real_name)
            && !exports.iter().any(|e| e == real_name)
          {
            exports.push(real_name.to_string());
          }
        }
        skip_to_next_property(bytes, idx);
        continue;
      }
    }

    *idx += 1;
  }
}

/// Scan CommonJS source for static named exports.
/// Detects `exports.foo =`, `module.exports.bar =`, `exports['foo'] =`,
/// `module.exports = { a, b: 1, c() {} }`, and `Object.defineProperty(exports, "foo", ...)`.
pub fn scan_cjs_exports(code: &str) -> Vec<String> {
  let bytes = code.as_bytes();
  let len = bytes.len();
  let mut exports = Vec::new();
  let mut i = 0;

  let push_export = |name: &str, exports: &mut Vec<String>| {
    if is_valid_ident(name) && !exports.iter().any(|e| e == name) {
      exports.push(name.to_string());
    }
  };

  while i < len {
    let b = bytes[i];

    if skip_comment_or_regex(bytes, &mut i) {
      continue;
    }

    if b == b'\'' || b == b'"' || b == b'`' {
      let quote = b;
      i += 1;
      while i < len && bytes[i] != quote {
        if bytes[i] == b'\\' {
          i += 1;
        }
        i += 1;
      }
      i += 1;
      continue;
    }

    if matches_word(bytes, i, b"exports") {
      let mut j = i + 7;
      skip_whitespace(bytes, &mut j);
      if j < len && bytes[j] == b'.' {
        j += 1;
        skip_whitespace(bytes, &mut j);
        if let Some(name) = read_ident(bytes, &mut j) {
          push_export(name, &mut exports);
        }
      } else if j < len && bytes[j] == b'[' {
        j += 1;
        skip_whitespace(bytes, &mut j);
        if let Some(name) = read_string_literal(bytes, &mut j) {
          push_export(name, &mut exports);
        }
      }
      i = j;
      continue;
    }

    if matches_word(bytes, i, b"module") {
      let mut j = i + 6;
      skip_whitespace(bytes, &mut j);
      if j < len && bytes[j] == b'.' {
        j += 1;
        skip_whitespace(bytes, &mut j);
        if matches_word(bytes, j, b"exports") {
          j += 7;
          skip_whitespace(bytes, &mut j);
          if j < len && bytes[j] == b'.' {
            j += 1;
            skip_whitespace(bytes, &mut j);
            if let Some(name) = read_ident(bytes, &mut j) {
              push_export(name, &mut exports);
            }
          } else if j < len && bytes[j] == b'[' {
            j += 1;
            skip_whitespace(bytes, &mut j);
            if let Some(name) = read_string_literal(bytes, &mut j) {
              push_export(name, &mut exports);
            }
          } else if j < len && bytes[j] == b'=' {
            j += 1;
            skip_whitespace(bytes, &mut j);
            if j < len && bytes[j] == b'{' {
              scan_object_literal(bytes, &mut j, &mut exports);
            }
          }
          i = j;
          continue;
        }
      }
    }

    if matches_word(bytes, i, b"defineProperty") {
      let mut j = i + 14;
      skip_whitespace(bytes, &mut j);
      if j < len && bytes[j] == b'(' {
        j += 1;
        skip_whitespace(bytes, &mut j);
        let is_target = if matches_word(bytes, j, b"exports") {
          j += 7;
          true
        } else if matches_word(bytes, j, b"module") {
          j += 6;
          skip_whitespace(bytes, &mut j);
          if j < len && bytes[j] == b'.' {
            j += 1;
            skip_whitespace(bytes, &mut j);
            if matches_word(bytes, j, b"exports") {
              j += 7;
              true
            } else {
              false
            }
          } else {
            false
          }
        } else {
          false
        };

        if is_target {
          skip_whitespace(bytes, &mut j);
          if j < len && bytes[j] == b',' {
            j += 1;
            skip_whitespace(bytes, &mut j);
            if let Some(name) = read_string_literal(bytes, &mut j) {
              push_export(name, &mut exports);
            }
          }
        }
      }
      i = j;
      continue;
    }

    if matches_word(bytes, i, b"__export") {
      let mut j = i + 8;
      skip_whitespace(bytes, &mut j);
      if j < len && bytes[j] == b'(' {
        j += 1;
        skip_whitespace(bytes, &mut j);
        if matches_word(bytes, j, b"exports") {
          j += 7;
          skip_whitespace(bytes, &mut j);
          if j < len && bytes[j] == b',' {
            j += 1;
            skip_whitespace(bytes, &mut j);
            if j < len && bytes[j] == b'{' {
              scan_object_literal(bytes, &mut j, &mut exports);
            }
          }
        }
      }
      i = j;
      continue;
    }

    i += 1;
  }

  exports
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_scan_cjs_exports() {
    let code = r#"
      exports.foo = 1;
      module.exports.bar = 2;
      exports["baz"] = 3;
      module.exports['qux'] = 4;
      Object.defineProperty(exports, "prop1", { value: 10 });
      Object.defineProperty(module.exports, "prop2", { get: () => 20 });
      module.exports = {
        alpha: 1,
        beta,
        gamma() {},
        async delta() {},
        "epsilon": 5,
        "not-valid": 6
      };
      // exports.ignoredLine = 99;
      /* exports.ignoredBlock = 100; */
      const str = "exports.ignoredString = 101";
      const unquoted = v.replace(/\\"/g, '"'); // a quote inside a regex
      exports.afterRegex = 7;
    "#;
    let exports = scan_cjs_exports(code);
    assert_eq!(
      exports,
      vec![
        "foo",
        "bar",
        "baz",
        "qux",
        "prop1",
        "prop2",
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "afterRegex"
      ]
    );
  }
}

/// createRequire(): resolve `specifier` from the file `parent` with require()
/// semantics (node_modules, "exports" require conditions, extensions,
/// index files). Returns a file path, or "node:<name>" for builtins.
#[deno_core::op2]
#[string]
pub fn op_require_resolve(
  #[string] specifier: String,
  #[string] parent: String,
) -> Result<String, deno_error::JsErrorBox> {
  thread_local! {
    static LOADER: JseModuleLoader = JseModuleLoader::new();
  }
  let not_found =
    || deno_error::JsErrorBox::generic(format!("Cannot find module '{specifier}' required from {parent}"));
  let referrer = ModuleSpecifier::from_file_path(&parent).map_err(|_| not_found())?;
  let resolved = LOADER
    .with(|loader| loader.resolve_internal(&specifier, referrer.as_str(), true))
    .map_err(|_| not_found())?;
  if resolved.scheme() == "file" {
    let path = resolved.to_file_path().map_err(|_| not_found())?;
    Ok(path.to_string_lossy().into_owned())
  } else {
    Ok(resolved.to_string())
  }
}
