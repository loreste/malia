// CLI commands and flags from the README, run through the real binary in
// scratch project directories.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

const JSE: &str = env!("CARGO_BIN_EXE_jse");

fn scratch(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("jse-cli-{name}-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

fn write(dir: &Path, file: &str, text: &str) {
  let path = dir.join(file);
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(path, text).unwrap();
}

fn jse(dir: &Path, args: &[&str]) -> Output {
  Command::new(JSE).args(args).current_dir(dir).output().unwrap()
}

fn jse_stdin(dir: &Path, args: &[&str], input: &str) -> Output {
  let mut child = Command::new(JSE)
    .args(args)
    .current_dir(dir)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
  child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
  child.wait_with_output().unwrap()
}

fn stdout(out: &Output) -> String {
  String::from_utf8_lossy(&out.stdout).into_owned()
}

fn describe(out: &Output) -> String {
  format!("status {:?}\nstdout: {}\nstderr: {}", out.status.code(), stdout(out), String::from_utf8_lossy(&out.stderr))
}

fn npm_available() -> bool {
  let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
  Command::new(npm).arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Start a long-running command. Once `ready` shows up, apply `change`, wait
/// until `next` shows up, then stop it and return what it printed.
fn run_while_changing(dir: &Path, args: &[&str], ready: &str, change: impl FnOnce(), next: &str) -> String {
  let log = dir.join("run.log");
  let err = dir.join("run.err");
  let mut child = Command::new(JSE)
    .args(args)
    .current_dir(dir)
    .stdout(std::fs::File::create(&log).unwrap())
    .stderr(std::fs::File::create(&err).unwrap())
    .spawn()
    .unwrap();
  let deadline = std::time::Instant::now() + Duration::from_secs(20);
  let mut text = String::new();
  while std::time::Instant::now() < deadline && !text.contains(ready) {
    std::thread::sleep(Duration::from_millis(50));
    text = std::fs::read_to_string(&log).unwrap_or_default();
  }
  change();
  while std::time::Instant::now() < deadline && !text.contains(next) {
    std::thread::sleep(Duration::from_millis(50));
    text = std::fs::read_to_string(&log).unwrap_or_default();
  }
  let _ = child.kill();
  let _ = child.wait();
  let stderr = std::fs::read_to_string(&err).unwrap_or_default();
  if stderr.is_empty() {
    text
  } else {
    format!("{text}\n--- stderr ---\n{stderr}")
  }
}

#[test]
fn repl_and_interactive_support_top_level_await() {
  let dir = scratch("repl");
  let input = "1+1\nconst x = await Promise.resolve(40); x + 2\nx\nawait new Promise(r => setTimeout(() => r('later'), 10))\n";
  for args in [&["repl"][..], &["-i"][..]] {
    let out = jse_stdin(&dir, args, input);
    let text = stdout(&out);
    for expected in ["2", "42", "40", "'later'"] {
      assert!(text.lines().any(|l| l.trim() == expected), "{args:?} missing {expected}: {}", describe(&out));
    }
  }
}

#[test]
fn check_flag_parses_without_running() {
  let dir = scratch("check");
  write(&dir, "ok.ts", "const n: number = 1; console.log('SHOULD_NOT_RUN', n);");
  write(&dir, "bad.js", "const = ;");
  let ok = jse(&dir, &["--check", "ok.ts"]);
  assert!(ok.status.success() && !stdout(&ok).contains("SHOULD_NOT_RUN"), "{}", describe(&ok));
  let bad = jse(&dir, &["-c", "bad.js"]);
  assert_eq!(bad.status.code(), Some(1), "{}", describe(&bad));
  assert!(String::from_utf8_lossy(&bad.stderr).contains("SyntaxError"));
}

#[test]
fn bench_reports_wall_clock_time() {
  let dir = scratch("bench");
  write(&dir, "b.js", "let s = 0; for (let i = 0; i < 1e5; i++) s += i;");
  let out = jse(&dir, &["bench", "b.js"]);
  assert!(out.status.success() && stdout(&out).contains("bench: b.js in"), "{}", describe(&out));
}

#[test]
fn project_config_entry_env_scripts_start_and_build() {
  let dir = scratch("config");
  write(
    &dir,
    "malia.json",
    r#"{
  // comments and trailing commas are allowed
  "name": "cli-claims",
  "entry": "src/main.ts",
  "env": { "BASE": "http://x", "API": "${BASE}/v1", "PORT_OR": "${JSE_TEST_UNSET_VAR:-8080}", },
  "permissions": "all",
  "scripts": { "hello": "jse run src/hello.js" },
}"#,
  );
  write(&dir, "src/main.ts", "const api: string = process.env.API!; console.log('ENTRY', api, process.env.PORT_OR);");
  write(&dir, "src/hello.js", "console.log('HELLO_SCRIPT');");

  for args in [&[][..], &["start"][..]] {
    let out = jse(&dir, args);
    assert!(stdout(&out).contains("ENTRY http://x/v1 8080"), "{args:?}: {}", describe(&out));
  }
  let script = jse(&dir, &["hello"]);
  assert!(stdout(&script).contains("HELLO_SCRIPT"), "{}", describe(&script));
  let get = jse(&dir, &["config", "get", "entry"]);
  assert!(stdout(&get).contains("src/main.ts"), "{}", describe(&get));

  let build = jse(&dir, &["build", "-o", "dist/app"]);
  assert!(build.status.success(), "{}", describe(&build));
  let exe = dir.join(if cfg!(windows) { "dist/app.exe" } else { "dist/app" });
  let run = Command::new(&exe).current_dir(&dir).output().unwrap();
  assert!(stdout(&run).contains("ENTRY"), "standalone build: {}", describe(&run));
}

#[test]
fn node_test_runner_reports_tap() {
  let dir = scratch("nodetest");
  write(
    &dir,
    "test.js",
    r#"import { test, describe, it, before } from "node:test";
import assert from "node:assert";
let ready = false;
before(() => { ready = true; });
test("adds", () => assert.equal(1 + 1, 2));
describe("group", () => { it("sees hook", () => assert.ok(ready)); it.skip("later"); });
test("skips itself", (t) => t.skip("not today"));
"#,
  );
  let out = jse(&dir, &["test"]);
  let text = stdout(&out);
  assert!(out.status.success(), "{}", describe(&out));
  for line in ["TAP version 13", "ok 1 - adds", "ok 2 - sees hook", "ok 3 - later # SKIP", "ok 4 - skips itself # SKIP not today", "1..4", "# pass 2", "# fail 0"] {
    assert!(text.contains(line), "missing {line:?}: {text}");
  }

  write(&dir, "test.js", "import { test } from 'node:test'; import assert from 'node:assert'; test('fails', () => assert.equal(1, 2));");
  let failing = jse(&dir, &["test"]);
  assert_eq!(failing.status.code(), Some(1), "{}", describe(&failing));
  assert!(stdout(&failing).contains("not ok 1 - fails"));
}

#[test]
fn watch_and_dev_restart_on_change() {
  let dir = scratch("watch");
  write(&dir, "w.js", "console.log('VERSION_1');");
  let log = run_while_changing(&dir, &["run", "--watch", "w.js"], "VERSION_1", || {
    write(&dir, "w.js", "console.log('VERSION_2');")
  }, "VERSION_2");
  assert!(log.contains("VERSION_1") && log.contains("VERSION_2"), "run --watch: {log}");

  write(&dir, "jse.json", r#"{ "entry": "app.js" }"#);
  write(&dir, "app.js", "console.log('DEV_1');");
  let log = run_while_changing(&dir, &["dev"], "DEV_1", || write(&dir, "app.js", "console.log('DEV_2');"), "DEV_2");
  assert!(log.contains("DEV_1") && log.contains("DEV_2"), "dev: {log}");
}

#[test]
fn allow_env_gates_process_env() {
  let dir = scratch("env");
  let code = "console.log(process.env.PATH === undefined ? 'NO_ENV' : 'HAS_ENV')";
  assert!(stdout(&jse(&dir, &["eval", code])).contains("NO_ENV"));
  assert!(stdout(&jse(&dir, &["eval", "--allow-env", code])).contains("HAS_ENV"));
}

#[test]
fn typescript_module_kinds_mts_and_cts() {
  let dir = scratch("tskinds");
  write(&dir, "a.mts", "export const m: string = 'MTS_OK';");
  write(&dir, "b.cts", "const x: string = 'CTS_OK'; module.exports = { c: x };");
  write(&dir, "main.mts", "import { m } from './a.mts'; import b from './b.cts'; console.log(m, b.c);");
  let out = jse(&dir, &["run", "main.mts"]);
  assert!(stdout(&out).contains("MTS_OK CTS_OK"), "{}", describe(&out));
}

#[test]
fn package_exports_conditions_and_imports() {
  let dir = scratch("exports");
  write(
    &dir,
    "package.json",
    r##"{ "name": "app", "type": "module", "imports": { "#internal": "./src/internal.js" } }"##,
  );
  write(&dir, "src/internal.js", "export const internal = 'IMPORTS_OK';");
  write(
    &dir,
    "node_modules/pkg/package.json",
    r#"{ "name": "pkg", "exports": { ".": { "import": "./esm.mjs", "require": "./cjs.cjs" }, "./feature": "./feature.js", "./sub/*": "./lib/*.js" } }"#,
  );
  write(&dir, "node_modules/pkg/esm.mjs", "export const kind = 'ESM_CONDITION';");
  write(&dir, "node_modules/pkg/cjs.cjs", "exports.kind = 'REQUIRE_CONDITION';");
  write(&dir, "node_modules/pkg/feature.js", "exports.feature = 'SUBPATH_OK';");
  write(&dir, "node_modules/pkg/lib/x.js", "exports.x = 'PATTERN_OK';");
  write(
    &dir,
    "main.js",
    r##"import { createRequire } from "node:module";
import { kind } from "pkg";
import feature from "pkg/feature";
import sub from "pkg/sub/x";
import { internal } from "#internal";
const require = createRequire(import.meta.url);
console.log(kind, require("pkg").kind, feature.feature, sub.x, internal);"##,
  );
  let out = jse(&dir, &["run", "--allow-read", "main.js"]);
  assert!(
    stdout(&out).contains("ESM_CONDITION REQUIRE_CONDITION SUBPATH_OK PATTERN_OK IMPORTS_OK"),
    "{}",
    describe(&out)
  );
}

#[test]
fn transpile_and_code_caches_are_written() {
  let dir = scratch("cache");
  write(&dir, "c.ts", "const n: number = 42; console.log(n);");
  let cache = dir.join("cache");
  for _ in 0..2 {
    let out = Command::new(JSE).args(["run", "c.ts"]).current_dir(&dir).env("JSE_CACHE_DIR", &cache).output().unwrap();
    assert!(stdout(&out).contains("42"), "{}", describe(&out));
  }
  let count = |sub: &str| std::fs::read_dir(cache.join(sub)).map(|d| d.count()).unwrap_or(0);
  assert!(count("ts") > 0, "TypeScript transpile cache is empty");
  assert!(count("v8") > 0, "V8 code cache is empty");
}

#[test]
fn console_time_and_dir() {
  let dir = scratch("console");
  let out = jse(&dir, &["eval", "console.time('t'); console.timeEnd('t'); console.dir({ a: { b: 1 } }, { depth: 0 })"]);
  let text = stdout(&out);
  assert!(text.lines().any(|l| l.starts_with("t: ") && l.ends_with("ms")), "{text}");
  assert!(text.contains("{ a: [Object] }"), "{text}");
}

#[test]
fn npm_and_package_bins_receive_flags_verbatim() {
  let dir = scratch("passthrough");
  // A package binary sees flags such as --version untouched.
  if cfg!(windows) {
    write(&dir, "node_modules/.bin/echo-args.cmd", "@echo ARGS: %*\r\n");
  } else {
    write(&dir, "node_modules/.bin/echo-args", "#!/bin/sh\necho \"ARGS: $*\"\n");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(dir.join("node_modules/.bin/echo-args"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
  }
  let out = jse(&dir, &["x", "echo-args", "--version", "-p"]);
  assert!(stdout(&out).contains("ARGS: --version -p"), "{}", describe(&out));

  if !npm_available() {
    eprintln!("skipping npm checks: npm not installed");
    return;
  }
  let npm = jse(&dir, &["npm", "--version"]);
  assert!(npm.status.success() && stdout(&npm).trim().starts_with(|c: char| c.is_ascii_digit()), "{}", describe(&npm));

  // `add` installs a local package (offline) and records it.
  write(&dir, "package.json", r#"{ "name": "host", "version": "1.0.0" }"#);
  write(&dir, "localpkg/package.json", r#"{ "name": "localpkg", "version": "1.0.0", "main": "index.js" }"#);
  write(&dir, "localpkg/index.js", "module.exports = 'LOCAL_PKG_OK';");
  let add = jse(&dir, &["add", "./localpkg"]);
  assert!(add.status.success(), "{}", describe(&add));
  let manifest = std::fs::read_to_string(dir.join("package.json")).unwrap();
  assert!(manifest.contains("\"localpkg\""), "{manifest}");
  write(&dir, "use.cjs", "console.log(require('localpkg'));");
  let used = jse(&dir, &["run", "--allow-read", "use.cjs"]);
  assert!(stdout(&used).contains("LOCAL_PKG_OK"), "{}", describe(&used));
}

#[test]
fn log_level_and_format_from_env() {
  let dir = scratch("log");
  write(&dir, "l.js", "jse.log.info('HIDDEN_INFO'); jse.log.warn('SHOWN_WARN', 'detail');");
  let out = Command::new(JSE)
    .args(["run", "l.js"])
    .current_dir(&dir)
    .env("JSE_LOG", "warn")
    .env("JSE_LOG_FORMAT", "json")
    .output()
    .unwrap();
  let text = format!("{}{}", stdout(&out), String::from_utf8_lossy(&out.stderr));
  assert!(!text.contains("HIDDEN_INFO"), "{}", describe(&out));
  assert!(text.contains(r#""level":"WARN","target":"SHOWN_WARN","message":"detail""#), "{}", describe(&out));
}
