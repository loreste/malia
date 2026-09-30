// Integration tests: each fixture is a main module run to completion;
// the fixture throws (failing the test) when a check fails.
use std::path::PathBuf;

fn fixture(name: &str) -> String {
  let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  path.push("tests/fixtures");
  path.push(name);
  path.to_string_lossy().into_owned()
}

/// In-process fixtures run with full permissions (permission enforcement
/// itself is tested end-to-end via the CLI binary in permissions_* tests).
fn grant_all() {
  js_engine::permissions::set_permissions(js_engine::permissions::Permissions::allow_all());
}

fn run_fixture(name: &str) {
  grant_all();
  js_engine::runtime::run_file_blocking(&fixture(name))
    .unwrap_or_else(|e| panic!("fixture {name} failed: {e:#}"));
}

#[test]
fn web_compat() {
  run_fixture("web_compat.mjs");
}

#[test]
fn es_features() {
  run_fixture("es_features.js");
}

#[test]
fn ts_execution() {
  run_fixture("ts_main.ts");
}

#[test]
fn ts_adversarial() {
  run_fixture("ts_adversarial.tsx");
}

#[test]
fn ts_tsconfig_paths() {
  run_fixture("tsconfig_test/main.ts");
}

#[test]
fn adversarial_suite() {
  run_fixture("adversarial_suite.js");
}

#[test]
fn compression_adversarial() {
  run_fixture("compression_adversarial.js");
}

#[test]
fn cluster_adversarial() {
  run_fixture("cluster_adversarial.js");
}

#[test]
fn wasm_frameworks_adversarial() {
  run_fixture("wasm_frameworks_adversarial.js");
}

#[test]
fn logging_resilience_adversarial() {
  run_fixture("logging_resilience_adversarial.js");
}

#[test]
fn wasm_continuous_optimizer_adversarial() {
  run_fixture("wasm_continuous_optimizer_adversarial.js");
}

#[test]
fn killer_features_production_adversarial() {
  run_fixture("killer_features_production_adversarial.js");
}

#[test]
fn config_file_system_cli() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let tmp_dir = std::env::temp_dir().join(format!("jse_config_test_{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&tmp_dir);
  std::fs::create_dir_all(&tmp_dir).unwrap();

  // 1. Test jse init
  let init_out = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["init"])
    .output()
    .unwrap();
  assert!(init_out.status.success(), "jse init failed: {}", String::from_utf8_lossy(&init_out.stderr));
  let config_path = tmp_dir.join("jse.json");
  assert!(config_path.exists(), "jse.json must be created");

  // 2. Test jse config show & jse config get
  let cfg_show = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["config", "show"])
    .output()
    .unwrap();
  assert!(cfg_show.status.success());
  let show_stdout = String::from_utf8_lossy(&cfg_show.stdout);
  assert!(show_stdout.contains("my-app") || show_stdout.contains("my-jse-app"), "Config show must include app name: {show_stdout}");

  let cfg_get = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["config", "get", "entry"])
    .output()
    .unwrap();
  assert!(cfg_get.status.success());
  assert_eq!(String::from_utf8_lossy(&cfg_get.stdout).trim(), "src/index.ts");

  // 3. Write customized jse.json with comments, trailing commas, path aliases, env expansion, and custom scripts
  let custom_jse_json = r#"{
    // Application metadata
    "name": "super-easy-app",
    "version": "2.0.0",

    /* Main entry point for our TypeScript app */
    "entry": "src/index.ts",

    // Native path aliases - zero tsconfig.json needed!
    "paths": {
      "@/*": "./src/*",
    },

    // Environment variables with expansion
    "env": {
      "PORT": "4000",
      "API_URL": "http://localhost:${PORT:-3000}/v1",
    },

    // Preset permissions
    "permissions": "all",

    // Custom scripts
    "scripts": {
      "greet": "jse run src/greet.ts",
      "test": "jse run src/test_runner.ts",
    },
  }"#;
  std::fs::write(&config_path, custom_jse_json).unwrap();

  // Create src files
  let src_dir = tmp_dir.join("src");
  std::fs::create_dir_all(&src_dir).unwrap();

  // Helper module in src/utils/math.ts
  let utils_dir = src_dir.join("utils");
  std::fs::create_dir_all(&utils_dir).unwrap();
  std::fs::write(utils_dir.join("math.ts"), "export function add(a: number, b: number): number { return a + b; }").unwrap();

  // Main entry src/index.ts importing via path alias `@/utils/math`
  std::fs::write(
    src_dir.join("index.ts"),
    "import { add } from '@/utils/math';\nconsole.log('INDEX_BOOTSTRAP_OK: ' + add(10, 32) + ' PORT=' + process.env.PORT + ' URL=' + process.env.API_URL);",
  ).unwrap();

  // Custom script src/greet.ts
  std::fs::write(src_dir.join("greet.ts"), "console.log('GREET_OK: hello from custom script!');").unwrap();

  // Test script src/test_runner.ts
  std::fs::write(src_dir.join("test_runner.ts"), "console.log('TEST_RUNNER_OK: all tests passed');").unwrap();

  // 4. Test running bare jse (auto-resolves jse.json, path aliases, comments, and env)
  let run_out = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .output()
    .unwrap();
  assert!(run_out.status.success(), "bare jse run failed: {}", String::from_utf8_lossy(&run_out.stderr));
  let stdout = String::from_utf8_lossy(&run_out.stdout);
  assert!(stdout.contains("INDEX_BOOTSTRAP_OK: 42 PORT=4000 URL=http://localhost:4000/v1"), "Path alias and env expansion must succeed: {stdout}");

  // 5. Test running custom script via `jse greet`
  let greet_out = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["greet"])
    .output()
    .unwrap();
  assert!(greet_out.status.success(), "jse greet failed: {}", String::from_utf8_lossy(&greet_out.stderr));
  assert!(String::from_utf8_lossy(&greet_out.stdout).contains("GREET_OK: hello from custom script!"));

  // 6. Test running test suite via `jse test`
  let test_out = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["test"])
    .output()
    .unwrap();
  assert!(test_out.status.success(), "jse test failed: {}", String::from_utf8_lossy(&test_out.stderr));
  assert!(String::from_utf8_lossy(&test_out.stdout).contains("TEST_RUNNER_OK: all tests passed"));

  // 7. Test TOML format: `jse init --toml --force`
  let toml_init = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["init", "--toml", "--force"])
    .output()
    .unwrap();
  assert!(toml_init.status.success());
  assert!(tmp_dir.join("jse.toml").exists(), "jse.toml must be created");

  // Remove jse.json so jse.toml is loaded
  let _ = std::fs::remove_file(&config_path);
  let toml_get = std::process::Command::new(jse)
    .current_dir(&tmp_dir)
    .args(["config", "get", "name"])
    .output()
    .unwrap();
  let val = String::from_utf8_lossy(&toml_get.stdout).trim().to_string();
  assert!(val == "my-app" || val == "my-jse-app", "Unexpected app name: {val}");

  // Cleanup
  let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn wasm_cli_one_flag() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let tmp_dir = std::env::temp_dir().join(format!("jse_wasm_cli_{}", std::process::id()));
  let _ = std::fs::create_dir_all(&tmp_dir);
  let src_file = tmp_dir.join("test_app.js");
  let wasm_file = tmp_dir.join("test_app.wasm");

  std::fs::write(&src_file, "console.log('CLI_WASM_MAGIC_42');").unwrap();

  // 1. Test compile --wasm
  let compile_out = std::process::Command::new(jse)
    .args(["compile", "--wasm", src_file.to_str().unwrap(), "-o", wasm_file.to_str().unwrap()])
    .output()
    .unwrap();
  assert!(compile_out.status.success(), "jse compile --wasm failed: {}", String::from_utf8_lossy(&compile_out.stderr));
  assert!(wasm_file.exists(), "compiled .wasm file must exist");

  // 2. Test run --wasm <js_file>
  let run_wasm_out = std::process::Command::new(jse)
    .args(["run", "--allow-all", "--wasm", src_file.to_str().unwrap()])
    .output()
    .unwrap();
  let stdout = String::from_utf8_lossy(&run_wasm_out.stdout);
  assert!(run_wasm_out.status.success() && stdout.contains("CLI_WASM_MAGIC_42"), "run --wasm failed: {stdout}");

  // 3. Test running the compiled .wasm file directly: jse run <wasm_file>
  let run_direct_out = std::process::Command::new(jse)
    .args(["run", "--allow-all", wasm_file.to_str().unwrap()])
    .output()
    .unwrap();
  let direct_stdout = String::from_utf8_lossy(&run_direct_out.stdout);
  assert!(run_direct_out.status.success() && direct_stdout.contains("CLI_WASM_MAGIC_42"), "run <file.wasm> failed: {direct_stdout}");

  let _ = std::fs::remove_dir_all(&tmp_dir);
}


#[test]
fn cjs_interop() {
  run_fixture("cjs_main.js");
}

#[test]
fn channels_and_concurrency() {
  run_fixture("chan_main.js");
}

#[test]
fn node_builtins() {
  run_fixture("builtins_main.js");
}

#[test]
fn worker_roundtrip() {
  run_fixture("worker_main.js");
}

#[test]
fn structured_clone_messaging() {
  run_fixture("clone_main.js");
}

#[test]
fn worker_pool() {
  run_fixture("pool_main.js");
}

/// Async fs and zlib stay off the isolate thread, and WorkerPool defaults
/// to os.availableParallelism().
#[test]
fn event_loop_during_io() {
  run_fixture("concurrency_io.js");
}

#[test]
fn node_crypto() {
  run_fixture("crypto_main.js");
}

#[test]
fn node_stream() {
  run_fixture("stream_main.js");
}

#[test]
fn url_globals() {
  run_fixture("url_main.js");
}

#[test]
fn buffer_semantics() {
  run_fixture("buffer_main.js");
}

/// Timer heap semantics; also asserts a cleared far timer does not hold the
/// event loop open (fixture would otherwise take >= 5s).
#[test]
fn timers() {
  let start = std::time::Instant::now();
  run_fixture("timers_main.js");
  assert!(
    start.elapsed() < std::time::Duration::from_secs(3),
    "cleared timer held the event loop open"
  );
}

#[test]
fn http_server_deno_style() {
  run_fixture("serve_main.js");
}

#[test]
fn http_server_node_api() {
  run_fixture("node_http_main.js");
}

#[test]
fn node_child_process() {
  run_fixture("child_process_main.js");
}

/// fetch() against a local HTTP/1.1 server (no external network).
#[test]
fn fetch_http() {
  use std::io::{Read, Write};

  let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
  let port = listener.local_addr().unwrap().port();
  let port_file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/.fetch_port");
  std::fs::write(&port_file, port.to_string()).unwrap();

  std::thread::spawn(move || {
    for stream in listener.incoming() {
      let Ok(mut stream) = stream else { continue };
      let _ = handle_http_connection(&mut stream);
    }

    fn handle_http_connection(stream: &mut std::net::TcpStream) -> std::io::Result<()> {
      // Read headers, then exactly Content-Length body bytes.
      let mut buf = Vec::new();
      let mut byte = [0u8; 1];
      while !buf.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 {
          return Ok(());
        }
        buf.push(byte[0]);
      }
      let head = String::from_utf8_lossy(&buf);
      let content_length = head
        .lines()
        .find_map(|l| {
          let lower = l.to_ascii_lowercase();
          lower
            .strip_prefix("content-length:")
            .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
      let mut body = vec![0u8; content_length];
      stream.read_exact(&mut body)?;

      let request_line = head.lines().next().unwrap_or("");
      let mut parts = request_line.split_whitespace();
      let method = parts.next().unwrap_or("");
      let path = parts.next().unwrap_or("");
      let seen = head
        .lines()
        .find_map(|l| l.strip_prefix("x-test:").or_else(|| l.strip_prefix("X-Test:")))
        .map(|v| v.trim().to_string())
        .unwrap_or_default();

      if path == "/chunks" {
        // Chunked streaming endpoint for the streaming-fetch test.
        let mut out = Vec::new();
        out.extend_from_slice(
          b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
        );
        for piece in [b"aaa" as &[u8], b"bb", b"c"] {
          out.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
          out.extend_from_slice(piece);
          out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        stream.write_all(&out)?;
        return Ok(());
      }
      if path == "/redirect" {
        write!(
          stream,
          "HTTP/1.1 302 Found\r\nlocation: /text\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        )?;
        return Ok(());
      }
      let (status, content_type, payload): (&str, &str, Vec<u8>) = match (method, path) {
        ("GET", "/text") => ("200 OK", "text/plain", b"hello jse".to_vec()),
        ("GET", "/json") => ("200 OK", "application/json", br#"{"answer":42}"#.to_vec()),
        ("GET", "/missing") => ("404 Not Found", "text/plain", b"nope".to_vec()),
        (_, "/echo") => ("200 OK", "text/plain", body),
        _ => ("400 Bad Request", "text/plain", b"bad".to_vec()),
      };
      write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nx-custom: yes\r\nx-seen: {seen}\r\nconnection: close\r\n\r\n",
        payload.len()
      )?;
      stream.write_all(&payload)?;
      Ok(())
    }
  });

  grant_all();
  let result = js_engine::runtime::run_file_blocking(&fixture("fetch_main.js"));
  let _ = std::fs::remove_file(&port_file);
  result.unwrap_or_else(|e| panic!("fetch fixture failed: {e:#}"));
}

/// Full npm interop: requires `npm install` to have run in
/// examples/cjs_demo (lodash, minimist, chalk). Skipped otherwise.
#[test]
fn npm_packages() {
  let mut demo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  demo.push("examples/cjs_demo");
  if !demo.join("node_modules/lodash").is_dir() {
    eprintln!("skipping: examples/cjs_demo/node_modules not installed");
    return;
  }
  grant_all();
  let main = demo.join("main.js").to_string_lossy().into_owned();
  js_engine::runtime::run_file_blocking(&main)
    .unwrap_or_else(|e| panic!("npm demo failed: {e:#}"));
}

/// Permission model, end-to-end through the CLI binary: default deny,
/// explicit flags grant.
#[test]
fn permissions_cli() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

  let run = |args: &[&str]| {
    std::process::Command::new(jse)
      .args(args)
      .current_dir(&root)
      .output()
      .unwrap()
  };

  // Default: fs read denied with the flag named in the message.
  let out = run(&["run", &fixture("perm_read.js")]);
  assert!(!out.status.success());
  let stderr = String::from_utf8_lossy(&out.stderr);
  assert!(
    stderr.contains("PermissionDenied") && stderr.contains("--allow-read"),
    "unexpected stderr: {stderr}"
  );

  // --allow-read grants it.
  let out = run(&["run", "--allow-read", &fixture("perm_read.js")]);
  assert!(
    out.status.success() && String::from_utf8_lossy(&out.stdout).contains("READ OK"),
    "stdout: {} stderr: {}",
    String::from_utf8_lossy(&out.stdout),
    String::from_utf8_lossy(&out.stderr)
  );

  // --allow-read restricted to a different path still denies.
  let out = run(&["run", "--allow-read=/nonexistent-dir", &fixture("perm_read.js")]);
  assert!(!out.status.success());
  assert!(String::from_utf8_lossy(&out.stderr).contains("PermissionDenied"));

  // Default: net denied.
  let out = run(&["run", &fixture("perm_net.js")]);
  assert!(out.status.success());
  let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
  assert!(
    stdout.contains("PermissionDenied") && stdout.contains("--allow-net"),
    "unexpected stdout: {stdout}"
  );

  // --allow-net turns the error into an ordinary connect failure.
  let out = run(&["run", "--allow-net", &fixture("perm_net.js")]);
  assert!(out.status.success());
  let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
  assert!(
    !stdout.contains("PermissionDenied"),
    "unexpected stdout: {stdout}"
  );
}

/// Allowlisted permissions must not be escapable via `..`, dangling
/// symlinks, sqlite paths, a child's PATH, or fetch redirects.
#[cfg(unix)]
#[test]
fn permissions_cannot_be_bypassed() {
  use std::os::unix::fs::PermissionsExt;

  let dir = std::env::temp_dir().join(format!("jse-perm-bypass-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(dir.join("ok")).unwrap();
  std::fs::create_dir_all(dir.join("evil")).unwrap();
  std::os::unix::fs::symlink(dir.join("outside.txt"), dir.join("ok/link")).unwrap();
  let evil_sh = dir.join("evil/sh");
  std::fs::write(&evil_sh, "#!/bin/sh\nexit 0\n").unwrap();
  std::fs::set_permissions(&evil_sh, std::fs::Permissions::from_mode(0o755)).unwrap();

  let ok = dir.join("ok");
  let port = (20000 + std::process::id() % 20000).to_string();
  let out = std::process::Command::new(env!("CARGO_BIN_EXE_jse"))
    .args([
      "run",
      &format!("--allow-read={}", ok.display()),
      &format!("--allow-write={}", ok.display()),
      "--allow-run=sh",
      "--allow-net=0.0.0.0,127.0.0.1",
      &fixture("perm_bypass.mjs"),
      dir.to_str().unwrap(),
      &port,
    ])
    .output()
    .unwrap();
  let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
  let stderr = String::from_utf8_lossy(&out.stderr);
  let result = |probe: &str| {
    stdout
      .lines()
      .find_map(|l| l.strip_prefix(&format!("{probe}: ")))
      .unwrap_or_else(|| panic!("no result for {probe}; stdout: {stdout} stderr: {stderr}"))
      .to_string()
  };

  assert_eq!(result("write-inside"), "ALLOWED");
  assert_eq!(result("run-allowed"), "ALLOWED");
  for probe in ["write-traversal", "write-dangling-symlink", "sqlite-outside", "run-path-override"] {
    assert_eq!(result(probe), "DENIED", "{probe}");
  }
  assert_ne!(result("fetch-redirect"), "ALLOWED");
  assert!(!dir.join("escape.txt").exists() && !dir.join("outside.txt").exists());
  let _ = std::fs::remove_dir_all(&dir);
}

/// Full Express 5 app: routing, query arrays, JSON body parsing, custom
/// middleware, static files, error handler — all responses must match.
/// Requires `npm install` in examples/express_demo (skipped otherwise).
#[test]
fn express_app() {
  let mut demo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  demo.push("examples/express_demo");
  if !demo.join("node_modules/express").is_dir() {
    eprintln!("skipping: examples/express_demo/node_modules not installed");
    return;
  }
  let jse = env!("CARGO_BIN_EXE_jse");
  let app = demo.join("app.js").to_string_lossy().into_owned();
  let out = std::process::Command::new(jse)
    .args(["run", "--allow-all", &app, "--selftest"])
    .current_dir(&demo)
    .output()
    .unwrap();
  let stdout = String::from_utf8_lossy(&out.stdout);
  assert!(
    out.status.success() && stdout.contains("EXPRESS: PASS"),
    "stdout: {stdout} stderr: {}",
    String::from_utf8_lossy(&out.stderr)
  );
}

/// Broader Node surface: fs, net, http(s) client, zlib, dns, crypto, streams,
/// child stdio, worker_threads, and a beforeExit hook that writes a marker.
#[test]
fn node_compat() {
  let marker = std::env::temp_dir().join("jse-node-compat-before-exit");
  let _ = std::fs::remove_file(&marker);
  run_fixture("node_compat_main.js");
  let body = std::fs::read_to_string(&marker).unwrap_or_default();
  let _ = std::fs::remove_file(&marker);
  assert_eq!(body, "ok", "beforeExit did not write the marker");
}

/// `jse eval` runs a snippet as an ES module, including top-level await.
#[test]
fn eval_cli() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let run = |args: &[&str]| {
    std::process::Command::new(jse)
      .args(args)
      .output()
      .unwrap()
  };

  let out = run(&["eval", "--allow-all", "console.log(6*7)"]);
  let stdout = String::from_utf8_lossy(&out.stdout);
  assert!(
    out.status.success() && stdout.contains("42"),
    "stdout: {stdout} stderr: {}",
    String::from_utf8_lossy(&out.stderr)
  );

  let out = run(&[
    "eval",
    "--allow-all",
    "console.log(process.argv.join(' '))",
    "user-arg",
  ]);
  let stdout = String::from_utf8_lossy(&out.stdout);
  assert!(
    out.status.success() && stdout.contains("jse -e user-arg"),
    "stdout: {stdout} stderr: {}",
    String::from_utf8_lossy(&out.stderr)
  );

  let out = run(&[
    "eval",
    "--allow-all",
    "await new Promise((r) => setTimeout(r, 20)); console.log('eval-ok')",
  ]);
  let stdout = String::from_utf8_lossy(&out.stdout);
  assert!(
    out.status.success() && stdout.contains("eval-ok"),
    "stdout: {stdout} stderr: {}",
    String::from_utf8_lossy(&out.stderr)
  );
}

#[test]
fn websocket_roundtrip() {
  run_fixture("websocket_main.js");
}

#[test]
fn npm_compatibility_and_portability() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let tmp_dir = std::env::temp_dir().join(format!("jse_npm_portability_test_{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&tmp_dir);
  std::fs::create_dir_all(&tmp_dir).unwrap();

  // 1. Test NODE_PATH fallback resolution
  let ext_dir = tmp_dir.join("global_node_modules");
  let ext_pkg_dir = ext_dir.join("global-helper");
  std::fs::create_dir_all(&ext_pkg_dir).unwrap();
  std::fs::write(
    ext_pkg_dir.join("package.json"),
    r#"{"name": "global-helper", "type": "module", "main": "index.js"}"#,
  ).unwrap();
  std::fs::write(
    ext_pkg_dir.join("index.js"),
    r#"export const info = "GLOBAL_NODE_PATH_OK";"#,
  ).unwrap();

  let test_script = tmp_dir.join("test_node_path.mjs");
  std::fs::write(
    &test_script,
    r#"import { info } from "global-helper"; console.log(info);"#,
  ).unwrap();

  let out = std::process::Command::new(jse)
    .args(["run", "--allow-all", test_script.to_str().unwrap()])
    .env("NODE_PATH", ext_dir.to_str().unwrap())
    .current_dir(&tmp_dir)
    .output()
    .unwrap();
  assert!(out.status.success(), "NODE_PATH test failed: {}", String::from_utf8_lossy(&out.stderr));
  let stdout = String::from_utf8_lossy(&out.stdout);
  assert!(stdout.contains("GLOBAL_NODE_PATH_OK"), "Must resolve via NODE_PATH: {stdout}");

  // 2. Test package.json "module" field resolution
  let local_nm = tmp_dir.join("node_modules");
  let esm_pkg = local_nm.join("esm-pkg");
  std::fs::create_dir_all(&esm_pkg).unwrap();
  std::fs::write(
    esm_pkg.join("package.json"),
    r#"{"name": "esm-pkg", "type": "module", "module": "esm_entry.mjs"}"#,
  ).unwrap();
  std::fs::write(
    esm_pkg.join("esm_entry.mjs"),
    r#"export function ping() { return "ESM_MODULE_FIELD_OK"; }"#,
  ).unwrap();

  let test_module_script = tmp_dir.join("test_module.mjs");
  std::fs::write(
    &test_module_script,
    r#"import { ping } from "esm-pkg"; console.log(ping());"#,
  ).unwrap();

  let out_module = std::process::Command::new(jse)
    .args(["run", "--allow-all", test_module_script.to_str().unwrap()])
    .current_dir(&tmp_dir)
    .output()
    .unwrap();
  assert!(out_module.status.success(), "module field test failed: {}", String::from_utf8_lossy(&out_module.stderr));
  assert!(String::from_utf8_lossy(&out_module.stdout).contains("ESM_MODULE_FIELD_OK"));

  // 3. Test node_modules/.bin binary execution via `jse x` and `jse <tool>`
  let bin_dir = local_nm.join(".bin");
  std::fs::create_dir_all(&bin_dir).unwrap();
  let mock_bin = bin_dir.join("mock-tool");
  std::fs::write(
    &mock_bin,
    "#!/bin/sh\necho \"MOCK_TOOL_RUN: $1 $2\"\n",
  ).unwrap();

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&mock_bin, std::fs::Permissions::from_mode(0o755));
  }

  // jse x mock-tool foo bar
  let x_out = std::process::Command::new(jse)
    .args(["x", "mock-tool", "foo", "bar"])
    .current_dir(&tmp_dir)
    .output()
    .unwrap();
  assert!(x_out.status.success(), "jse x failed: {}", String::from_utf8_lossy(&x_out.stderr));
  assert!(String::from_utf8_lossy(&x_out.stdout).contains("MOCK_TOOL_RUN: foo bar"));

  // Direct invocation: `jse mock-tool alpha beta`
  let direct_out = std::process::Command::new(jse)
    .args(["mock-tool", "alpha", "beta"])
    .current_dir(&tmp_dir)
    .output()
    .unwrap();
  assert!(direct_out.status.success(), "jse <bin> failed: {}", String::from_utf8_lossy(&direct_out.stderr));
  assert!(String::from_utf8_lossy(&direct_out.stdout).contains("MOCK_TOOL_RUN: alpha beta"));

  // 4. Test npm wrapper package launcher (npm/jse/bin/jse.js) using node
  let npm_launcher = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("npm")
    .join("jse")
    .join("bin")
    .join("jse.js");
  if npm_launcher.exists() {
    let node_out = std::process::Command::new("node")
      .arg(&npm_launcher)
      .args(["eval", "--allow-all", "console.log('NPM_WRAPPER_EXEC_OK: ' + (21 * 2));"])
      .output();
    if let Ok(node_res) = node_out {
      let out_str = String::from_utf8_lossy(&node_res.stdout);
      assert!(out_str.contains("NPM_WRAPPER_EXEC_OK: 42"), "npm wrapper launcher must succeed: {out_str}");
    }
  }

  // Cleanup
  let _ = std::fs::remove_dir_all(&tmp_dir);
}

/// Comprehensive Node.js drop-in compatibility test:
/// Builtin modules (path/posix, path/win32, util/types, stream/web, v8, vm, diagnostics_channel, punycode, domain),
/// global environment, CommonJS require, and WHATWG streams.
#[test]
fn node_dropin_compatibility_builtins() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let fixture_path = root.join("tests").join("fixtures").join("node_full_compatibility.js");

  let out = std::process::Command::new(jse)
    .arg(&fixture_path)
    .current_dir(&root)
    .output()
    .expect("failed to execute node_full_compatibility.js");

  let stdout = String::from_utf8_lossy(&out.stdout);
  let stderr = String::from_utf8_lossy(&out.stderr);
  assert!(
    out.status.success(),
    "node_full_compatibility.js failed: stdout: {stdout}, stderr: {stderr}"
  );
  assert!(
    stdout.contains("NODE COMPATIBILITY: ALL TESTS PASSED"),
    "missing success sentinel in stdout: {stdout}"
  );
}

/// Directory and package.json main/module entry resolution:
/// Running `jse <dir>`, `jse run <dir>`, or `jse .` inside project directory.
#[test]
fn node_directory_and_package_entry_resolution() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let express_demo_dir = root.join("examples").join("express_demo");

  // 1. Run via `jse run --allow-all examples/express_demo --selftest`
  let out_run = std::process::Command::new(jse)
    .args(["run", "--allow-all", "examples/express_demo", "--selftest"])
    .current_dir(&root)
    .output()
    .expect("failed to execute jse run examples/express_demo");
  let stdout_run = String::from_utf8_lossy(&out_run.stdout);
  assert!(
    out_run.status.success() && stdout_run.contains("EXPRESS: PASS"),
    "jse run dir failed: stdout: {stdout_run}, stderr: {}",
    String::from_utf8_lossy(&out_run.stderr)
  );

  // 2. Run via bare `jse examples/express_demo --selftest`
  let out_bare = std::process::Command::new(jse)
    .args(["examples/express_demo", "--selftest"])
    .current_dir(&root)
    .output()
    .expect("failed to execute jse examples/express_demo");
  let stdout_bare = String::from_utf8_lossy(&out_bare.stdout);
  assert!(
    out_bare.status.success() && stdout_bare.contains("EXPRESS: PASS"),
    "jse <dir> failed: stdout: {stdout_bare}, stderr: {}",
    String::from_utf8_lossy(&out_bare.stderr)
  );

  // 3. Run inside the project directory via `jse . --selftest`
  let out_dot = std::process::Command::new(jse)
    .args([".", "--selftest"])
    .current_dir(&express_demo_dir)
    .output()
    .expect("failed to execute jse . in project dir");
  let stdout_dot = String::from_utf8_lossy(&out_dot.stdout);
  assert!(
    out_dot.status.success() && stdout_dot.contains("EXPRESS: PASS"),
    "jse . in dir failed: stdout: {stdout_dot}, stderr: {}",
    String::from_utf8_lossy(&out_dot.stderr)
  );
}

/// Node CLI flags emulation:
/// `-e` (eval), `-p` (print), `-r` (require preload), `--no-warnings`, `--max-old-space-size`.
#[test]
fn node_cli_emulation_flags() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let preload_fixture = root.join("tests").join("fixtures").join("preload_test.js");

  // 1. -e / --eval flag
  let out_eval = std::process::Command::new(jse)
    .args(["-e", "console.log('EVAL_OUTPUT:' + (100 + 23));"])
    .current_dir(&root)
    .output()
    .expect("failed to execute jse -e");
  assert!(out_eval.status.success());
  assert!(String::from_utf8_lossy(&out_eval.stdout).contains("EVAL_OUTPUT:123"));

  // 2. -p / --print flag
  let out_print = std::process::Command::new(jse)
    .args(["-p", "process.release.name"])
    .current_dir(&root)
    .output()
    .expect("failed to execute jse -p");
  assert!(out_print.status.success());
  assert!(String::from_utf8_lossy(&out_print.stdout).contains("node"));

  // 3. -r / --require flag with -e
  let out_req = std::process::Command::new(jse)
    .arg("-r")
    .arg(&preload_fixture)
    .args(["-e", "if (!globalThis.PRELOADED || process.env.TEST_PRELOAD_VAR !== 'preloaded_ok') throw new Error('fail'); console.log('PRELOAD_CLI_OK');"])
    .current_dir(&root)
    .output()
    .expect("failed to execute jse -r");
  let stdout_req = String::from_utf8_lossy(&out_req.stdout);
  assert!(
    out_req.status.success() && stdout_req.contains("PRELOAD_CLI_OK"),
    "jse -r failed: stdout: {stdout_req}, stderr: {}",
    String::from_utf8_lossy(&out_req.stderr)
  );

  // 4. Compatibility flags: --no-warnings and --max-old-space-size
  let out_flags = std::process::Command::new(jse)
    .args(["--no-warnings", "--max-old-space-size=4096", "-e", "console.log('FLAGS_OK');"])
    .current_dir(&root)
    .output()
    .expect("failed to execute with flags");
  assert!(out_flags.status.success());
  assert!(String::from_utf8_lossy(&out_flags.stdout).contains("FLAGS_OK"));

  // 5. -v / --version flag
  let out_version = std::process::Command::new(jse)
    .arg("-v")
    .current_dir(&root)
    .output()
    .expect("failed to execute jse -v");
  assert!(out_version.status.success());
  assert!(String::from_utf8_lossy(&out_version.stdout).contains("jse 0.1.0"));

  // 6. NODE_OPTIONS environment variable
  let out_node_options = std::process::Command::new(jse)
    .env("NODE_OPTIONS", format!("-r {} --no-warnings", preload_fixture.display()))
    .args(["-e", "if (!globalThis.PRELOADED) throw new Error('fail'); console.log('NODE_OPTIONS_OK');"])
    .current_dir(&root)
    .output()
    .expect("failed to execute with NODE_OPTIONS");
  let stdout_no = String::from_utf8_lossy(&out_node_options.stdout);
  assert!(
    out_node_options.status.success() && stdout_no.contains("NODE_OPTIONS_OK"),
    "NODE_OPTIONS failed: stdout: {stdout_no}, stderr: {}",
    String::from_utf8_lossy(&out_node_options.stderr)
  );

  // 7. --import flag
  let out_import = std::process::Command::new(jse)
    .arg("--import")
    .arg(&preload_fixture)
    .args(["-e", "if (!globalThis.PRELOADED) throw new Error('fail'); console.log('IMPORT_FLAG_OK');"])
    .current_dir(&root)
    .output()
    .expect("failed to execute with --import");
  let stdout_imp = String::from_utf8_lossy(&out_import.stdout);
  assert!(
    out_import.status.success() && stdout_imp.contains("IMPORT_FLAG_OK"),
    "--import failed: stdout: {stdout_imp}, stderr: {}",
    String::from_utf8_lossy(&out_import.stderr)
  );
}

#[test]
fn database_compatibility() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let fixture = root.join("tests").join("fixtures").join("database_compatibility.js");

  let out = std::process::Command::new(jse)
    .arg(&fixture)
    .current_dir(&root)
    .output()
    .expect("failed to execute database compatibility fixture");

  let stdout = String::from_utf8_lossy(&out.stdout);
  let stderr = String::from_utf8_lossy(&out.stderr);
  assert!(
    out.status.success() && stdout.contains("ALL DATABASE COMPATIBILITY TESTS PASSED"),
    "database compatibility test failed:\nstdout: {stdout}\nstderr: {stderr}"
  );
}

#[test]
fn container_nosql_microservice() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

  let out = std::process::Command::new(jse)
    .args(["examples/nosql_database_demo", "--selftest"])
    .current_dir(&root)
    .output()
    .expect("failed to execute nosql_database_demo");

  let stdout = String::from_utf8_lossy(&out.stdout);
  let stderr = String::from_utf8_lossy(&out.stderr);
  assert!(
    out.status.success() && stdout.contains("NOSQL_DEMO: ALL CHECKS PASSED"),
    "container_nosql_microservice failed:\nstdout: {stdout}\nstderr: {stderr}"
  );
}

#[test]
fn advanced_enterprise_features() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let fixture = root.join("tests").join("fixtures").join("adv_new_features.js");

  let out = std::process::Command::new(jse)
    .args(["run", "--allow-all", fixture.to_str().unwrap()])
    .current_dir(&root)
    .output()
    .expect("failed to execute advanced features fixture");

  let stdout = String::from_utf8_lossy(&out.stdout);
  let stderr = String::from_utf8_lossy(&out.stderr);
  assert!(
    out.status.success() && stdout.contains("ALL ADVANCED ENTERPRISE TESTS PASSED SUCCESSFULLY"),
    "advanced enterprise features test failed:\nstdout: {stdout}\nstderr: {stderr}"
  );
}

#[test]
fn standalone_compilation() {
  let jse = env!("CARGO_BIN_EXE_jse");
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let ts_fixture = root.join("tests").join("fixtures").join("ts_standalone.ts");
  let out_bin = std::env::temp_dir().join(format!("jse_standalone_test_{}", std::process::id()));

  let compile_out = std::process::Command::new(jse)
    .args(["compile", ts_fixture.to_str().unwrap(), "-o", out_bin.to_str().unwrap()])
    .current_dir(&root)
    .output()
    .expect("failed to compile standalone binary");

  assert!(
    compile_out.status.success(),
    "compile failed: {}",
    String::from_utf8_lossy(&compile_out.stderr)
  );

  let run_out = std::process::Command::new(&out_bin)
    .output()
    .expect("failed to execute standalone compiled binary");

  let _ = std::fs::remove_file(&out_bin);

  let stdout = String::from_utf8_lossy(&run_out.stdout);
  let stderr = String::from_utf8_lossy(&run_out.stderr);
  assert!(
    run_out.status.success() && stdout.contains("TypeScript Ahead-Of-Time Standalone: PASS"),
    "standalone execution failed:\nstdout: {stdout}\nstderr: {stderr}"
  );
}
#[test]
fn malia_dual_binary_and_global_namespace() {
  let malia_bin = env!("CARGO_BIN_EXE_malia");
  let jse_bin = env!("CARGO_BIN_EXE_jse");

  // 1. Version output check
  let malia_ver = std::process::Command::new(malia_bin)
    .arg("--version")
    .output()
    .expect("failed to execute malia --version");
  assert!(malia_ver.status.success());
  assert_eq!(String::from_utf8_lossy(&malia_ver.stdout).trim(), "malia 0.1.0");

  let jse_ver = std::process::Command::new(jse_bin)
    .arg("--version")
    .output()
    .expect("failed to execute jse --version");
  assert!(jse_ver.status.success());
  assert_eq!(String::from_utf8_lossy(&jse_ver.stdout).trim(), "jse 0.1.0");

  // 2. Both globals malia and jse available and identical in malia binary
  let script = r#"
    if (typeof malia !== 'object' || typeof jse !== 'object') throw new Error('globals missing');
    if (malia !== jse) throw new Error('malia and jse must reference same object');
    if (malia.version !== '0.1.0' || jse.version !== '0.1.0') throw new Error('version mismatch');
    if (typeof malia.serve !== 'function' || typeof malia.kv !== 'object' || typeof malia.sql !== 'function') throw new Error('subsystems missing');
    console.log('MALIA_DUAL_GLOBALS_OK');
  "#;

  let malia_eval = std::process::Command::new(malia_bin)
    .args(["-e", script])
    .output()
    .expect("failed to evaluate script via malia");
  assert!(
    malia_eval.status.success() && String::from_utf8_lossy(&malia_eval.stdout).contains("MALIA_DUAL_GLOBALS_OK"),
    "malia eval failed: {}",
    String::from_utf8_lossy(&malia_eval.stderr)
  );

  // 3. Both globals available and identical in jse binary
  let jse_eval = std::process::Command::new(jse_bin)
    .args(["-e", script])
    .output()
    .expect("failed to evaluate script via jse");
  assert!(
    jse_eval.status.success() && String::from_utf8_lossy(&jse_eval.stdout).contains("MALIA_DUAL_GLOBALS_OK"),
    "jse eval failed: {}",
    String::from_utf8_lossy(&jse_eval.stderr)
  );
}

fn run_framework_test(script_name: &str) {
  let malia = env!("CARGO_BIN_EXE_malia");
  let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let frameworks_dir = manifest_dir.join("tests/fixtures/frameworks");

  // If node_modules does not exist in tests/fixtures/frameworks, run npm install
  if !frameworks_dir.join("node_modules").exists() {
    let npm_status = std::process::Command::new("npm")
      .args(["install", "--no-audit", "--no-fund"])
      .current_dir(&frameworks_dir)
      .status();
    match npm_status {
      Ok(st) if !st.success() => {
        eprintln!("npm install in tests/fixtures/frameworks failed, skipping framework test {script_name}");
        return;
      }
      Err(e) => {
        eprintln!("npm command not available ({e}), skipping framework test {script_name}");
        return;
      }
      _ => {}
    }
  }

  let script_path = frameworks_dir.join(script_name);
  let output = std::process::Command::new(malia)
    .args(["run", "--allow-all", script_path.to_str().unwrap()])
    .current_dir(&frameworks_dir)
    .output()
    .unwrap_or_else(|e| panic!("failed to execute {script_name} via malia: {e}"));

  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  assert!(
    output.status.success(),
    "framework test {script_name} failed with exit code {:?}:\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}",
    output.status.code()
  );
}

#[test]
fn framework_react_ssr() {
  run_framework_test("test_react.js");
}

#[test]
fn framework_preact_ssr() {
  run_framework_test("test_preact.js");
}

#[test]
fn framework_vue_ssr() {
  run_framework_test("test_vue.js");
}

#[test]
fn framework_angular_signals_di() {
  run_framework_test("test_angular.js");
}

#[test]
fn framework_svelte_ssr() {
  run_framework_test("test_svelte.js");
}

#[test]
fn framework_fastify_routes() {
  run_framework_test("test_fastify.js");
}
