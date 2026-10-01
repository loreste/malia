// Build script: compile the jse extension bootstrap (src/js/*.js + ops) into
// a V8 startup snapshot consumed by src/snapshot.rs. This recompiles
// deno_core for the build-script target, which roughly doubles a cold build;
// cargo caches it afterwards.
use std::path::PathBuf;

// Stub modules so src/ops.rs compiles inside the build script.
mod worker {
  pub fn spawn_worker_thread(_specifier: String, _host: crate::ops::WorkerHost) -> std::io::Result<()> {
    Ok(())
  }
}

#[allow(dead_code)]
mod logger {
  include!("src/logger.rs");
}

#[allow(dead_code)]
mod permissions {
  include!("src/permissions.rs");
}

#[allow(dead_code)]
mod serve {
  include!("src/serve.rs");
}

#[allow(dead_code)]
mod wasm_compiler {
  pub fn compile_file_to_wasm(_file_path: &std::path::Path) -> Result<Vec<u8>, deno_error::JsErrorBox> {
    Ok(Vec::new())
  }
  pub fn write_u32_leb128(buf: &mut Vec<u8>, mut val: u32) {
    loop {
      let mut byte = (val & 0x7f) as u8;
      val >>= 7;
      if val != 0 {
        byte |= 0x80;
      }
      buf.push(byte);
      if val == 0 {
        break;
      }
    }
  }
  pub fn write_i32_leb128(buf: &mut Vec<u8>, mut val: i32) {
    let mut more = true;
    while more {
      let mut byte = (val & 0x7f) as u8;
      val >>= 7;
      let sign_bit = (byte & 0x40) != 0;
      if (val == 0 && !sign_bit) || (val == -1 && sign_bit) {
        more = false;
      } else {
        byte |= 0x80;
      }
      buf.push(byte);
    }
  }
  pub fn write_section(buf: &mut Vec<u8>, section_id: u8, payload: &[u8]) {
    buf.push(section_id);
    write_u32_leb128(buf, payload.len() as u32);
    buf.extend_from_slice(payload);
  }
  pub fn write_name(buf: &mut Vec<u8>, name: &str) {
    write_u32_leb128(buf, name.len() as u32);
    buf.extend_from_slice(name.as_bytes());
  }
}

#[allow(dead_code)]
mod optimizer {
  include!("src/optimizer.rs");
}

#[allow(dead_code)]
mod kv {
  include!("src/kv.rs");
}

#[allow(dead_code)]
mod router {
  include!("src/router.rs");
}

#[allow(dead_code)]
mod crypto {
  include!("src/crypto.rs");
}
mod platform {
  include!("src/platform.rs");
}
#[allow(dead_code)]
mod production {
  include!("src/production.rs");
}

// The snapshot only needs the op's declaration.
#[allow(dead_code)]
mod loader {
  #[deno_core::op2]
  #[string]
  pub fn op_require_resolve(
    #[string] _specifier: String,
    #[string] _parent: String,
  ) -> Result<String, deno_error::JsErrorBox> {
    Err(deno_error::JsErrorBox::generic("unavailable during snapshot build"))
  }
}

#[allow(dead_code)]
mod sql {
  use deno_core::op2;
  use deno_error::JsErrorBox;
  use std::collections::HashMap;

  #[op2(fast)]
  pub fn op_sql_open(#[string] _path: String) -> Result<u32, JsErrorBox> {
    Ok(1)
  }

  #[op2(fast)]
  pub fn op_sql_close(_id: u32) -> bool {
    true
  }

  #[op2]
  pub fn op_sql_exec(
    _id: u32,
    #[string] _sql: String,
    #[serde] _params: Vec<serde_json::Value>,
  ) -> Result<f64, JsErrorBox> {
    Ok(0.0)
  }

  #[op2(fast)]
  pub fn op_sql_last_insert_rowid(_id: u32) -> Result<f64, JsErrorBox> {
    Ok(0.0)
  }

  #[op2]
  #[serde]
  pub fn op_sql_query(
    _id: u32,
    #[string] _sql: String,
    #[serde] _params: Vec<serde_json::Value>,
  ) -> Result<Vec<HashMap<String, serde_json::Value>>, JsErrorBox> {
    Ok(Vec::new())
  }
}

#[allow(dead_code)]
mod config {
  use std::collections::HashMap;
  use std::sync::{LazyLock, RwLock};
  pub static CONFIG_ENV: LazyLock<RwLock<HashMap<String, String>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
}

#[allow(dead_code)]
mod ops {
  include!("src/ops.rs");
}

fn main() {
  println!("cargo::rerun-if-changed=src/js");
  println!("cargo::rerun-if-changed=src/ops.rs");
  println!("cargo::rerun-if-changed=src/ops_extra.rs");
  println!("cargo::rerun-if-changed=src/serve.rs");
  println!("cargo::rerun-if-changed=src/permissions.rs");
  println!("cargo::rerun-if-changed=src/logger.rs");
  println!("cargo::rerun-if-changed=src/panic.rs");
  println!("cargo::rerun-if-changed=Cargo.lock");

  // Snapshot creation runs outside any tokio runtime, but creating a
  // JsRuntime schedules delayed V8 tasks on one: enter a private runtime.
  let tokio_rt = tokio::runtime::Builder::new_current_thread()
    .enable_time()
    .build()
    .expect("tokio runtime for snapshot build");
  let _guard = tokio_rt.enter();

  let runtime = deno_core::JsRuntimeForSnapshot::new(deno_core::RuntimeOptions {
    extensions: vec![ops::jse::init(None)],
    ..Default::default()
  });
  let snapshot = runtime.snapshot();

  let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
  std::fs::write(out_dir.join("jse_snapshot.bin"), &snapshot).expect("write snapshot");
  println!("cargo::warning=jse startup snapshot: {} bytes", snapshot.len());
}
