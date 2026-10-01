// src/optimizer.rs - Continuous Runtime Optimizer & Wasm JIT Acceleration
use deno_core::op2;
use deno_core::v8;
use deno_error::JsErrorBox;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

static WASM_MODE: AtomicBool = AtomicBool::new(false);
static OPTIMIZER_PASSES: AtomicUsize = AtomicUsize::new(0);
static MEMORY_RECLAIMED: AtomicU64 = AtomicU64::new(0);

pub fn set_wasm_mode(enabled: bool) {
  WASM_MODE.store(enabled, Ordering::Relaxed);
}

pub fn is_wasm_mode() -> bool {
  WASM_MODE.load(Ordering::Relaxed)
}

pub fn init_v8_optimizations(wasm_mode: bool) {
  let flags = if wasm_mode {
    "--wasm-dynamic-tiering --wasm-lazy-compilation --wasm-tier-up --turbo-fast-api-calls"
  } else {
    "--turbo-fast-api-calls"
  };
  deno_core::v8::V8::set_flags_from_string(flags);
}

#[derive(serde::Serialize)]
pub struct HeapStats {
  pub used: usize,
  pub total: usize,
  pub limit: usize,
  pub external: usize,
}

#[derive(serde::Serialize)]
pub struct OptimizerStats {
  pub passes: usize,
  pub memory_reclaimed_bytes: u64,
  pub heap_used: usize,
  pub heap_total: usize,
  pub heap_limit: usize,
  pub mode: String,
  pub is_wasm: bool,
}

#[derive(serde::Serialize)]
pub struct WasmCompileOutput {
  pub success: bool,
  pub entry: String,
  pub output: String,
  pub bytes_written: usize,
}

#[op2(fast)]
pub fn op_is_wasm_mode() -> bool {
  is_wasm_mode()
}

#[op2]
#[serde]
pub fn op_v8_heap_statistics(scope: &mut v8::PinScope<'_, '_>) -> serde_json::Value {
  let hs = scope.get_heap_statistics();
  serde_json::json!({
    "total_heap_size": hs.total_heap_size(), "total_heap_size_executable": hs.total_heap_size_executable(),
    "total_physical_size": hs.total_physical_size(), "total_available_size": hs.total_available_size(),
    "used_heap_size": hs.used_heap_size(), "heap_size_limit": hs.heap_size_limit(),
    "malloced_memory": hs.malloced_memory(), "peak_malloced_memory": hs.peak_malloced_memory(),
    "does_zap_garbage": usize::from(hs.does_zap_garbage()), "external_memory": hs.external_memory(),
    "number_of_native_contexts": hs.number_of_native_contexts(), "number_of_detached_contexts": hs.number_of_detached_contexts(),
    "total_global_handles_size": hs.total_global_handles_size(), "used_global_handles_size": hs.used_global_handles_size()
  })
}

#[op2]
#[serde]
pub fn op_v8_heap_spaces(scope: &mut v8::PinScope<'_, '_>) -> Vec<serde_json::Value> {
  (0..scope.number_of_heap_spaces()).filter_map(|i| scope.get_heap_space_statistics(i)).map(|hs| serde_json::json!({
    "space_name": hs.space_name().to_string_lossy(), "space_size": hs.space_size(), "space_used_size": hs.space_used_size(),
    "space_available_size": hs.space_available_size(), "physical_space_size": hs.physical_space_size()
  })).collect()
}

#[op2]
#[serde]
pub fn op_optimizer_heap_stats<'a>(scope: &mut v8::PinScope<'a, '_>) -> Result<HeapStats, JsErrorBox> {
  let hs = scope.get_heap_statistics();
  Ok(HeapStats {
    used: hs.used_heap_size(),
    total: hs.total_heap_size(),
    limit: hs.heap_size_limit(),
    external: hs.external_memory(),
  })
}

#[op2]
#[serde]
pub fn op_optimizer_compact_memory<'a>(scope: &mut v8::PinScope<'a, '_>) -> Result<OptimizerStats, JsErrorBox> {
  let before = scope.get_heap_statistics();

  scope.low_memory_notification();

  let after = scope.get_heap_statistics();

  let reclaimed = if before.total_heap_size() > after.total_heap_size() {
    (before.total_heap_size() - after.total_heap_size()) as u64
  } else {
    0
  };

  let passes = OPTIMIZER_PASSES.fetch_add(1, Ordering::Relaxed) + 1;
  let total_reclaimed = MEMORY_RECLAIMED.fetch_add(reclaimed, Ordering::Relaxed) + reclaimed;

  Ok(OptimizerStats {
    passes,
    memory_reclaimed_bytes: total_reclaimed,
    heap_used: after.used_heap_size(),
    heap_total: after.total_heap_size(),
    heap_limit: after.heap_size_limit(),
    mode: "continuous".to_string(),
    is_wasm: is_wasm_mode(),
  })
}

#[op2]
#[serde]
pub fn op_optimizer_stats<'a>(scope: &mut v8::PinScope<'a, '_>) -> Result<OptimizerStats, JsErrorBox> {
  let hs = scope.get_heap_statistics();
  Ok(OptimizerStats {
    passes: OPTIMIZER_PASSES.load(Ordering::Relaxed),
    memory_reclaimed_bytes: MEMORY_RECLAIMED.load(Ordering::Relaxed),
    heap_used: hs.used_heap_size(),
    heap_total: hs.total_heap_size(),
    heap_limit: hs.heap_size_limit(),
    mode: "continuous".to_string(),
    is_wasm: is_wasm_mode(),
  })
}

#[op2]
#[serde]
pub fn op_wasm_compile_app(#[string] entry: String, #[string] output: String) -> Result<WasmCompileOutput, JsErrorBox> {
  crate::permissions::check_read(&entry)?;
  crate::permissions::check_write(&output)?;
  let entry_path = Path::new(&entry);
  let output_path = Path::new(&output);

  let wasm_bytes = crate::wasm_compiler::compile_file_to_wasm(entry_path)
    .map_err(|e| JsErrorBox::generic(format!("Wasm compilation failed: {e}")))?;

  if let Some(parent) = output_path.parent().filter(|p| !p.as_os_str().is_empty()) {
    let _ = std::fs::create_dir_all(parent);
  }

  std::fs::write(output_path, &wasm_bytes)
    .map_err(|e| JsErrorBox::generic(format!("Failed to write wasm output to {}: {e}", output_path.display())))?;

  Ok(WasmCompileOutput {
    success: true,
    entry,
    output,
    bytes_written: wasm_bytes.len(),
  })
}

#[op2]
#[buffer]
pub fn op_wasm_synthesize_fn(#[string] operation: String) -> Result<Vec<u8>, JsErrorBox> {
  use crate::wasm_compiler::*;

  let mut wasm = Vec::new();
  // Header
  wasm.extend_from_slice(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  // Type section
  let mut type_sec = Vec::new();
  match operation.as_str() {
    "increment" | "square" => {
      // (i32) -> i32
      write_u32_leb128(&mut type_sec, 1);
      type_sec.push(0x60);
      write_u32_leb128(&mut type_sec, 1);
      type_sec.push(0x7f);
      write_u32_leb128(&mut type_sec, 1);
      type_sec.push(0x7f);
    }
    _ => {
      // (i32, i32) -> i32
      write_u32_leb128(&mut type_sec, 1);
      type_sec.push(0x60);
      write_u32_leb128(&mut type_sec, 2);
      type_sec.push(0x7f);
      type_sec.push(0x7f);
      write_u32_leb128(&mut type_sec, 1);
      type_sec.push(0x7f);
    }
  }
  write_section(&mut wasm, 1, &type_sec);

  // Func section: 1 function, type 0
  let mut func_sec = Vec::new();
  write_u32_leb128(&mut func_sec, 1);
  write_u32_leb128(&mut func_sec, 0);
  write_section(&mut wasm, 3, &func_sec);

  // Export section: export "compute" as func 0
  let mut export_sec = Vec::new();
  write_u32_leb128(&mut export_sec, 1);
  write_name(&mut export_sec, "compute");
  export_sec.push(0x00);
  write_u32_leb128(&mut export_sec, 0);
  write_section(&mut wasm, 7, &export_sec);

  // Code section
  let mut code_sec = Vec::new();
  write_u32_leb128(&mut code_sec, 1);

  let mut body = Vec::new();
  write_u32_leb128(&mut body, 0); // 0 locals

  match operation.as_str() {
    "increment" => {
      body.push(0x20);
      write_u32_leb128(&mut body, 0); // local.get 0
      body.push(0x41);
      write_i32_leb128(&mut body, 1); // i32.const 1
      body.push(0x6a); // i32.add
    }
    "square" => {
      body.push(0x20);
      write_u32_leb128(&mut body, 0); // local.get 0
      body.push(0x20);
      write_u32_leb128(&mut body, 0); // local.get 0
      body.push(0x6c); // i32.mul
    }
    "sub" => {
      body.push(0x20);
      write_u32_leb128(&mut body, 0);
      body.push(0x20);
      write_u32_leb128(&mut body, 1);
      body.push(0x6b); // i32.sub
    }
    "mul" => {
      body.push(0x20);
      write_u32_leb128(&mut body, 0);
      body.push(0x20);
      write_u32_leb128(&mut body, 1);
      body.push(0x6c); // i32.mul
    }
    "div" => {
      body.push(0x20);
      write_u32_leb128(&mut body, 0);
      body.push(0x20);
      write_u32_leb128(&mut body, 1);
      body.push(0x6d); // i32.div_s
    }
    "bitwise" => {
      body.push(0x20);
      write_u32_leb128(&mut body, 0);
      body.push(0x20);
      write_u32_leb128(&mut body, 1);
      body.push(0x73); // i32.xor
    }
    _ => {
      // default: add
      body.push(0x20);
      write_u32_leb128(&mut body, 0);
      body.push(0x20);
      write_u32_leb128(&mut body, 1);
      body.push(0x6a); // i32.add
    }
  }

  body.push(0x0b); // end
  write_u32_leb128(&mut code_sec, body.len() as u32);
  code_sec.extend_from_slice(&body);
  write_section(&mut wasm, 10, &code_sec);

  Ok(wasm)
}
