//! MAL regressions run in disposable processes with hard deadlines.
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn fixture(name: &str) {
  let mut child = Command::new(env!("CARGO_BIN_EXE_jse"))
    .args(["run", "--allow-all", &format!("tests/fixtures/{name}")])
    .current_dir(env!("CARGO_MANIFEST_DIR"))
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
  let deadline = Instant::now() + Duration::from_secs(30);
  loop {
    if child.try_wait().unwrap().is_some() {
      break;
    }
    if Instant::now() >= deadline {
      let _ = child.kill();
      let output = child.wait_with_output().unwrap();
      panic!("{name} timed out: {}", String::from_utf8_lossy(&output.stderr));
    }
    std::thread::sleep(Duration::from_millis(10));
  }
  let output = child.wait_with_output().unwrap();
  assert!(
    output.status.success(),
    "{name}: {}\n{}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
}

#[test]
fn mal_001_async_context() {
  fixture("remediation_async.mjs");
}

#[test]
fn mal_008_trace_context() {
  fixture("remediation_trace.mjs");
}

#[test]
fn mal_005_tls_contract() {
  fixture("remediation_tls.mjs");
}

#[test]
fn mal_009_queue_leases() {
  fixture("remediation_queue.mjs");
}

#[test]
fn mal_002_pool_lifecycle() {
  fixture("remediation_pool.mjs");
}

#[test]
fn mal_006_external_http_client() {
  let output = Command::new("node")
    .args(["tests/fixtures/remediation_http_wire.mjs", env!("CARGO_BIN_EXE_jse")])
    .current_dir(env!("CARGO_MANIFEST_DIR"))
    .output()
    .expect("Node reference required");
  assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn mal_005_external_tls_peer() {
  let output = Command::new("node")
    .args(["tests/fixtures/remediation_tls_wire.mjs", env!("CARGO_BIN_EXE_jse")])
    .current_dir(env!("CARGO_MANIFEST_DIR"))
    .output()
    .expect("Node reference required");
  assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn mal_011_012_truthful_contracts() {
  fixture("remediation_contracts.mjs");
}
