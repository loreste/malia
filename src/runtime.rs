// JsRuntime bootstrap and top-level run/bench/repl drivers.
use std::rc::Rc;

use anyhow::Context;
use deno_core::JsRuntime;
use deno_core::ModuleSpecifier;
use deno_core::PollEventLoopOptions;
use deno_core::RuntimeOptions;
use deno_core::resolve_path;
use deno_core::v8;

use crate::loader::JseModuleLoader;
use crate::ops::WorkerHost;

/// Create a JsRuntime with the jse extension and module loader installed.
/// `worker_host` is `Some(..)` when this runtime is a worker child.
///
/// The extension JS bootstrap ships pre-compiled in a V8 startup snapshot
/// built by build.rs; the extension itself is registered lazily (ops only,
/// no esm re-execution) and its per-runtime options are applied through
/// `lazy_init_extensions`.
pub fn create_runtime(worker_host: Option<WorkerHost>) -> JsRuntime {
  let mut rt = JsRuntime::new(RuntimeOptions {
    module_loader: Some(Rc::new(JseModuleLoader::new())),
    extensions: vec![crate::ops::jse::lazy_init()],
    startup_snapshot: Some(crate::snapshot::STARTUP_SNAPSHOT),
    ..Default::default()
  });
  rt.lazy_init_extensions(vec![crate::ops::jse::args(worker_host)])
    .expect("jse extension lazy init");
  let _ = rt.execute_script(
    "<jse:wasm_streaming>",
    r#"
      if (typeof WebAssembly !== "undefined") {
        WebAssembly.compileStreaming = async function (source) {
          const response = await Promise.resolve(source);
          const bytes = await response.arrayBuffer();
          return WebAssembly.compile(bytes);
        };
        WebAssembly.instantiateStreaming = async function (source, importObject) {
          const response = await Promise.resolve(source);
          const bytes = await response.arrayBuffer();
          return WebAssembly.instantiate(bytes, importObject);
        };
      }
    "#,
  );
  rt
}

/// Helper to resolve a path that might be a file (possibly missing extension) or a directory.
pub fn resolve_target_path(path: &std::path::Path) -> Option<std::path::PathBuf> {
  if path.is_file() {
    return Some(path.to_path_buf());
  }

  // Missing extensions: foo -> foo.ts, foo.js, etc.
  for ext in &["ts", "js", "mjs", "cjs", "tsx", "jsx", "json"] {
    let cand = path.with_extension(ext);
    if cand.is_file() {
      return Some(cand);
    }
  }

  if path.is_dir() {
    // 1. package.json "main" or "module"
    let pkg_path = path.join("package.json");
    if pkg_path.is_file()
      && let Ok(text) = std::fs::read_to_string(&pkg_path)
      && let Ok(val) = serde_json::from_str::<serde_json::Value>(&text)
      && let Some(entry_str) = val.get("module").or_else(|| val.get("main")).and_then(|m| m.as_str())
    {
      let target = path.join(entry_str);
      if target.is_file() {
        return Some(target);
      }
      for ext in &["js", "mjs", "cjs", "ts", "tsx", "jsx", "json"] {
        let cand = target.with_extension(ext);
        if cand.is_file() {
          return Some(cand);
        }
      }
      let index_cand = target.join("index.js");
      if index_cand.is_file() {
        return Some(index_cand);
      }
    }

    // 2. jse.json or jse.toml
    if let Some((_, cfg)) = crate::config::JseConfig::discover(path)
      && let Some(entry) = cfg.resolve_entry(path)
    {
      return Some(entry);
    }

    // 3. Conventional directory entry files
    for name in &[
      "index.js",
      "index.mjs",
      "index.cjs",
      "index.ts",
      "index.tsx",
      "app.js",
      "app.mjs",
      "app.cjs",
      "app.ts",
      "server.js",
      "server.mjs",
      "server.cjs",
      "server.ts",
      "main.js",
      "main.mjs",
      "main.cjs",
      "main.ts",
    ] {
      let cand = path.join(name);
      if cand.is_file() {
        return Some(cand);
      }
    }
  }

  None
}

/// Resolve a user-supplied file argument (path or file:// URL) to a module
/// specifier, relative to `base_dir` when relative.
pub fn resolve_main_specifier(
  file: &str,
  base_dir: &std::path::Path,
) -> anyhow::Result<ModuleSpecifier> {
  if file.starts_with("file:") {
    let url = ModuleSpecifier::parse(file)?;
    if let Ok(p) = url.to_file_path()
      && let Some(resolved) = resolve_target_path(&p)
    {
      return ModuleSpecifier::from_file_path(resolved)
        .map_err(|_| anyhow::anyhow!("invalid path from file URL"));
    }
    return Ok(url);
  }

  let raw_path = if std::path::Path::new(file).is_absolute() {
    std::path::PathBuf::from(file)
  } else {
    base_dir.join(file)
  };

  if let Some(resolved) = resolve_target_path(&raw_path) {
    return ModuleSpecifier::from_file_path(resolved)
      .map_err(|_| anyhow::anyhow!("invalid path"));
  }

  Ok(resolve_path(file, base_dir)?)
}

use std::sync::{LazyLock, RwLock};

pub static PRELOAD_MODULES: LazyLock<RwLock<Vec<String>>> =
  LazyLock::new(|| RwLock::new(Vec::new()));

pub fn add_preload_module(mod_name: String) {
  if let Ok(mut list) = PRELOAD_MODULES.write() {
    list.push(mod_name);
  }
}

pub fn clear_preload_modules() {
  if let Ok(mut list) = PRELOAD_MODULES.write() {
    list.clear();
  }
}

/// Load and evaluate a main ES module, then drive the event loop to
/// completion. Shuts down any remaining workers afterwards.
pub async fn run_module(specifier: &ModuleSpecifier) -> anyhow::Result<()> {
  crate::logger::init();
  crate::panic::init();
  let mut rt = create_runtime(None);

  // Execute preloaded modules (--require / -r) if any
  let preloads = PRELOAD_MODULES.read().map(|l| l.clone()).unwrap_or_default();
  if !preloads.is_empty() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    for req in preloads {
      let req_spec = resolve_main_specifier(&req, &cwd)?;
      let p_mod_id = rt.load_side_es_module(&req_spec).await?;
      let evaluate = rt.mod_evaluate(p_mod_id);
      let _ = rt.run_event_loop(PollEventLoopOptions::default()).await;
      evaluate.await?;
    }
  }

  let mod_id = rt.load_main_es_module(specifier).await?;
  let evaluate = rt.mod_evaluate(mod_id);

  #[cfg(unix)]
  let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
  #[cfg(unix)]
  let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).ok();

  let loop_res = async {
    loop {
      #[cfg(unix)]
      {
        tokio::select! {
          biased;
          _ = async {
            match sigterm.as_mut() {
              Some(s) => s.recv().await,
              None => std::future::pending().await,
            }
          } => {
            let has_listener = rt.execute_script(
              "<sigterm_check>",
              "Boolean(globalThis.process && globalThis.process.listenerCount && globalThis.process.listenerCount('SIGTERM') > 0)",
            ).ok().map(|val| {
              deno_core::scope!(scope, &mut rt);
              let local = deno_core::v8::Local::new(scope, val);
              local.is_true()
            }).unwrap_or(false);

            if has_listener {
              let _ = rt.execute_script("<sigterm_emit>", "globalThis.process.emit('SIGTERM');");
            } else {
              std::process::exit(143);
            }
          }
          _ = async {
            match sigint.as_mut() {
              Some(s) => s.recv().await,
              None => std::future::pending().await,
            }
          } => {
            let has_listener = rt.execute_script(
              "<sigint_check>",
              "Boolean(globalThis.process && globalThis.process.listenerCount && globalThis.process.listenerCount('SIGINT') > 0)",
            ).ok().map(|val| {
              deno_core::scope!(scope, &mut rt);
              let local = deno_core::v8::Local::new(scope, val);
              local.is_true()
            }).unwrap_or(false);

            if has_listener {
              let _ = rt.execute_script("<sigint_emit>", "globalThis.process.emit('SIGINT');");
            } else {
              std::process::exit(130);
            }
          }
          res = rt.run_event_loop(PollEventLoopOptions::default()) => {
            return res;
          }
        }
      }
      #[cfg(not(unix))]
      {
        tokio::select! {
          biased;
          _ = tokio::signal::ctrl_c() => {
            let has_listener = rt.execute_script(
              "<sigint_check>",
              "Boolean(globalThis.process && globalThis.process.listenerCount && globalThis.process.listenerCount('SIGINT') > 0)",
            ).ok().map(|val| {
              deno_core::scope!(scope, &mut rt);
              let local = deno_core::v8::Local::new(scope, val);
              local.is_true()
            }).unwrap_or(false);

            if has_listener {
              let _ = rt.execute_script("<sigint_emit>", "globalThis.process.emit('SIGINT');");
            } else {
              std::process::exit(130);
            }
          }
          res = rt.run_event_loop(PollEventLoopOptions::default()) => {
            return res;
          }
        }
      }
    }
  }.await;
  let eval_res = evaluate.await;

  if let Err(e) = eval_res {
    let handled = rt
      .execute_script(
        "<uncaught_check>",
        "Boolean(globalThis.process && globalThis.process.listenerCount && globalThis.process.listenerCount('uncaughtException') > 0)",
      )
      .ok()
      .map(|val| {
        deno_core::scope!(scope, &mut rt);
        let local = deno_core::v8::Local::new(scope, val);
        local.is_true()
      })
      .unwrap_or(false);

    if !handled {
      crate::logger::log(
        crate::logger::LogLevel::Error,
        "runtime",
        &format!("Unhandled exception in {specifier}: {e}"),
      );
      return Err(anyhow::anyhow!("{e}"));
    }
  }

  if let Err(e) = loop_res {
    crate::logger::log(
      crate::logger::LogLevel::Error,
      "runtime",
      &format!("Unhandled event loop error in {specifier}: {e}"),
    );
    return Err(anyhow::anyhow!("{e}"));
  }

  // Node emits beforeExit once the loop is idle, then drains work the
  // handler scheduled. A throw inside the hook must not fail the run.
  let _ = rt.execute_script(
    "<beforeExit>",
    "try { if (globalThis.process && globalThis.process.emit) globalThis.process.emit('beforeExit', globalThis.process.exitCode || 0); } catch (e) { console.error('beforeExit error:', e); }",
  );

  let _ = rt.run_event_loop(PollEventLoopOptions::default()).await;
  crate::ops::shutdown_workers(&mut rt.op_state().borrow_mut());
  Ok(())
}

/// Blocking helper used by the CLI and integration tests.
pub fn run_file_blocking(file: &str) -> anyhow::Result<()> {
  crate::logger::init();
  crate::panic::init();
  let cwd = std::env::current_dir().context("Unable to get current working directory")?;
  let specifier = resolve_main_specifier(file, &cwd)?;
  let tokio_rt = tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()?;
  tokio_rt.block_on(run_module(&specifier))
}

/// Evaluate `code` as an ES module. A missing package.json treats `.js` as
/// CommonJS, so the snippet is written to a temporary `.mjs`.
pub fn run_code_blocking(code: &str) -> anyhow::Result<()> {
  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  let mut path = std::env::temp_dir();
  path.push(format!("jse-eval-{}-{nanos}.mjs", std::process::id()));
  std::fs::write(&path, code).context("unable to write eval module")?;
  let spec = path.to_str().context("eval path is not utf-8")?;
  let result = run_file_blocking(spec);
  let _ = std::fs::remove_file(&path);
  result
}

fn format_value(rt: &mut JsRuntime, value: &v8::Global<v8::Value>) -> String {
  deno_core::scope!(scope, rt);
  let local = v8::Local::new(scope, value);
  // Call the JS-side inspector for a useful rendering.
  let inspect_src = v8::String::new(scope, "__jse.inspect").unwrap();
  let script = v8::Script::compile(scope, inspect_src, None).unwrap();
  let inspect_fn = script.run(scope).unwrap();
  let inspect_fn = v8::Local::<v8::Function>::try_from(inspect_fn).unwrap();
  let undefined = v8::undefined(scope);
  match inspect_fn.call(scope, undefined.into(), &[local]) {
    Some(result) => result.to_rust_string_lossy(scope),
    None => "<error inspecting value>".to_string(),
  }
}

/// Interactive REPL: one line in, evaluated with execute_script; promises
/// are awaited against the event loop.
pub async fn repl() -> anyhow::Result<()> {
  let mut rt = create_runtime(None);
  let mut editor = rustyline::DefaultEditor::new()?;
  println!("jse REPL (V8). Type .exit or Ctrl-D to quit.");
  loop {
    let line = match editor.readline("> ") {
      Ok(line) => line,
      Err(rustyline::error::ReadlineError::Interrupted) => continue,
      Err(rustyline::error::ReadlineError::Eof) => break,
      Err(e) => return Err(e.into()),
    };
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    if trimmed == ".exit" {
      break;
    }
    let _ = editor.add_history_entry(&line);
    // Evaluate; on an `await`-related syntax error, retry wrapped in an
    // async IIFE for top-level-await support.
    let mut value = match rt.execute_script("<repl>", line.clone()) {
      Ok(value) => Some(value),
      Err(e) => {
        if format!("{e}").contains("await") {
          match rt.execute_script("<repl>", format!("(async () => ( {line} ))()")) {
            Ok(value) => Some(value),
            Err(e) => {
              eprintln!("Uncaught {e}");
              None
            }
          }
        } else {
          eprintln!("Uncaught {e}");
          None
        }
      }
    };
    let Some(value) = value.take() else {
      continue;
    };
    // Resolve promises while driving the event loop.
    let resolved = {
      let resolve_fut = rt.resolve(value);
      match rt
        .with_event_loop_promise(resolve_fut, PollEventLoopOptions::default())
        .await
      {
        Ok(v) => v,
        Err(e) => {
          eprintln!("Uncaught (in promise) {e}");
          continue;
        }
      }
    };
    // Drain any work scheduled while resolving.
    let _ = rt.run_event_loop(PollEventLoopOptions::default()).await;
    let rendered = format_value(&mut rt, &resolved);
    let is_undefined = {
      deno_core::scope!(scope, &mut rt);
      v8::Local::new(scope, &resolved).is_undefined()
    };
    if !is_undefined {
      println!("{rendered}");
    }
  }
  crate::ops::shutdown_workers(&mut rt.op_state().borrow_mut());
  Ok(())
}
