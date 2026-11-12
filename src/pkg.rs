//! Built-in package installer -- minimal npm-compatible registry client.
//!
//! Supports:
//!   malia install              -- install deps from package.json
//!   malia install <pkg> [...]  -- add packages, update package.json
//!   malia install -g <pkg>     -- install CLI binaries globally

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

// ── Registry types ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct PackageMeta {
  #[serde(rename = "dist-tags")]
  dist_tags: Option<HashMap<String, String>>,
  versions: Option<HashMap<String, VersionMeta>>,
}

#[derive(serde::Deserialize)]
struct VersionMeta {
  version: String,
  dist: Option<DistInfo>,
  dependencies: Option<HashMap<String, String>>,
  bin: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct DistInfo {
  tarball: String,
  #[allow(dead_code)]
  shasum: Option<String>,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Install all dependencies from package.json in `project_dir`.
pub fn install_all(project_dir: &Path) -> Result<(), String> {
  let pkg_path = project_dir.join("package.json");
  if !pkg_path.exists() {
    return Err("No package.json found in current directory.".into());
  }
  let pkg: serde_json::Value = serde_json::from_str(&fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?)
    .map_err(|e| format!("Invalid package.json: {e}"))?;

  let mut deps: Vec<(String, String)> = Vec::new();
  if let Some(d) = pkg.get("dependencies").and_then(|v| v.as_object()) {
    for (k, v) in d {
      deps.push((k.clone(), v.as_str().unwrap_or("latest").to_string()));
    }
  }
  if let Some(d) = pkg.get("devDependencies").and_then(|v| v.as_object()) {
    for (k, v) in d {
      deps.push((k.clone(), v.as_str().unwrap_or("latest").to_string()));
    }
  }

  if deps.is_empty() {
    println!("No dependencies to install.");
    return Ok(());
  }

  let nm = project_dir.join("node_modules");
  fs::create_dir_all(&nm).map_err(|e| format!("Cannot create node_modules: {e}"))?;

  let total = deps.len();
  let mut installed = 0usize;
  let mut failed = Vec::new();
  for (name, version_spec) in &deps {
    if nm.join(name).join("package.json").exists() {
      installed += 1;
      continue;
    }
    match install_one(&nm, name, version_spec) {
      Ok(ver) => {
        installed += 1;
        println!("  + {name}@{ver}");
      }
      Err(e) => {
        failed.push(format!("{name}: {e}"));
      }
    }
  }
  println!("\nInstalled {installed}/{total} packages.");
  if !failed.is_empty() {
    eprintln!("\nFailed:");
    for f in &failed {
      eprintln!("  {f}");
    }
    return Err(format!("{} package(s) failed to install", failed.len()));
  }
  Ok(())
}

/// Install specific packages into `project_dir`, updating package.json.
pub fn install_packages(project_dir: &Path, packages: &[String], save_dev: bool) -> Result<(), String> {
  let pkg_path = project_dir.join("package.json");
  let mut pkg: serde_json::Value = if pkg_path.exists() {
    serde_json::from_str(&fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?)
      .map_err(|e| format!("Invalid package.json: {e}"))?
  } else {
    serde_json::json!({"name": "project", "version": "1.0.0"})
  };

  let nm = project_dir.join("node_modules");
  fs::create_dir_all(&nm).map_err(|e| format!("Cannot create node_modules: {e}"))?;

  let dep_key = if save_dev { "devDependencies" } else { "dependencies" };

  for spec in packages {
    let (name, version_spec) = parse_package_spec(spec);
    match install_one(&nm, &name, &version_spec) {
      Ok(ver) => {
        println!("  + {name}@{ver}");
        // Update package.json
        let section = pkg
          .as_object_mut()
          .unwrap()
          .entry(dep_key)
          .or_insert_with(|| serde_json::json!({}));
        section
          .as_object_mut()
          .unwrap()
          .insert(name, serde_json::Value::String(format!("^{ver}")));
      }
      Err(e) => {
        eprintln!("error: {name}: {e}");
      }
    }
  }

  // Write updated package.json
  let json = serde_json::to_string_pretty(&pkg).unwrap();
  fs::write(&pkg_path, format!("{json}\n")).map_err(|e| format!("Cannot write package.json: {e}"))?;
  Ok(())
}

/// Install package(s) globally to ~/.malia/bin.
pub fn install_global(packages: &[String]) -> Result<(), String> {
  let home = std::env::var("HOME")
    .or_else(|_| std::env::var("USERPROFILE"))
    .map_err(|_| "Cannot determine home directory")?;
  let global_dir = PathBuf::from(&home).join(".malia");
  let bin_dir = global_dir.join("bin");
  let lib_dir = global_dir.join("lib").join("node_modules");
  fs::create_dir_all(&bin_dir).map_err(|e| format!("Cannot create ~/.malia/bin: {e}"))?;
  fs::create_dir_all(&lib_dir).map_err(|e| format!("Cannot create global lib: {e}"))?;

  for spec in packages {
    let (name, version_spec) = parse_package_spec(spec);
    match install_one(&lib_dir, &name, &version_spec) {
      Ok(ver) => {
        println!("  + {name}@{ver}");
        // Link bin entries
        link_bins(&lib_dir.join(&name), &bin_dir)?;
      }
      Err(e) => {
        eprintln!("error: {name}: {e}");
      }
    }
  }
  Ok(())
}

/// Remove packages from node_modules and package.json.
pub fn uninstall(project_dir: &Path, packages: &[String]) -> Result<(), String> {
  let pkg_path = project_dir.join("package.json");
  let nm = project_dir.join("node_modules");

  // Remove from node_modules
  for name in packages {
    let pkg_dir = nm.join(name);
    if pkg_dir.exists() {
      fs::remove_dir_all(&pkg_dir).map_err(|e| format!("Cannot remove {name}: {e}"))?;
      println!("  - {name}");
    } else {
      eprintln!("  warn: {name} not found in node_modules");
    }
  }

  // Update package.json
  if pkg_path.exists() {
    let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
    let mut pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let mut changed = false;
    for key in &[
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] {
      if let Some(deps) = pkg.get_mut(*key).and_then(|v| v.as_object_mut()) {
        for name in packages {
          if deps.remove(name).is_some() {
            changed = true;
          }
        }
      }
    }
    if changed {
      let json = serde_json::to_string_pretty(&pkg).unwrap();
      fs::write(&pkg_path, format!("{json}\n")).map_err(|e| format!("Cannot write package.json: {e}"))?;
    }
  }
  Ok(())
}

/// Remove globally installed packages.
pub fn uninstall_global(packages: &[String]) -> Result<(), String> {
  let home = std::env::var("HOME")
    .or_else(|_| std::env::var("USERPROFILE"))
    .map_err(|_| "Cannot determine home directory")?;
  let global_dir = PathBuf::from(&home).join(".malia");
  let bin_dir = global_dir.join("bin");
  let lib_dir = global_dir.join("lib").join("node_modules");

  for name in packages {
    // Remove bin links
    let pkg_dir = lib_dir.join(name);
    if pkg_dir.join("package.json").exists() {
      let content = fs::read_to_string(pkg_dir.join("package.json")).unwrap_or_default();
      if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
        let bin_names: Vec<String> = match pkg.get("bin") {
          Some(serde_json::Value::String(_)) => vec![name.clone()],
          Some(serde_json::Value::Object(obj)) => obj.keys().cloned().collect(),
          _ => vec![],
        };
        for bn in &bin_names {
          let _ = fs::remove_file(bin_dir.join(bn));
          #[cfg(windows)]
          let _ = fs::remove_file(bin_dir.join(format!("{bn}.cmd")));
        }
      }
    }
    // Remove package dir
    if pkg_dir.exists() {
      fs::remove_dir_all(&pkg_dir).map_err(|e| format!("Cannot remove {name}: {e}"))?;
      println!("  - {name}");
    } else {
      eprintln!("  warn: {name} not installed globally");
    }
  }
  Ok(())
}

/// List installed packages.
pub fn list_packages(project_dir: &Path, all: bool, global: bool) -> Result<(), String> {
  let nm = if global {
    let home = std::env::var("HOME")
      .or_else(|_| std::env::var("USERPROFILE"))
      .map_err(|_| "Cannot determine home directory")?;
    PathBuf::from(&home).join(".malia").join("lib").join("node_modules")
  } else {
    project_dir.join("node_modules")
  };

  if !nm.exists() {
    println!("(empty)");
    return Ok(());
  }

  let location = if global { "~/.malia/lib" } else { "." };
  println!("{location}");

  let mut entries: Vec<_> = fs::read_dir(&nm)
    .map_err(|e| e.to_string())?
    .filter_map(|e| e.ok())
    .filter(|e| {
      let name = e.file_name();
      let n = name.to_string_lossy();
      !n.starts_with('.') && e.path().join("package.json").exists()
    })
    .collect();
  entries.sort_by_key(|e| e.file_name());

  for (i, entry) in entries.iter().enumerate() {
    let name = entry.file_name();
    let n = name.to_string_lossy();
    let ver = read_pkg_version(&entry.path()).unwrap_or_else(|| "?".into());
    let prefix = if i == entries.len() - 1 {
      "└──"
    } else {
      "├──"
    };
    println!("{prefix} {n}@{ver}");

    if all {
      // Show sub-deps
      let sub_nm = entry.path().join("node_modules");
      if sub_nm.exists() {
        if let Ok(sub_entries) = fs::read_dir(&sub_nm) {
          for sub in sub_entries.flatten() {
            let sn = sub.file_name();
            let sv = read_pkg_version(&sub.path()).unwrap_or_else(|| "?".into());
            let sp = if i == entries.len() - 1 { "    " } else { "│   " };
            println!("{sp}└── {}@{sv}", sn.to_string_lossy());
          }
        }
      }
    }
  }
  Ok(())
}

fn read_pkg_version(pkg_dir: &Path) -> Option<String> {
  let content = fs::read_to_string(pkg_dir.join("package.json")).ok()?;
  let pkg: serde_json::Value = serde_json::from_str(&content).ok()?;
  pkg.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

// ── Internals ───────────────────────────────────────────────────────────────

fn parse_package_spec(spec: &str) -> (String, String) {
  // Handle @scope/name@version
  if spec.starts_with('@') {
    if let Some(pos) = spec[1..].find('@') {
      let pos = pos + 1;
      return (spec[..pos].to_string(), spec[pos + 1..].to_string());
    }
    return (spec.to_string(), "latest".to_string());
  }
  // name@version
  if let Some(pos) = spec.find('@') {
    return (spec[..pos].to_string(), spec[pos + 1..].to_string());
  }
  (spec.to_string(), "latest".to_string())
}

fn install_one(node_modules: &Path, name: &str, version_spec: &str) -> Result<String, String> {
  let registry_url = std::env::var("NPM_REGISTRY").unwrap_or_else(|_| "https://registry.npmjs.org".to_string());

  // Fetch package metadata
  let meta_url = format!("{registry_url}/{}", urlenc(name));
  let body = http_get(&meta_url)?;
  let meta: PackageMeta = serde_json::from_str(&body).map_err(|e| format!("Bad registry response for {name}: {e}"))?;

  // Resolve version
  let version =
    resolve_version(&meta, version_spec).ok_or_else(|| format!("No matching version for {name}@{version_spec}"))?;

  let versions = meta.versions.as_ref().ok_or("No versions in registry")?;
  let ver_meta = versions
    .get(&version)
    .ok_or_else(|| format!("Version {version} not found for {name}"))?;

  let dist = ver_meta
    .dist
    .as_ref()
    .ok_or_else(|| format!("No dist info for {name}@{version}"))?;

  // Download tarball
  let tarball = http_get_bytes(&dist.tarball)?;

  // Extract to node_modules/<name>
  let pkg_dir = node_modules.join(name);
  extract_tarball(&tarball, &pkg_dir)?;

  // Install sub-dependencies (one level only -- flat install)
  if let Some(sub_deps) = &ver_meta.dependencies {
    for (dep_name, dep_spec) in sub_deps {
      if node_modules.join(dep_name).exists() {
        continue;
      }
      match install_one(node_modules, dep_name, dep_spec) {
        Ok(v) => println!("  + {dep_name}@{v}"),
        Err(e) => eprintln!("  warn: {dep_name}: {e}"),
      }
    }
  }

  Ok(version)
}

fn resolve_version(meta: &PackageMeta, spec: &str) -> Option<String> {
  let dist_tags = meta.dist_tags.as_ref()?;

  // "latest", "next", etc.
  if let Some(v) = dist_tags.get(spec) {
    return Some(v.clone());
  }

  // Exact version
  if let Some(versions) = &meta.versions {
    if versions.contains_key(spec) {
      return Some(spec.to_string());
    }
  }

  // Semver range: strip leading ^, ~, >=, etc. and find best match
  let clean = spec
    .trim_start_matches('^')
    .trim_start_matches('~')
    .trim_start_matches(">=")
    .trim_start_matches('>');

  if let Some(versions) = &meta.versions {
    // For ^X.Y.Z pick highest X.*.* ; for ~X.Y.Z pick highest X.Y.*
    let parts: Vec<&str> = clean.split('.').collect();
    if !parts.is_empty() {
      let major = parts[0];
      let mut candidates: Vec<&str> = versions
        .keys()
        .filter(|v| {
          let vp: Vec<&str> = v.split('.').collect();
          if spec.starts_with('~') && parts.len() >= 2 {
            vp.first() == Some(&major) && vp.get(1) == parts.get(1).copied().as_ref()
          } else {
            vp.first() == Some(&major)
          }
        })
        .map(|s| s.as_str())
        .collect();
      candidates.sort_by(|a, b| compare_versions(a, b));
      if let Some(best) = candidates.last() {
        return Some(best.to_string());
      }
    }

    // Fallback: just pick the highest version
    let mut all: Vec<&str> = versions.keys().map(|s| s.as_str()).collect();
    all.sort_by(|a, b| compare_versions(a, b));
    return all.last().map(|s| s.to_string());
  }

  // Fall back to latest dist-tag
  dist_tags.get("latest").cloned()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
  let parse = |s: &str| -> Vec<u64> {
    s.split('.')
      .map(|p| {
        // strip pre-release suffix for numeric comparison
        let num = p.split('-').next().unwrap_or("0");
        num.parse().unwrap_or(0)
      })
      .collect()
  };
  let ap = parse(a);
  let bp = parse(b);
  ap.cmp(&bp)
}

fn extract_tarball(data: &[u8], dest: &Path) -> Result<(), String> {
  use flate2::read::GzDecoder;

  let gz = GzDecoder::new(data);
  let mut archive = tar::Archive::new(gz);

  // npm tarballs have a `package/` prefix in all entries
  fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;

  for entry in archive.entries().map_err(|e| format!("tar read: {e}"))? {
    let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
    let path = entry.path().map_err(|e| format!("tar path: {e}"))?;
    let path_str = path.to_string_lossy();

    // Strip the `package/` prefix
    let relative = if let Some(stripped) = path_str.strip_prefix("package/") {
      stripped.to_string()
    } else if let Some(stripped) = path_str.strip_prefix("package\\") {
      stripped.to_string()
    } else {
      path_str.to_string()
    };

    if relative.is_empty() || relative == "." {
      continue;
    }

    // Security: reject paths that escape dest
    let target = dest.join(&relative);
    if !target.starts_with(dest) {
      continue;
    }

    if entry.header().entry_type().is_dir() {
      fs::create_dir_all(&target).map_err(|e| format!("mkdir: {e}"))?;
    } else {
      if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
      }
      let mut file = fs::File::create(&target).map_err(|e| format!("create {}: {e}", target.display()))?;
      io::copy(&mut entry, &mut file).map_err(|e| format!("write {}: {e}", target.display()))?;
      // Preserve executable bit
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mode) = entry.header().mode() {
          if mode & 0o111 != 0 {
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
          }
        }
      }
    }
  }
  Ok(())
}

fn link_bins(pkg_dir: &Path, bin_dir: &Path) -> Result<(), String> {
  let pkg_json_path = pkg_dir.join("package.json");
  if !pkg_json_path.exists() {
    return Ok(());
  }
  let content = fs::read_to_string(&pkg_json_path).map_err(|e| e.to_string())?;
  let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

  let bins: HashMap<String, String> = match pkg.get("bin") {
    Some(serde_json::Value::String(s)) => {
      let name = pkg.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
      let mut m = HashMap::new();
      m.insert(name.to_string(), s.clone());
      m
    }
    Some(serde_json::Value::Object(obj)) => obj
      .iter()
      .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
      .collect(),
    _ => return Ok(()),
  };

  for (bin_name, rel_path) in &bins {
    let source = pkg_dir.join(rel_path);
    let target = bin_dir.join(bin_name);
    if !source.exists() {
      continue;
    }

    #[cfg(unix)]
    {
      // Create a shell wrapper that invokes the script with malia
      let wrapper = format!("#!/bin/sh\nexec malia \"{}\" \"$@\"\n", source.display());
      fs::write(&target, wrapper).map_err(|e| format!("write bin {bin_name}: {e}"))?;
      use std::os::unix::fs::PermissionsExt;
      let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
    }

    #[cfg(windows)]
    {
      let wrapper = format!("@echo off\r\nmalia \"{}\" %*\r\n", source.display());
      let cmd_target = target.with_extension("cmd");
      fs::write(&cmd_target, wrapper).map_err(|e| format!("write bin {bin_name}: {e}"))?;
    }

    println!("  linked: {bin_name}");
  }
  Ok(())
}

// ── HTTP helpers (sync, using std only) ─────────────────────────────────────

fn find_curl() -> String {
  for path in &["curl", "/usr/bin/curl", "/usr/local/bin/curl", "/opt/homebrew/bin/curl"] {
    if std::process::Command::new(path)
      .arg("--version")
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .status()
      .is_ok()
    {
      return path.to_string();
    }
  }
  "curl".to_string()
}

fn http_get(url: &str) -> Result<String, String> {
  let curl = find_curl();
  let output = std::process::Command::new(&curl)
    .args(["-fsSL", "--max-time", "30", url])
    .output()
    .map_err(|e| format!("Cannot fetch packages: curl not found ({e}). Install curl and try again."))?;
  if !output.status.success() {
    return Err(format!(
      "HTTP request failed ({}): {}",
      output.status,
      String::from_utf8_lossy(&output.stderr).trim()
    ));
  }
  String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8 response: {e}"))
}

fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
  let curl = find_curl();
  let output = std::process::Command::new(&curl)
    .args(["-fsSL", "--max-time", "120", url])
    .output()
    .map_err(|e| format!("Cannot download package: curl not found ({e}). Install curl and try again."))?;
  if !output.status.success() {
    return Err(format!(
      "Download failed ({}): {}",
      output.status,
      String::from_utf8_lossy(&output.stderr).trim()
    ));
  }
  Ok(output.stdout)
}

fn urlenc(s: &str) -> String {
  // Minimal URL encoding for scoped package names: @scope/name -> @scope%2fname
  s.replace('/', "%2f")
}
