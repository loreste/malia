// Malia source container in a Wasm custom section. The Wasm exports do not
// execute the embedded JavaScript; application execution requires Malia.

use anyhow::{Context, Result};
use deno_ast::MediaType;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Metadata stored in the `jse_bundle` custom section of the .wasm binary.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WasmBundleMetadata {
  pub version: u32,
  pub entry: String,
  pub source: String,
  pub compiler: String,
  pub mode: String,
  pub timestamp: u64,
}

/// Encode an unsigned 32-bit integer as LEB128.
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

/// Encode a signed 32-bit integer as LEB128.
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

/// Write a WebAssembly section (ID + LEB128 size + payload).
pub fn write_section(buf: &mut Vec<u8>, section_id: u8, payload: &[u8]) {
  buf.push(section_id);
  write_u32_leb128(buf, payload.len() as u32);
  buf.extend_from_slice(payload);
}

/// Write a string with LEB128 length prefix.
pub fn write_name(buf: &mut Vec<u8>, name: &str) {
  write_u32_leb128(buf, name.len() as u32);
  buf.extend_from_slice(name.as_bytes());
}

/// Compile a JavaScript or TypeScript file into a valid WebAssembly binary (.wasm).
pub fn compile_file_to_wasm(file_path: &Path) -> Result<Vec<u8>> {
  let raw_source = std::fs::read_to_string(file_path)
    .with_context(|| format!("Failed to read source file {}", file_path.display()))?;

  // Transpile if TypeScript / JSX
  let media_type = MediaType::from_path(file_path);
  let js_source = match media_type {
    MediaType::TypeScript | MediaType::Mts | MediaType::Cts | MediaType::Jsx | MediaType::Tsx => {
      let specifier = deno_core::resolve_path(
        &file_path.to_string_lossy(),
        &std::env::current_dir().unwrap_or_default(),
      )?;
      let (js, _map) = crate::ts::transpile(&specifier, media_type, raw_source)
        .with_context(|| format!("Failed to transpile {}", file_path.display()))?;
      js
    }
    _ => raw_source,
  };

  let file_name = file_path
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("app.js")
    .to_string();

  build_wasm_application(&file_name, &js_source)
}

/// Construct a standards-compliant WebAssembly binary (.wasm) embedding the application.
pub fn build_wasm_application(entry_name: &str, js_source: &str) -> Result<Vec<u8>> {
  let mut wasm = Vec::new();

  // 1. WebAssembly Header: Magic (\0asm) and Version (1)
  wasm.extend_from_slice(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  // 2. Custom Section: "jse_bundle" (Application bundle payload)
  let metadata = WasmBundleMetadata {
    version: 1,
    entry: entry_name.to_string(),
    source: js_source.to_string(),
    compiler: format!("jse-wasm-{}", env!("CARGO_PKG_VERSION")),
    mode: "malia_source_container".to_string(),
    timestamp: std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_secs())
      .unwrap_or(0),
  };
  let metadata_json = serde_json::to_string(&metadata)?;
  anyhow::ensure!(
    metadata_json.len() <= MAX_CONTAINER_BYTES,
    "source container exceeds 16 MiB"
  );

  let mut custom_payload = Vec::new();
  write_name(&mut custom_payload, "jse_bundle");
  custom_payload.extend_from_slice(metadata_json.as_bytes());
  write_section(&mut wasm, 0, &custom_payload);

  // 3. Type Section (Section 1)
  // Types:
  // Type 0: () -> ()
  // Type 1: (i32, i32) -> i32
  // Type 2: (i32) -> i32
  // Type 3: () -> i32
  let mut type_payload = Vec::new();
  write_u32_leb128(&mut type_payload, 4); // 4 types

  // Type 0: () -> ()
  type_payload.push(0x60);
  write_u32_leb128(&mut type_payload, 0); // 0 params
  write_u32_leb128(&mut type_payload, 0); // 0 returns

  // Type 1: (i32, i32) -> i32
  type_payload.push(0x60);
  write_u32_leb128(&mut type_payload, 2); // 2 params
  type_payload.push(0x7f); // i32
  type_payload.push(0x7f); // i32
  write_u32_leb128(&mut type_payload, 1); // 1 return
  type_payload.push(0x7f); // i32

  // Type 2: (i32) -> i32
  type_payload.push(0x60);
  write_u32_leb128(&mut type_payload, 1); // 1 param
  type_payload.push(0x7f); // i32
  write_u32_leb128(&mut type_payload, 1); // 1 return
  type_payload.push(0x7f); // i32

  // Type 3: () -> i32
  type_payload.push(0x60);
  write_u32_leb128(&mut type_payload, 0); // 0 params
  write_u32_leb128(&mut type_payload, 1); // 1 return
  type_payload.push(0x7f); // i32

  write_section(&mut wasm, 1, &type_payload);

  // 4. Function Section (Section 3)
  // Maps 4 functions to types:
  // Func 0 (_start): Type 0
  // Func 1 (main): Type 3
  // Func 2 (optimize): Type 2
  // Func 3 (compute): Type 1
  let mut func_payload = Vec::new();
  write_u32_leb128(&mut func_payload, 4);
  write_u32_leb128(&mut func_payload, 0); // Type 0
  write_u32_leb128(&mut func_payload, 3); // Type 3
  write_u32_leb128(&mut func_payload, 2); // Type 2
  write_u32_leb128(&mut func_payload, 1); // Type 1
  write_section(&mut wasm, 3, &func_payload);

  // 5. Memory Section (Section 5)
  // 1 memory: min 2 pages (128KB), max 256 pages (16MB)
  let mut mem_payload = Vec::new();
  write_u32_leb128(&mut mem_payload, 1); // 1 memory
  mem_payload.push(0x01); // flags: has maximum
  write_u32_leb128(&mut mem_payload, 2); // min = 2
  write_u32_leb128(&mut mem_payload, 256); // max = 256
  write_section(&mut wasm, 5, &mem_payload);

  // 6. Export Section (Section 7)
  // Exports:
  // "memory" -> Memory 0
  // "_start" -> Func 0 (WASI entry)
  // "main"   -> Func 1
  // "optimize" -> Func 2
  // "compute"  -> Func 3
  let mut export_payload = Vec::new();
  write_u32_leb128(&mut export_payload, 6); // 6 exports

  write_name(&mut export_payload, "memory");
  export_payload.push(0x02); // memory export
  write_u32_leb128(&mut export_payload, 0);

  write_name(&mut export_payload, "_start");
  export_payload.push(0x00); // func export
  write_u32_leb128(&mut export_payload, 0);

  write_name(&mut export_payload, "main");
  export_payload.push(0x00);
  write_u32_leb128(&mut export_payload, 1);

  write_name(&mut export_payload, "optimize");
  export_payload.push(0x00);
  write_u32_leb128(&mut export_payload, 2);

  write_name(&mut export_payload, "compute");
  export_payload.push(0x00);
  write_u32_leb128(&mut export_payload, 3);

  write_name(&mut export_payload, "add");
  export_payload.push(0x00);
  write_u32_leb128(&mut export_payload, 3);

  write_section(&mut wasm, 7, &export_payload);

  // 7. Code Section (Section 10)
  let mut code_payload = Vec::new();
  write_u32_leb128(&mut code_payload, 4); // 4 function bodies

  // Body 0: _start () -> ()
  // Body: calls main, drops, returns
  let mut body0 = Vec::new();
  write_u32_leb128(&mut body0, 0); // 0 local declarations
  body0.push(0x10); // call
  write_u32_leb128(&mut body0, 1); // func 1 (main)
  body0.push(0x1a); // drop
  body0.push(0x0b); // end
  write_u32_leb128(&mut code_payload, body0.len() as u32);
  code_payload.extend_from_slice(&body0);

  // Body 1: main () -> i32
  // Body: returns 0
  let mut body1 = Vec::new();
  write_u32_leb128(&mut body1, 0);
  body1.push(0x41); // i32.const
  write_i32_leb128(&mut body1, 0);
  body1.push(0x0b); // end
  write_u32_leb128(&mut code_payload, body1.len() as u32);
  code_payload.extend_from_slice(&body1);

  // Body 2: optimize (i32) -> i32
  // Body: local.get 0; i32.const 1; i32.add; end
  let mut body2 = Vec::new();
  write_u32_leb128(&mut body2, 0);
  body2.push(0x20); // local.get
  write_u32_leb128(&mut body2, 0);
  body2.push(0x41); // i32.const
  write_i32_leb128(&mut body2, 1);
  body2.push(0x6a); // i32.add
  body2.push(0x0b); // end
  write_u32_leb128(&mut code_payload, body2.len() as u32);
  code_payload.extend_from_slice(&body2);

  // Body 3: compute (i32, i32) -> i32
  // Body: local.get 0; local.get 1; i32.add; end
  let mut body3 = Vec::new();
  write_u32_leb128(&mut body3, 0);
  body3.push(0x20); // local.get
  write_u32_leb128(&mut body3, 0);
  body3.push(0x20); // local.get
  write_u32_leb128(&mut body3, 1);
  body3.push(0x6a); // i32.add
  body3.push(0x0b); // end
  write_u32_leb128(&mut code_payload, body3.len() as u32);
  code_payload.extend_from_slice(&body3);

  write_section(&mut wasm, 10, &code_payload);

  Ok(wasm)
}

/// Extract the bundled JavaScript/TypeScript source from a compiled WebAssembly binary.
pub const MAX_CONTAINER_BYTES: usize = 16 * 1024 * 1024;

pub fn extract_wasm_bundle(bytes: &[u8]) -> Result<Option<WasmBundleMetadata>> {
  anyhow::ensure!(bytes.len() >= 8 && &bytes[..4] == b"\0asm", "invalid Wasm header");
  anyhow::ensure!(bytes[4..8] == [1, 0, 0, 0], "unsupported Wasm version");
  let mut offset = 8;
  let mut bundle = None;
  while offset < bytes.len() {
    let section_id = bytes[offset];
    offset += 1;
    anyhow::ensure!(section_id <= 13, "invalid Wasm section id");
    let (length, encoded) = read_u32_leb128(&bytes[offset..]).context("invalid section length")?;
    offset += encoded;
    let end = offset.checked_add(length as usize).context("section length overflow")?;
    let section = bytes.get(offset..end).context("truncated Wasm section")?;
    if section_id == 0 {
      let (name_len, name_encoded) = read_u32_leb128(section).context("invalid custom section name length")?;
      let name_end = name_encoded
        .checked_add(name_len as usize)
        .context("name length overflow")?;
      let name = std::str::from_utf8(
        section
          .get(name_encoded..name_end)
          .context("truncated custom section name")?,
      )?;
      if name == "jse_bundle" {
        anyhow::ensure!(bundle.is_none(), "duplicate Malia source container");
        let payload = &section[name_end..];
        anyhow::ensure!(payload.len() <= MAX_CONTAINER_BYTES, "source container exceeds 16 MiB");
        let metadata: WasmBundleMetadata =
          serde_json::from_slice(payload).context("invalid source container metadata")?;
        anyhow::ensure!(metadata.version == 1, "unsupported source container version");
        anyhow::ensure!(
          matches!(metadata.mode.as_str(), "malia_source_container" | "wasm_optimized"),
          "unsupported source container mode"
        );
        bundle = Some(metadata);
      }
    }
    offset = end;
  }
  Ok(bundle)
}

fn read_u32_leb128(bytes: &[u8]) -> Option<(u32, usize)> {
  let mut result = 0u32;
  for (i, &byte) in bytes.iter().take(5).enumerate() {
    if i == 4 && byte & 0xf0 != 0 {
      return None;
    }
    result |= ((byte & 0x7f) as u32) << (i * 7);
    if byte & 0x80 == 0 {
      return Some((result, i + 1));
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn mal_003_rejects_invalid_sections_and_metadata() {
    let header = b"\0asm\x01\0\0\0";
    for tail in [&[0, 128][..], &[0, 255, 255, 255, 255, 31], &[0, 10, 1, b'x']] {
      let mut bytes = header.to_vec();
      bytes.extend_from_slice(tail);
      assert!(extract_wasm_bundle(&bytes).is_err());
    }
    let mut bytes = header.to_vec();
    let mut custom = Vec::new();
    write_name(&mut custom, "jse_bundle");
    custom.extend_from_slice(b"invalid json");
    write_section(&mut bytes, 0, &custom);
    assert!(extract_wasm_bundle(&bytes).is_err());
    let valid = build_wasm_application("main.js", "42").unwrap();
    let mut meta = extract_wasm_bundle(&valid).unwrap().unwrap();
    meta.version = 99;
    let mut bytes = header.to_vec();
    let mut custom = Vec::new();
    write_name(&mut custom, "jse_bundle");
    custom.extend_from_slice(&serde_json::to_vec(&meta).unwrap());
    write_section(&mut bytes, 0, &custom);
    assert!(extract_wasm_bundle(&bytes).is_err());
  }

  #[test]
  fn mal_003_rejects_unknown_wasm_version() {
    let mut bytes = build_wasm_application("x.js", "globalThis.sideEffect = true").unwrap();
    bytes[4] = 2;
    assert!(extract_wasm_bundle(&bytes).is_err());
  }

  #[test]
  fn test_wasm_compilation_and_extraction() {
    let source = "console.log('hello from wasm application'); const x = 40 + 2;";
    let wasm_bytes = build_wasm_application("test_app.js", source).expect("build wasm");

    assert_eq!(&wasm_bytes[0..4], b"\0asm");
    assert_eq!(&wasm_bytes[4..8], &[1, 0, 0, 0]);

    let meta = extract_wasm_bundle(&wasm_bytes)
      .expect("valid container")
      .expect("extract bundle");
    assert_eq!(meta.entry, "test_app.js");
    assert_eq!(meta.source, source);
    assert_eq!(meta.mode, "malia_source_container");
  }
}
