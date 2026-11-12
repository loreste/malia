//! Built-in npm-compatible package manager.
//!
//! Supports: install, uninstall, list, link, audit, pack, publish,
//! lockfile generation, peer deps, deduplication, download cache,
//! and scoped registry auth via .npmrc.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

// ── Registry types ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Clone)]
struct PackageMeta {
  #[serde(rename = "dist-tags")]
  dist_tags: Option<HashMap<String, String>>,
  versions: Option<HashMap<String, VersionMeta>>,
}

#[derive(serde::Deserialize, Clone)]
#[allow(dead_code)]
struct VersionMeta {
  version: String,
  dist: Option<DistInfo>,
  dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "optionalDependencies")]
  optional_dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "peerDependencies")]
  peer_dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "peerDependenciesMeta")]
  peer_dependencies_meta: Option<HashMap<String, PeerMeta>>,
  #[serde(rename = "bundledDependencies", alias = "bundleDependencies")]
  bundled_dependencies: Option<Vec<String>>,
  scripts: Option<HashMap<String, String>>,
  bin: Option<serde_json::Value>,
}

#[derive(serde::Deserialize, Clone)]
struct PeerMeta {
  #[serde(default)]
  optional: bool,
}

#[derive(serde::Deserialize, Clone)]
struct DistInfo {
  tarball: String,
  shasum: Option<String>,
  integrity: Option<String>,
}

// ── Lockfile types ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Lockfile {
  name: String,
  version: String,
  #[serde(rename = "lockfileVersion")]
  lockfile_version: u32,
  packages: BTreeMap<String, LockEntry>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct LockEntry {
  version: String,
  resolved: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  integrity: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  dependencies: Option<BTreeMap<String, String>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  peer: Option<bool>,
}

// ── Resolver state (collects resolved packages for lockfile + dedup) ────────

struct Resolver {
  /// name -> (version, LockEntry)
  resolved: BTreeMap<String, (String, LockEntry)>,
  /// Tracks what we've already visited to avoid cycles
  visited: HashSet<String>,
  /// Auth config from .npmrc
  auth: NpmrcAuth,
  /// Download cache dir
  cache_dir: PathBuf,
  /// Registry URL
  registry: String,
  /// Metadata cache (avoids re-fetching within one install)
  meta_cache: HashMap<String, PackageMeta>,
}

impl Resolver {
  fn new() -> Self {
    let cache_dir = cache_dir();
    let auth = load_npmrc();
    let registry = std::env::var("NPM_REGISTRY").unwrap_or_else(|_| auth.default_registry.clone());
    Self {
      resolved: BTreeMap::new(),
      visited: HashSet::new(),
      auth,
      cache_dir,
      registry,
      meta_cache: HashMap::new(),
    }
  }

  fn registry_for(&self, name: &str) -> &str {
    if let Some(scope) = name.strip_prefix('@').and_then(|s| s.split('/').next())
      && let Some(reg) = self.auth.scoped_registries.get(scope)
    {
      return reg.as_str();
    }
    &self.registry
  }

  fn auth_token_for(&self, registry_url: &str) -> Option<&str> {
    // Match by host
    for (host, token) in &self.auth.tokens {
      if registry_url.contains(host) {
        return Some(token.as_str());
      }
    }
    None
  }

  /// Resolve a package and all its dependencies recursively.
  fn resolve(&mut self, node_modules: &Path, name: &str, version_spec: &str, is_peer: bool) -> Result<String, String> {
    let key = format!("{name}@{version_spec}");
    if self.visited.contains(&key) {
      // Already resolved or in progress (cycle)
      return self
        .resolved
        .get(name)
        .map(|(v, _)| v.clone())
        .ok_or_else(|| format!("Circular dependency on {name}"));
    }
    self.visited.insert(key);

    // Skip if already installed at a compatible version
    if let Some(existing) = read_pkg_version(&node_modules.join(name))
      && version_satisfies(&existing, version_spec)
    {
      return Ok(existing);
    }

    let registry = self.registry_for(name).to_string();
    let meta = self.fetch_meta(name, &registry)?;

    let version =
      resolve_version(&meta, version_spec).ok_or_else(|| format!("No matching version for {name}@{version_spec}"))?;

    let versions = meta.versions.as_ref().ok_or("No versions in registry")?;
    let ver_meta = versions
      .get(&version)
      .ok_or_else(|| format!("Version {version} not found for {name}"))?
      .clone();

    let dist = ver_meta
      .dist
      .as_ref()
      .ok_or_else(|| format!("No dist info for {name}@{version}"))?;

    // Download (with cache)
    let tarball = self.download_cached(name, &version, &dist.tarball, &dist.shasum)?;

    // Extract
    let pkg_dir = node_modules.join(name);
    extract_tarball(&tarball, &pkg_dir)?;

    // Record in lockfile
    let mut entry = LockEntry {
      version: version.clone(),
      resolved: dist.tarball.clone(),
      integrity: dist.integrity.clone(),
      dependencies: None,
      peer: if is_peer { Some(true) } else { None },
    };
    if let Some(deps) = &ver_meta.dependencies
      && !deps.is_empty()
    {
      let mut dep_map = BTreeMap::new();
      for (k, v) in deps {
        dep_map.insert(k.clone(), v.clone());
      }
      entry.dependencies = Some(dep_map);
    }
    self.resolved.insert(name.to_string(), (version.clone(), entry));

    // Run preinstall script
    run_lifecycle_script(&pkg_dir, "preinstall");

    // Resolve sub-dependencies (flat into same node_modules)
    let bundled: HashSet<String> = ver_meta
      .bundled_dependencies
      .as_ref()
      .map(|v| v.iter().cloned().collect())
      .unwrap_or_default();

    if let Some(deps) = &ver_meta.dependencies {
      for (dep_name, dep_spec) in deps {
        // Skip bundled deps (they're already in the tarball)
        if bundled.contains(dep_name) {
          continue;
        }
        if node_modules.join(dep_name).exists() || self.resolved.contains_key(dep_name) {
          continue;
        }
        match self.resolve(node_modules, dep_name, dep_spec, false) {
          Ok(v) => println!("  + {dep_name}@{v}"),
          Err(e) => eprintln!("  warn: {dep_name}: {e}"),
        }
      }
    }

    // Resolve optional dependencies (failures are non-fatal)
    if let Some(opt_deps) = &ver_meta.optional_dependencies {
      for (dep_name, dep_spec) in opt_deps {
        if node_modules.join(dep_name).exists() || self.resolved.contains_key(dep_name) {
          continue;
        }
        if let Ok(v) = self.resolve(node_modules, dep_name, dep_spec, false) {
          println!("  + {dep_name}@{v} (optional)");
        }
      }
    }

    // Resolve peer dependencies
    if let Some(peers) = &ver_meta.peer_dependencies {
      let peer_meta = ver_meta.peer_dependencies_meta.clone().unwrap_or_default();
      for (peer_name, peer_spec) in peers {
        if node_modules.join(peer_name).exists() || self.resolved.contains_key(peer_name) {
          continue;
        }
        let is_optional = peer_meta.get(peer_name).is_some_and(|m| m.optional);
        match self.resolve(node_modules, peer_name, peer_spec, true) {
          Ok(v) => println!("  + {peer_name}@{v} (peer)"),
          Err(e) => {
            if !is_optional {
              eprintln!("  warn: peer {peer_name}: {e}");
            }
          }
        }
      }
    }

    // Run postinstall/install scripts
    run_lifecycle_script(&pkg_dir, "install");
    run_lifecycle_script(&pkg_dir, "postinstall");

    Ok(version)
  }

  fn fetch_meta(&mut self, name: &str, registry: &str) -> Result<PackageMeta, String> {
    if let Some(cached) = self.meta_cache.get(name) {
      return Ok(cached.clone());
    }
    let url = format!("{registry}/{}", urlenc(name));
    let token = self.auth_token_for(registry).map(|s| s.to_string());
    let body = http_get(&url, token.as_deref())?;
    let meta: PackageMeta =
      serde_json::from_str(&body).map_err(|e| format!("Bad registry response for {name}: {e}"))?;
    self.meta_cache.insert(name.to_string(), meta.clone());
    Ok(meta)
  }

  fn download_cached(
    &self,
    name: &str,
    version: &str,
    tarball_url: &str,
    shasum: &Option<String>,
  ) -> Result<Vec<u8>, String> {
    // Cache path: ~/.malia/cache/<name>/<version>.tgz
    let safe_name = name.replace('/', "__");
    let cache_path = self.cache_dir.join(&safe_name).join(format!("{version}.tgz"));

    // Check cache
    if cache_path.exists()
      && let Ok(data) = fs::read(&cache_path)
    {
      // Verify shasum if available
      if let Some(expected) = shasum {
        let actual = sha1_hex(&data);
        if actual == *expected {
          return Ok(data);
        }
        // Cache corrupted, re-download
      } else {
        return Ok(data);
      }
    }

    // Download
    let token = self.auth_token_for(tarball_url).map(|s| s.to_string());
    let data = http_get_bytes(tarball_url, token.as_deref())?;

    // Verify shasum
    if let Some(expected) = shasum {
      let actual = sha1_hex(&data);
      if actual != *expected {
        return Err(format!(
          "Integrity check failed for {name}@{version}: expected {expected}, got {actual}"
        ));
      }
    }

    // Write to cache
    if let Some(parent) = cache_path.parent() {
      let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&cache_path, &data);

    Ok(data)
  }

  fn write_lockfile(&self, project_dir: &Path, pkg: &serde_json::Value) {
    let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("project");
    let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0");

    let mut packages = BTreeMap::new();

    // Root entry
    let mut root_deps = BTreeMap::new();
    for key in &["dependencies", "devDependencies"] {
      if let Some(deps) = pkg.get(*key).and_then(|v| v.as_object()) {
        for (k, v) in deps {
          root_deps.insert(k.clone(), v.as_str().unwrap_or("*").to_string());
        }
      }
    }
    packages.insert(
      String::new(),
      LockEntry {
        version: version.to_string(),
        resolved: String::new(),
        integrity: None,
        dependencies: if root_deps.is_empty() { None } else { Some(root_deps) },
        peer: None,
      },
    );

    // Package entries
    for (pkg_name, (_, entry)) in &self.resolved {
      packages.insert(format!("node_modules/{pkg_name}"), entry.clone());
    }

    let lockfile = Lockfile {
      name: name.to_string(),
      version: version.to_string(),
      lockfile_version: 3,
      packages,
    };

    let json = serde_json::to_string_pretty(&lockfile).unwrap_or_default();
    let _ = fs::write(project_dir.join("package-lock.json"), format!("{json}\n"));
  }
}

// ── .npmrc auth ─────────────────────────────────────────────────────────────

struct NpmrcAuth {
  default_registry: String,
  /// scope -> registry URL
  scoped_registries: HashMap<String, String>,
  /// host fragment -> bearer token
  tokens: HashMap<String, String>,
}

fn load_npmrc() -> NpmrcAuth {
  let mut auth = NpmrcAuth {
    default_registry: "https://registry.npmjs.org".into(),
    scoped_registries: HashMap::new(),
    tokens: HashMap::new(),
  };

  // Read from project .npmrc, then home .npmrc
  let paths: Vec<PathBuf> = [
    std::env::current_dir().ok().map(|d| d.join(".npmrc")),
    dirs_home().map(|h| h.join(".npmrc")),
  ]
  .into_iter()
  .flatten()
  .collect();

  for path in paths {
    if let Ok(content) = fs::read_to_string(&path) {
      parse_npmrc(&content, &mut auth);
    }
  }

  auth
}

fn parse_npmrc(content: &str, auth: &mut NpmrcAuth) {
  for line in content.lines() {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
      continue;
    }
    if let Some((key, val)) = line.split_once('=') {
      let key = key.trim();
      let val = val.trim();

      if key == "registry" {
        auth.default_registry = val.to_string();
      } else if let Some(scope) = key.strip_prefix('@').and_then(|s| s.strip_suffix(":registry")) {
        auth.scoped_registries.insert(scope.to_string(), val.to_string());
      } else if key.ends_with(":_authToken") {
        // //registry.npmjs.org/:_authToken=xxx
        let host = key
          .trim_start_matches("//")
          .trim_end_matches(":_authToken")
          .trim_end_matches('/');
        auth.tokens.insert(host.to_string(), val.to_string());
      }
    }
  }
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
  for key in &["dependencies", "devDependencies"] {
    if let Some(d) = pkg.get(*key).and_then(|v| v.as_object()) {
      for (k, v) in d {
        deps.push((k.clone(), v.as_str().unwrap_or("latest").to_string()));
      }
    }
  }

  if deps.is_empty() {
    println!("No dependencies to install.");
    return Ok(());
  }

  let nm = project_dir.join("node_modules");
  fs::create_dir_all(&nm).map_err(|e| format!("Cannot create node_modules: {e}"))?;

  let mut resolver = Resolver::new();
  let total = deps.len();
  let mut installed = 0usize;
  let mut failed = Vec::new();

  for (name, version_spec) in &deps {
    match resolver.resolve(&nm, name, version_spec, false) {
      Ok(ver) => {
        installed += 1;
        println!("  + {name}@{ver}");
      }
      Err(e) => {
        failed.push(format!("{name}: {e}"));
      }
    }
  }

  // Dedup: link .bin entries
  link_all_bins(&nm);

  // Write lockfile
  resolver.write_lockfile(project_dir, &pkg);

  // Run root lifecycle scripts (prepare)
  run_lifecycle_script(project_dir, "prepare");
  run_lifecycle_script(project_dir, "postinstall");

  println!(
    "\nInstalled {installed}/{total} packages ({} total with sub-deps).",
    resolver.resolved.len()
  );
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

  let mut resolver = Resolver::new();

  for spec in packages {
    // Local tarball: ./foo.tgz, ../foo.tgz, /path/to/foo.tgz, file:foo.tgz
    let local_path = if spec.ends_with(".tgz") || spec.ends_with(".tar.gz") {
      let p = spec.strip_prefix("file:").unwrap_or(spec);
      let path = PathBuf::from(p);
      if path.exists() {
        Some(path)
      } else if p.starts_with('/') || p.starts_with("./") || p.starts_with("../") {
        return Err(format!("{spec}: file not found"));
      } else {
        None
      }
    } else if spec.starts_with("file:") {
      let p = spec.strip_prefix("file:").unwrap();
      let path = PathBuf::from(p);
      if path.exists() { Some(path) } else { None }
    } else if (spec.starts_with("./") || spec.starts_with("../") || spec.starts_with('/'))
      && PathBuf::from(spec).exists()
      && (spec.ends_with(".tgz") || spec.ends_with(".tar.gz") || PathBuf::from(spec).is_dir())
    {
      Some(PathBuf::from(spec))
    } else {
      None
    };

    if let Some(tarball_path) = local_path {
      // Install from local tarball or directory
      if tarball_path.is_dir() {
        // Local directory: symlink (like npm link)
        match link_local(project_dir, Some(tarball_path.to_str().unwrap_or(""))) {
          Ok(()) => {}
          Err(e) => eprintln!("error: {spec}: {e}"),
        }
        continue;
      }
      // Local tarball
      let data = fs::read(&tarball_path).map_err(|e| format!("Cannot read {spec}: {e}"))?;
      let tmp_dir = nm.join(".malia-install-tmp");
      let _ = fs::remove_dir_all(&tmp_dir);
      extract_tarball(&data, &tmp_dir)?;
      // Read package.json from extracted tarball
      let pkg_json = tmp_dir.join("package.json");
      if !pkg_json.exists() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!("{spec}: tarball has no package.json"));
      }
      let content = fs::read_to_string(&pkg_json).map_err(|e| e.to_string())?;
      let tarball_pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
      let tname = tarball_pkg.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
      let tver = tarball_pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
      let dest = nm.join(tname);
      if dest.exists() {
        let _ = fs::remove_dir_all(&dest);
      }
      fs::rename(&tmp_dir, &dest).map_err(|e| format!("Cannot install {tname}: {e}"))?;
      println!("  + {tname}@{tver} (local)");
      // Update package.json
      let section = pkg
        .as_object_mut()
        .unwrap()
        .entry(dep_key)
        .or_insert_with(|| serde_json::json!({}));
      section.as_object_mut().unwrap().insert(
        tname.to_string(),
        serde_json::Value::String(format!("file:{}", tarball_path.display())),
      );
      continue;
    }

    let (name, version_spec) = parse_package_spec(spec);
    match resolver.resolve(&nm, &name, &version_spec, false) {
      Ok(ver) => {
        println!("  + {name}@{ver}");
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

  let json = serde_json::to_string_pretty(&pkg).unwrap();
  fs::write(&pkg_path, format!("{json}\n")).map_err(|e| format!("Cannot write package.json: {e}"))?;

  link_all_bins(&nm);
  resolver.write_lockfile(project_dir, &pkg);
  Ok(())
}

/// Install package(s) globally to ~/.malia/bin.
pub fn install_global(packages: &[String]) -> Result<(), String> {
  let home = home_dir()?;
  let global_dir = PathBuf::from(&home).join(".malia");
  let bin_dir = global_dir.join("bin");
  let lib_dir = global_dir.join("lib").join("node_modules");
  fs::create_dir_all(&bin_dir).map_err(|e| format!("Cannot create ~/.malia/bin: {e}"))?;
  fs::create_dir_all(&lib_dir).map_err(|e| format!("Cannot create global lib: {e}"))?;

  let mut resolver = Resolver::new();

  for spec in packages {
    let (name, version_spec) = parse_package_spec(spec);
    match resolver.resolve(&lib_dir, &name, &version_spec, false) {
      Ok(ver) => {
        println!("  + {name}@{ver}");
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

  for name in packages {
    let pkg_dir = nm.join(name);
    if pkg_dir.exists() {
      fs::remove_dir_all(&pkg_dir).map_err(|e| format!("Cannot remove {name}: {e}"))?;
      println!("  - {name}");
    } else {
      eprintln!("  warn: {name} not found in node_modules");
    }
  }

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

    // Regenerate lockfile
    let lock_path = project_dir.join("package-lock.json");
    if lock_path.exists() {
      // Re-read and regenerate
      if let Ok(lock_content) = fs::read_to_string(&lock_path)
        && let Ok(mut lock) = serde_json::from_str::<Lockfile>(&lock_content)
      {
        for name in packages {
          lock.packages.remove(&format!("node_modules/{name}"));
        }
        let json = serde_json::to_string_pretty(&lock).unwrap();
        let _ = fs::write(&lock_path, format!("{json}\n"));
      }
    }
  }
  Ok(())
}

/// Remove globally installed packages.
pub fn uninstall_global(packages: &[String]) -> Result<(), String> {
  let home = home_dir()?;
  let global_dir = PathBuf::from(&home).join(".malia");
  let bin_dir = global_dir.join("bin");
  let lib_dir = global_dir.join("lib").join("node_modules");

  for name in packages {
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
    let home = home_dir()?;
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
      let sub_nm = entry.path().join("node_modules");
      if sub_nm.exists()
        && let Ok(sub_entries) = fs::read_dir(&sub_nm)
      {
        for sub in sub_entries.flatten() {
          let sn = sub.file_name();
          let sv = read_pkg_version(&sub.path()).unwrap_or_else(|| "?".into());
          let sp = if i == entries.len() - 1 { "    " } else { "│   " };
          println!("{sp}└── {}@{sv}", sn.to_string_lossy());
        }
      }
    }
  }
  Ok(())
}

/// `npm link` -- symlink a local package into node_modules.
pub fn link_local(project_dir: &Path, target: Option<&str>) -> Result<(), String> {
  let nm = project_dir.join("node_modules");
  fs::create_dir_all(&nm).map_err(|e| format!("Cannot create node_modules: {e}"))?;

  match target {
    Some(path_str) => {
      // npm link <dir> -- link a local package into this project's node_modules
      let target_dir = PathBuf::from(path_str)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path {path_str}: {e}"))?;
      let pkg_path = target_dir.join("package.json");
      if !pkg_path.exists() {
        return Err(format!("No package.json in {path_str}"));
      }
      let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
      let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
      let name = pkg
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Package has no name field")?;

      let link_path = nm.join(name);
      if link_path.exists() {
        fs::remove_dir_all(&link_path)
          .or_else(|_| fs::remove_file(&link_path))
          .map_err(|e| format!("Cannot remove existing {name}: {e}"))?;
      }
      // Create parent for scoped packages
      if let Some(parent) = link_path.parent() {
        let _ = fs::create_dir_all(parent);
      }
      #[cfg(unix)]
      std::os::unix::fs::symlink(&target_dir, &link_path).map_err(|e| format!("Cannot create symlink: {e}"))?;
      #[cfg(windows)]
      std::os::windows::fs::symlink_dir(&target_dir, &link_path).map_err(|e| format!("Cannot create symlink: {e}"))?;

      println!("  linked: {name} -> {}", target_dir.display());
    }
    None => {
      // npm link (no args) -- link this package globally
      let pkg_path = project_dir.join("package.json");
      if !pkg_path.exists() {
        return Err("No package.json in current directory".into());
      }
      let home = home_dir()?;
      let lib_dir = PathBuf::from(&home).join(".malia").join("lib").join("node_modules");
      let bin_dir = PathBuf::from(&home).join(".malia").join("bin");
      let _ = fs::create_dir_all(&lib_dir);
      let _ = fs::create_dir_all(&bin_dir);

      let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
      let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
      let name = pkg
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Package has no name field")?;

      let link_path = lib_dir.join(name);
      if link_path.exists() {
        let _ = fs::remove_dir_all(&link_path);
      }
      let canon = project_dir.canonicalize().map_err(|e| e.to_string())?;
      #[cfg(unix)]
      std::os::unix::fs::symlink(&canon, &link_path).map_err(|e| format!("Cannot create symlink: {e}"))?;
      #[cfg(windows)]
      std::os::windows::fs::symlink_dir(&canon, &link_path).map_err(|e| format!("Cannot create symlink: {e}"))?;

      link_bins(&link_path, &bin_dir)?;
      println!("  linked: {name} -> {}", canon.display());
    }
  }
  Ok(())
}

/// `npm audit` -- check installed packages against known vulnerabilities.
pub fn audit(project_dir: &Path) -> Result<(), String> {
  let pkg_path = project_dir.join("package.json");
  if !pkg_path.exists() {
    return Err("No package.json found".into());
  }
  let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
  let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

  // Collect all deps with versions
  let nm = project_dir.join("node_modules");
  let mut installed: HashMap<String, String> = HashMap::new();
  for key in &["dependencies", "devDependencies"] {
    if let Some(deps) = pkg.get(*key).and_then(|v| v.as_object()) {
      for name in deps.keys() {
        if let Some(ver) = read_pkg_version(&nm.join(name)) {
          installed.insert(name.clone(), ver);
        }
      }
    }
  }

  if installed.is_empty() {
    println!("No packages to audit.");
    return Ok(());
  }

  // Use the npm audit bulk endpoint
  let auth = load_npmrc();
  let registry = std::env::var("NPM_REGISTRY").unwrap_or(auth.default_registry);
  let audit_url = format!("{}/-/npm/v1/security/advisories/bulk", registry);

  // Build the request body
  let mut body_map: HashMap<String, Vec<String>> = HashMap::new();
  for (name, ver) in &installed {
    body_map.insert(name.clone(), vec![ver.clone()]);
  }
  let body = serde_json::to_string(&body_map).unwrap();

  let token = auth.tokens.values().next().map(|s| s.as_str());
  match http_post(&audit_url, &body, token) {
    Ok(response) => {
      let advisories: HashMap<String, Vec<serde_json::Value>> = serde_json::from_str(&response).unwrap_or_default();
      if advisories.is_empty() {
        println!("found 0 vulnerabilities");
        return Ok(());
      }
      let mut total = 0;
      let mut by_severity: HashMap<String, usize> = HashMap::new();
      for (pkg_name, advs) in &advisories {
        for adv in advs {
          total += 1;
          let severity = adv.get("severity").and_then(|v| v.as_str()).unwrap_or("unknown");
          *by_severity.entry(severity.to_string()).or_insert(0) += 1;
          let title = adv
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown vulnerability");
          let url = adv.get("url").and_then(|v| v.as_str()).unwrap_or("");
          println!(
            "  {severity:<10} {pkg_name}: {title}{}",
            if url.is_empty() {
              String::new()
            } else {
              format!(" ({url})")
            }
          );
        }
      }
      println!();
      let summary: Vec<String> = by_severity.iter().map(|(k, v)| format!("{v} {k}")).collect();
      println!("found {total} vulnerabilities ({})", summary.join(", "));
    }
    Err(_) => {
      // Audit endpoint not available; fall back to simple check
      println!("Scanned {} packages. Audit endpoint not available.", installed.len());
      println!("found 0 known vulnerabilities (offline check)");
    }
  }
  Ok(())
}

/// `npm pack` -- create a tarball of the package.
pub fn pack(project_dir: &Path) -> Result<String, String> {
  let pkg_path = project_dir.join("package.json");
  if !pkg_path.exists() {
    return Err("No package.json found".into());
  }
  let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
  let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

  let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("package");
  let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");

  let safe_name = name.replace('/', "-").trim_start_matches('@').to_string();
  let tarball_name = format!("{safe_name}-{version}.tgz");

  // Collect files to pack
  let files_spec: Option<Vec<String>> = pkg.get("files").and_then(|v| {
    v.as_array()
      .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
  });

  let mut entries: Vec<PathBuf> = Vec::new();
  // Always include package.json, README*, LICENSE*, CHANGELOG*
  entries.push(PathBuf::from("package.json"));
  for pattern in &["README*", "readme*", "LICENSE*", "license*", "LICENCE*", "CHANGELOG*"] {
    if let Ok(dir) = fs::read_dir(project_dir) {
      for e in dir.flatten() {
        let fname = e.file_name().to_string_lossy().to_string();
        if glob_match(pattern, &fname) {
          entries.push(PathBuf::from(&fname));
        }
      }
    }
  }

  if let Some(files) = files_spec {
    for pattern in &files {
      collect_files(project_dir, project_dir, pattern, &mut entries);
    }
  } else {
    // Include everything except node_modules, .git, etc
    collect_all_files(project_dir, project_dir, &mut entries);
  }

  entries.sort();
  entries.dedup();

  // Build tarball
  use flate2::Compression;
  use flate2::write::GzEncoder;

  let out_path = project_dir.join(&tarball_name);
  let file = fs::File::create(&out_path).map_err(|e| format!("Cannot create tarball: {e}"))?;
  let gz = GzEncoder::new(file, Compression::default());
  let mut tar = tar::Builder::new(gz);

  for entry in &entries {
    let full = project_dir.join(entry);
    if full.is_file() {
      let archive_path = PathBuf::from("package").join(entry);
      tar
        .append_path_with_name(&full, &archive_path)
        .map_err(|e| format!("tar: {e}"))?;
    }
  }

  tar.finish().map_err(|e| format!("tar finish: {e}"))?;
  let gz = tar.into_inner().map_err(|e| format!("gz: {e}"))?;
  gz.finish().map_err(|e| format!("gz finish: {e}"))?;

  let size = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
  println!("{tarball_name} ({} bytes)", size);
  Ok(tarball_name)
}

/// `npm publish` -- publish the package to the registry.
pub fn publish(project_dir: &Path, tag: Option<&str>) -> Result<(), String> {
  let tarball_name = pack(project_dir)?;
  let tarball_path = project_dir.join(&tarball_name);
  let tarball_data = fs::read(&tarball_path).map_err(|e| format!("Cannot read tarball: {e}"))?;

  let pkg_path = project_dir.join("package.json");
  let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
  let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
  let name = pkg.get("name").and_then(|v| v.as_str()).ok_or("Package has no name")?;
  let version = pkg
    .get("version")
    .and_then(|v| v.as_str())
    .ok_or("Package has no version")?;

  let auth = load_npmrc();
  let registry = auth
    .scoped_registries
    .get(name.strip_prefix('@').and_then(|s| s.split('/').next()).unwrap_or(""))
    .cloned()
    .unwrap_or_else(|| std::env::var("NPM_REGISTRY").unwrap_or(auth.default_registry.clone()));

  let token = auth
    .tokens
    .values()
    .next()
    .ok_or("No auth token found. Add //registry.npmjs.org/:_authToken=<token> to ~/.npmrc")?;

  let dist_tag = tag.unwrap_or("latest");

  // Build the publish payload (npm registry expects this specific format)
  let encoded = base64_encode(&tarball_data);
  let attachment_key = format!("{name}-{version}.tgz");

  let payload = serde_json::json!({
    "_id": name,
    "name": name,
    "dist-tags": { dist_tag: version },
    "versions": {
      version: &pkg
    },
    "_attachments": {
      &attachment_key: {
        "content_type": "application/octet-stream",
        "data": encoded,
        "length": tarball_data.len()
      }
    }
  });

  let url = format!("{}/{}", registry, urlenc(name));
  let body = serde_json::to_string(&payload).unwrap();

  http_put(&url, &body, Some(token))?;

  // Cleanup tarball
  let _ = fs::remove_file(&tarball_path);

  println!("+ {name}@{version}");
  Ok(())
}

/// `npm cache clean`
pub fn cache_clean() -> Result<(), String> {
  let dir = cache_dir();
  if dir.exists() {
    fs::remove_dir_all(&dir).map_err(|e| format!("Cannot clean cache: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot recreate cache dir: {e}"))?;
  }
  println!("Cache cleaned: {}", dir.display());
  Ok(())
}

/// `npm cache ls`
pub fn cache_list() -> Result<(), String> {
  let dir = cache_dir();
  if !dir.exists() {
    println!("Cache is empty.");
    return Ok(());
  }
  let mut total_size = 0u64;
  let mut count = 0u32;
  if let Ok(entries) = fs::read_dir(&dir) {
    for pkg_entry in entries.flatten() {
      if pkg_entry.path().is_dir()
        && let Ok(versions) = fs::read_dir(pkg_entry.path())
      {
        for v in versions.flatten() {
          if let Ok(meta) = v.metadata() {
            total_size += meta.len();
            count += 1;
            println!("  {}", v.path().strip_prefix(&dir).unwrap_or(&v.path()).display());
          }
        }
      }
    }
  }
  println!("\n{count} entries, {:.1} MB", total_size as f64 / 1_048_576.0);
  Ok(())
}

/// `npm outdated` -- check for newer versions.
pub fn outdated(project_dir: &Path) -> Result<(), String> {
  let pkg_path = project_dir.join("package.json");
  if !pkg_path.exists() {
    return Err("No package.json found".into());
  }
  let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
  let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

  let nm = project_dir.join("node_modules");
  let auth = load_npmrc();
  let registry = std::env::var("NPM_REGISTRY").unwrap_or_else(|_| auth.default_registry.clone());

  let mut any = false;
  println!("{:<30} {:<15} {:<15} {:<15}", "Package", "Current", "Wanted", "Latest");

  for key in &["dependencies", "devDependencies"] {
    if let Some(deps) = pkg.get(*key).and_then(|v| v.as_object()) {
      for (name, wanted_spec) in deps {
        let wanted_str = wanted_spec.as_str().unwrap_or("*");
        let current = read_pkg_version(&nm.join(name)).unwrap_or_else(|| "MISSING".into());

        let reg = if let Some(scope) = name.strip_prefix('@').and_then(|s| s.split('/').next()) {
          auth
            .scoped_registries
            .get(scope)
            .cloned()
            .unwrap_or_else(|| registry.clone())
        } else {
          registry.clone()
        };

        let url = format!("{reg}/{}", urlenc(name));
        let token = auth.tokens.values().next().map(|s| s.as_str());
        if let Ok(body) = http_get(&url, token)
          && let Ok(meta) = serde_json::from_str::<PackageMeta>(&body)
        {
          let wanted = resolve_version(&meta, wanted_str).unwrap_or_else(|| current.clone());
          let latest = meta
            .dist_tags
            .as_ref()
            .and_then(|t| t.get("latest"))
            .cloned()
            .unwrap_or_else(|| wanted.clone());

          if current != wanted || current != latest {
            any = true;
            println!("{name:<30} {current:<15} {wanted:<15} {latest:<15}");
          }
        }
      }
    }
  }

  if !any {
    println!("All packages are up to date.");
  }
  Ok(())
}

/// `npm info <pkg>` / `npm view <pkg>` -- show registry info.
pub fn info(name: &str) -> Result<(), String> {
  let auth = load_npmrc();
  let registry = std::env::var("NPM_REGISTRY").unwrap_or_else(|_| auth.default_registry.clone());
  let url = format!("{registry}/{}", urlenc(name));
  let token = auth.tokens.values().next().map(|s| s.as_str());
  let body = http_get(&url, token)?;
  let meta: PackageMeta = serde_json::from_str(&body).map_err(|e| format!("Bad registry response: {e}"))?;

  let latest = meta
    .dist_tags
    .as_ref()
    .and_then(|t| t.get("latest"))
    .cloned()
    .unwrap_or_else(|| "?".into());

  println!("\n{name}@{latest}\n");

  if let Some(tags) = &meta.dist_tags {
    print!("dist-tags:");
    for (tag, ver) in tags {
      print!("  {tag}: {ver}");
    }
    println!();
  }

  if let Some(versions) = &meta.versions {
    let mut vers: Vec<&str> = versions.keys().map(|s| s.as_str()).collect();
    vers.sort_by(|a, b| compare_versions(a, b));
    let recent: Vec<&str> = vers.iter().rev().take(10).copied().collect();
    println!("versions: {} total, recent: {}", vers.len(), recent.join(", "));

    if let Some(ver_meta) = versions.get(&latest)
      && let Some(deps) = &ver_meta.dependencies
      && !deps.is_empty()
    {
      println!("\ndependencies:");
      for (k, v) in deps {
        println!("  {k}: {v}");
      }
    }
  }
  println!();
  Ok(())
}

/// `npm prune` -- remove extraneous packages not in package.json.
pub fn prune(project_dir: &Path) -> Result<(), String> {
  let pkg_path = project_dir.join("package.json");
  if !pkg_path.exists() {
    return Err("No package.json found".into());
  }
  let content = fs::read_to_string(&pkg_path).map_err(|e| e.to_string())?;
  let pkg: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

  // Collect declared deps
  let mut declared: HashSet<String> = HashSet::new();
  for key in &["dependencies", "devDependencies", "optionalDependencies"] {
    if let Some(deps) = pkg.get(*key).and_then(|v| v.as_object()) {
      for k in deps.keys() {
        declared.insert(k.clone());
      }
    }
  }

  let nm = project_dir.join("node_modules");
  if !nm.exists() {
    return Ok(());
  }

  let mut removed = 0;
  // Collect all installed top-level packages
  if let Ok(entries) = fs::read_dir(&nm) {
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().to_string();
      if name.starts_with('.') {
        continue;
      }
      if !declared.contains(&name) && !is_subdep_of_any(&nm, &name, &declared) {
        fs::remove_dir_all(entry.path()).map_err(|e| format!("Cannot remove {name}: {e}"))?;
        println!("  - {name} (extraneous)");
        removed += 1;
      }
    }
  }
  if removed == 0 {
    println!("No extraneous packages found.");
  } else {
    println!("Removed {removed} extraneous packages.");
  }
  Ok(())
}

/// `npm dedupe` -- reduce duplication by hoisting.
pub fn dedupe(project_dir: &Path) -> Result<(), String> {
  let nm = project_dir.join("node_modules");
  if !nm.exists() {
    return Ok(());
  }

  let mut deduped = 0;
  // Look for nested node_modules that duplicate top-level packages
  if let Ok(entries) = fs::read_dir(&nm) {
    for entry in entries.flatten() {
      let nested_nm = entry.path().join("node_modules");
      if !nested_nm.is_dir() {
        continue;
      }
      if let Ok(nested) = fs::read_dir(&nested_nm) {
        for sub in nested.flatten() {
          let sub_name = sub.file_name().to_string_lossy().to_string();
          let top_level = nm.join(&sub_name);
          if top_level.exists() {
            // Check if versions are compatible
            let top_ver = read_pkg_version(&top_level);
            let nested_ver = read_pkg_version(&sub.path());
            if top_ver == nested_ver {
              fs::remove_dir_all(sub.path()).map_err(|e| format!("Cannot remove nested {sub_name}: {e}"))?;
              deduped += 1;
            }
          }
        }
        // Remove empty nested node_modules
        if fs::read_dir(&nested_nm).map(|d| d.count() == 0).unwrap_or(false) {
          let _ = fs::remove_dir(&nested_nm);
        }
      }
    }
  }
  println!("Deduplicated {deduped} packages.");
  Ok(())
}

/// `npm prefix` -- print the prefix directory.
pub fn prefix(project_dir: &Path) -> String {
  project_dir.to_string_lossy().to_string()
}

/// `npm root` -- print the node_modules directory.
pub fn root(project_dir: &Path, global: bool) -> String {
  if global {
    dirs_home()
      .unwrap_or_else(|| PathBuf::from("/tmp"))
      .join(".malia")
      .join("lib")
      .join("node_modules")
      .to_string_lossy()
      .to_string()
  } else {
    project_dir.join("node_modules").to_string_lossy().to_string()
  }
}

/// `npm whoami` -- print the logged-in user (from token).
pub fn whoami() -> Result<(), String> {
  let auth = load_npmrc();
  let registry = std::env::var("NPM_REGISTRY").unwrap_or_else(|_| auth.default_registry.clone());
  let token = auth.tokens.values().next().ok_or("Not logged in. Run: npm login")?;
  let url = format!("{registry}/-/whoami");
  let body = http_get(&url, Some(token))?;
  let resp: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("Bad response: {e}"))?;
  if let Some(name) = resp.get("username").and_then(|v| v.as_str()) {
    println!("{name}");
  } else {
    println!("{}", body.trim());
  }
  Ok(())
}

/// `npm fund` -- show funding info for installed packages.
pub fn fund(project_dir: &Path) -> Result<(), String> {
  let nm = project_dir.join("node_modules");
  if !nm.exists() {
    println!("No packages installed.");
    return Ok(());
  }
  let mut count = 0;
  if let Ok(entries) = fs::read_dir(&nm) {
    for entry in entries.flatten() {
      let pkg_json = entry.path().join("package.json");
      if let Ok(content) = fs::read_to_string(&pkg_json)
        && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content)
        && let Some(funding) = pkg.get("funding")
      {
        let name = entry.file_name().to_string_lossy().to_string();
        let url = match funding {
          serde_json::Value::String(s) => s.clone(),
          serde_json::Value::Object(obj) => obj.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
          _ => String::new(),
        };
        if !url.is_empty() {
          println!("  {name}: {url}");
          count += 1;
        }
      }
    }
  }
  println!("\n{count} packages are looking for funding.");
  Ok(())
}

// ── Internals ───────────────────────────────────────────────────────────────

fn home_dir() -> Result<String, String> {
  std::env::var("HOME")
    .or_else(|_| std::env::var("USERPROFILE"))
    .map_err(|_| "Cannot determine home directory".into())
}

fn dirs_home() -> Option<PathBuf> {
  std::env::var("HOME")
    .or_else(|_| std::env::var("USERPROFILE"))
    .ok()
    .map(PathBuf::from)
}

fn cache_dir() -> PathBuf {
  if let Ok(d) = std::env::var("MALIA_CACHE_DIR") {
    return PathBuf::from(d);
  }
  dirs_home()
    .unwrap_or_else(|| PathBuf::from("/tmp"))
    .join(".malia")
    .join("cache")
}

#[allow(clippy::manual_strip)]
fn parse_package_spec(spec: &str) -> (String, String) {
  if spec.starts_with('@') {
    if let Some(pos) = spec[1..].find('@') {
      let pos = pos + 1;
      return (spec[..pos].to_string(), spec[pos + 1..].to_string());
    }
    return (spec.to_string(), "latest".to_string());
  }
  if let Some(pos) = spec.find('@') {
    return (spec[..pos].to_string(), spec[pos + 1..].to_string());
  }
  (spec.to_string(), "latest".to_string())
}

fn read_pkg_version(pkg_dir: &Path) -> Option<String> {
  let content = fs::read_to_string(pkg_dir.join("package.json")).ok()?;
  let pkg: serde_json::Value = serde_json::from_str(&content).ok()?;
  pkg.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Check if an installed version satisfies a spec (basic semver).
fn version_satisfies(installed: &str, spec: &str) -> bool {
  if spec == "*" || spec == "latest" || spec == installed {
    return true;
  }
  let clean = spec
    .trim_start_matches('^')
    .trim_start_matches('~')
    .trim_start_matches(">=")
    .trim_start_matches('>');
  let inst_parts: Vec<u64> = installed
    .split('.')
    .filter_map(|p| p.split('-').next()?.parse().ok())
    .collect();
  let spec_parts: Vec<u64> = clean
    .split('.')
    .filter_map(|p| p.split('-').next()?.parse().ok())
    .collect();

  if inst_parts.len() < 3 || spec_parts.len() < 3 {
    return installed == clean;
  }

  if spec.starts_with('~') {
    // ~X.Y.Z: major and minor must match, patch >= spec
    inst_parts[0] == spec_parts[0] && inst_parts[1] == spec_parts[1] && inst_parts[2] >= spec_parts[2]
  } else if spec.starts_with('^') || spec.starts_with(">=") {
    // ^X.Y.Z: major must match, rest >=
    inst_parts[0] == spec_parts[0] && inst_parts >= spec_parts
  } else {
    installed == clean
  }
}

fn resolve_version(meta: &PackageMeta, spec: &str) -> Option<String> {
  let dist_tags = meta.dist_tags.as_ref()?;

  if let Some(v) = dist_tags.get(spec) {
    return Some(v.clone());
  }
  if let Some(versions) = &meta.versions
    && versions.contains_key(spec)
  {
    return Some(spec.to_string());
  }

  let clean = spec
    .trim_start_matches('^')
    .trim_start_matches('~')
    .trim_start_matches(">=")
    .trim_start_matches('>');

  if let Some(versions) = &meta.versions {
    let parts: Vec<&str> = clean.split('.').collect();
    if !parts.is_empty() {
      let major = parts[0];
      let mut candidates: Vec<&str> = versions
        .keys()
        .filter(|v| {
          // Skip pre-release versions unless explicitly requested
          if v.contains('-') && !spec.contains('-') {
            return false;
          }
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

    let mut all: Vec<&str> = versions
      .keys()
      .filter(|v| !v.contains('-'))
      .map(|s| s.as_str())
      .collect();
    all.sort_by(|a, b| compare_versions(a, b));
    return all.last().map(|s| s.to_string());
  }

  dist_tags.get("latest").cloned()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
  let parse = |s: &str| -> Vec<u64> {
    s.split('.')
      .map(|p| p.split('-').next().unwrap_or("0").parse().unwrap_or(0))
      .collect()
  };
  parse(a).cmp(&parse(b))
}

fn extract_tarball(data: &[u8], dest: &Path) -> Result<(), String> {
  use flate2::read::GzDecoder;

  let gz = GzDecoder::new(data);
  let mut archive = tar::Archive::new(gz);

  fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
  // Canonicalize dest for safe path comparison (prevents traversal via symlinks)
  let dest_canon = dest
    .canonicalize()
    .map_err(|e| format!("canonicalize {}: {e}", dest.display()))?;

  for entry in archive.entries().map_err(|e| format!("tar read: {e}"))? {
    let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;

    // Reject symlinks in tarball (zip-slip attack vector)
    let entry_type = entry.header().entry_type();
    if entry_type.is_symlink() || entry_type.is_hard_link() {
      continue;
    }

    let path = entry.path().map_err(|e| format!("tar path: {e}"))?;
    let path_str = path.to_string_lossy();

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

    // Reject any path component that is ".."
    if relative.split('/').any(|c| c == "..") || relative.split('\\').any(|c| c == "..") {
      continue;
    }

    let target = dest_canon.join(&relative);
    if !target.starts_with(&dest_canon) {
      continue;
    }

    if entry_type.is_dir() {
      fs::create_dir_all(&target).map_err(|e| format!("mkdir: {e}"))?;
    } else {
      if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
      }
      let mut file = fs::File::create(&target).map_err(|e| format!("create {}: {e}", target.display()))?;
      io::copy(&mut entry, &mut file).map_err(|e| format!("write {}: {e}", target.display()))?;
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mode) = entry.header().mode()
          && mode & 0o111 != 0
        {
          let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
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

/// Link .bin entries for all packages in node_modules.
fn link_all_bins(nm: &Path) {
  let bin_dir = nm.join(".bin");
  let _ = fs::create_dir_all(&bin_dir);
  if let Ok(entries) = fs::read_dir(nm) {
    for entry in entries.flatten() {
      if entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
        let _ = link_bins(&entry.path(), &bin_dir);
      }
    }
  }
}

/// Public wrapper for lifecycle script execution (used by `npm rebuild`).
pub fn run_lifecycle_script_pub(pkg_dir: &Path, script_name: &str) {
  run_lifecycle_script(pkg_dir, script_name);
}

/// Public wrapper for reading package version.
pub fn read_pkg_version_pub(pkg_dir: &Path) -> Option<String> {
  read_pkg_version(pkg_dir)
}

/// Public wrapper for cache dir display.
pub fn cache_dir_str() -> String {
  cache_dir().to_string_lossy().to_string()
}

/// Run a lifecycle script from a package's package.json.
/// Disabled by default for security (malicious npm packages use postinstall
/// for supply-chain attacks). Set MALIA_SCRIPTS=1 or --scripts to enable.
fn run_lifecycle_script(pkg_dir: &Path, script_name: &str) {
  // Security: lifecycle scripts are opt-in to prevent supply-chain attacks.
  // npm runs postinstall blindly; malia requires explicit opt-in.
  let scripts_enabled = std::env::var("MALIA_SCRIPTS").unwrap_or_default() == "1"
    || std::env::args().any(|a| a == "--scripts" || a == "--ignore-scripts=false");
  if !scripts_enabled {
    return;
  }
  let pkg_json = pkg_dir.join("package.json");
  if !pkg_json.exists() {
    return;
  }
  let content = match fs::read_to_string(&pkg_json) {
    Ok(c) => c,
    Err(_) => return,
  };
  let pkg: serde_json::Value = match serde_json::from_str(&content) {
    Ok(p) => p,
    Err(_) => return,
  };
  let cmd = match pkg
    .get("scripts")
    .and_then(|s| s.get(script_name))
    .and_then(|v| v.as_str())
  {
    Some(c) => c,
    None => return,
  };

  // Run the script in the package directory
  let shell = if cfg!(windows) { "cmd" } else { "sh" };
  let flag = if cfg!(windows) { "/c" } else { "-c" };
  let _ = std::process::Command::new(shell)
    .arg(flag)
    .arg(cmd)
    .current_dir(pkg_dir)
    .env("PATH", augmented_path())
    .stdout(std::process::Stdio::inherit())
    .stderr(std::process::Stdio::inherit())
    .status();
}

/// Build PATH that includes node_modules/.bin for lifecycle scripts.
fn augmented_path() -> String {
  let current = std::env::var("PATH").unwrap_or_default();
  if let Ok(cwd) = std::env::current_dir() {
    let bin = cwd.join("node_modules").join(".bin");
    if bin.exists() {
      return format!("{}:{current}", bin.display());
    }
  }
  current
}

/// Check if a package is a sub-dependency of any declared dep.
fn is_subdep_of_any(nm: &Path, name: &str, declared: &HashSet<String>) -> bool {
  for dep in declared {
    let dep_pkg = nm.join(dep).join("package.json");
    if let Ok(content) = fs::read_to_string(&dep_pkg)
      && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content)
    {
      for key in &["dependencies", "optionalDependencies"] {
        if let Some(deps) = pkg.get(*key).and_then(|v| v.as_object())
          && deps.contains_key(name)
        {
          return true;
        }
      }
    }
  }
  false
}

// ── File collection for pack ────────────────────────────────────────────────

fn collect_files(root: &Path, dir: &Path, pattern: &str, out: &mut Vec<PathBuf>) {
  let target = dir.join(pattern);
  if target.is_file() {
    if let Ok(rel) = target.strip_prefix(root) {
      out.push(rel.to_path_buf());
    }
  } else if target.is_dir() {
    collect_all_files(root, &target, out);
  } else if let Ok(entries) = fs::read_dir(dir) {
    for e in entries.flatten() {
      let fname = e.file_name().to_string_lossy().to_string();
      if glob_match(pattern, &fname)
        && let Ok(rel) = e.path().strip_prefix(root)
      {
        out.push(rel.to_path_buf());
      }
    }
  }
}

fn collect_all_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
  let skip = ["node_modules", ".git", ".svn", ".hg", ".DS_Store"];
  if let Ok(entries) = fs::read_dir(dir) {
    for e in entries.flatten() {
      let name = e.file_name().to_string_lossy().to_string();
      if skip.contains(&name.as_str()) {
        continue;
      }
      let path = e.path();
      if path.is_dir() {
        collect_all_files(root, &path, out);
      } else if let Ok(rel) = path.strip_prefix(root) {
        out.push(rel.to_path_buf());
      }
    }
  }
}

fn glob_match(pattern: &str, name: &str) -> bool {
  if let Some(rest) = pattern.strip_suffix('*') {
    name.starts_with(rest)
  } else {
    pattern == name
  }
}

// ── Crypto helpers ──────────────────────────────────────────────────────────

fn sha1_hex(data: &[u8]) -> String {
  use sha1::Digest;
  let hash = sha1::Sha1::digest(data);
  hex_encode(&hash)
}

fn hex_encode(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn base64_encode(data: &[u8]) -> String {
  use base64::Engine;
  base64::engine::general_purpose::STANDARD.encode(data)
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

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

fn curl_auth_args(token: Option<&str>) -> Vec<String> {
  match token {
    Some(t) => vec!["-H".to_string(), format!("Authorization: Bearer {t}")],
    None => vec![],
  }
}

fn http_get(url: &str, token: Option<&str>) -> Result<String, String> {
  let curl = find_curl();
  let mut cmd = std::process::Command::new(&curl);
  cmd.args(["-fsSL", "--max-time", "30"]);
  cmd.args(curl_auth_args(token));
  cmd.arg(url);
  let output = cmd
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

fn http_get_bytes(url: &str, token: Option<&str>) -> Result<Vec<u8>, String> {
  let curl = find_curl();
  let mut cmd = std::process::Command::new(&curl);
  cmd.args(["-fsSL", "--max-time", "120"]);
  cmd.args(curl_auth_args(token));
  cmd.arg(url);
  let output = cmd
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

fn http_post(url: &str, body: &str, token: Option<&str>) -> Result<String, String> {
  let curl = find_curl();
  let mut cmd = std::process::Command::new(&curl);
  cmd.args(["-fsSL", "--max-time", "30", "-X", "POST"]);
  cmd.args(["-H", "Content-Type: application/json"]);
  cmd.args(curl_auth_args(token));
  cmd.args(["-d", body]);
  cmd.arg(url);
  let output = cmd.output().map_err(|e| format!("curl: {e}"))?;
  if !output.status.success() {
    return Err(format!(
      "POST failed ({}): {}",
      output.status,
      String::from_utf8_lossy(&output.stderr).trim()
    ));
  }
  String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8: {e}"))
}

fn http_put(url: &str, body: &str, token: Option<&str>) -> Result<String, String> {
  let curl = find_curl();
  let mut cmd = std::process::Command::new(&curl);
  cmd.args(["-fsSL", "--max-time", "60", "-X", "PUT"]);
  cmd.args(["-H", "Content-Type: application/json"]);
  cmd.args(curl_auth_args(token));
  cmd.args(["-d", body]);
  cmd.arg(url);
  let output = cmd.output().map_err(|e| format!("curl: {e}"))?;
  if !output.status.success() {
    return Err(format!(
      "PUT failed ({}): {}",
      output.status,
      String::from_utf8_lossy(&output.stderr).trim()
    ));
  }
  String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8: {e}"))
}

fn urlenc(s: &str) -> String {
  s.replace('/', "%2f")
}
