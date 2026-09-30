// Permission model: default deny, granted per-category via CLI flags.
//
//   --allow-read[=paths]   fs read/stat (paths: comma-separated prefixes)
//   --allow-write[=paths]  fs write
//   --allow-net[=hosts]    fetch + serve (hosts: comma-separated [host[:port]])
//   --allow-run[=bins]     child_process (bins: comma-separated names/paths)
//   --allow-env            process.env / op_env
//   --allow-all            everything
//
// Set once by the CLI before any runtime is created; workers inherit the
// process-global set. Module-graph loading is exempt (like Deno); runtime
// ops enforce. Unset means deny-all — tests grant explicitly.
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;

use deno_error::JsErrorBox;

/// Per-category grant: bare flag => All, `--flag=a,b` => Only([a, b]).
#[derive(Debug, Clone, Default)]
pub enum Allow<T> {
  #[default]
  Deny,
  All,
  Only(Vec<T>),
}

#[derive(Default, Debug, Clone)]
pub struct Permissions {
  pub allow_all: bool,
  pub read: Allow<PathBuf>,
  pub write: Allow<PathBuf>,
  pub net: Allow<String>,
  pub run: Allow<String>,
  pub env: bool,
}

impl Permissions {
  pub fn allow_all() -> Self {
    Self {
      allow_all: true,
      ..Default::default()
    }
  }
}

static PERMISSIONS: OnceLock<Permissions> = OnceLock::new();

pub fn set_permissions(permissions: Permissions) {
  // Idempotent under parallel tests: first grant wins.
  let _ = PERMISSIONS.set(permissions);
}

fn permissions() -> &'static Permissions {
  PERMISSIONS.get_or_init(Permissions::default)
}

fn denied(kind: &str, what: &str, flag: &str) -> JsErrorBox {
  JsErrorBox::generic(format!(
    "PermissionDenied: {kind} access to {what}, run again with {flag}"
  ))
}

/// Resolve `path` the way the kernel would: absolute, symlinks followed,
/// `.`/`..` applied. Unlike `fs::canonicalize` this also works when the tail
/// does not exist yet (a file about to be created), so `allowed/../../etc/x`
/// and dangling symlinks cannot pass a prefix check.
pub fn resolve(path: &str) -> PathBuf {
  let p = Path::new(path);
  if p.is_absolute() {
    resolve_abs(p, 0)
  } else {
    resolve_abs(&std::env::current_dir().unwrap_or_default().join(p), 0)
  }
}

fn resolve_abs(abs: &Path, depth: u32) -> PathBuf {
  let mut out = PathBuf::new();
  for c in abs.components() {
    match c {
      Component::Prefix(_) | Component::RootDir => out.push(c),
      Component::CurDir => {}
      Component::ParentDir => {
        out.pop();
      }
      Component::Normal(name) => {
        out.push(name);
        // 40 hops mirrors Linux MAXSYMLINKS; past it the OS fails with ELOOP.
        if depth < 40
          && std::fs::symlink_metadata(&out).is_ok_and(|m| m.file_type().is_symlink())
          && let Ok(target) = std::fs::read_link(&out)
        {
          out.pop();
          out = resolve_abs(&out.join(target), depth + 1);
        }
      }
    }
  }
  out
}

fn check_path(
  allowed: &Allow<PathBuf>,
  allow_all: bool,
  path: &str,
  kind: &str,
  flag: &str,
) -> Result<(), JsErrorBox> {
  if allow_all {
    return Ok(());
  }
  match allowed {
    Allow::All => Ok(()),
    Allow::Only(roots) => {
      let target = resolve(path);
      if roots.iter().any(|root| target.starts_with(root)) {
        Ok(())
      } else {
        Err(denied(kind, &format!("\"{path}\""), flag))
      }
    }
    Allow::Deny => Err(denied(kind, &format!("\"{path}\""), flag)),
  }
}

pub fn check_read(path: &str) -> Result<(), JsErrorBox> {
  let p = permissions();
  check_path(&p.read, p.allow_all, path, "read", "--allow-read")
}

pub fn check_write(path: &str) -> Result<(), JsErrorBox> {
  let p = permissions();
  check_path(&p.write, p.allow_all, path, "write", "--allow-write")
}

pub fn check_net(host: &str) -> Result<(), JsErrorBox> {
  let p = permissions();
  if p.allow_all {
    return Ok(());
  }
  // Strip a trailing :port, leaving IPv6 literals ("[::1]") intact.
  let bare = host
    .rsplit_once(':')
    .filter(|(h, port)| {
      !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && (!h.contains(':') || h.ends_with(']'))
    })
    .map_or(host, |(h, _)| h);
  let matches = |entry: &str| host == entry || bare == entry;
  match &p.net {
    Allow::All => Ok(()),
    Allow::Only(hosts) if hosts.iter().any(|h| matches(h)) => Ok(()),
    _ => Err(denied("net", &format!("\"{host}\""), "--allow-net")),
  }
}

/// Check `--allow-run` for spawning `binary` with the child's `cwd` and
/// `PATH`. With an allowlist, returns the resolved executable, which the
/// caller must spawn instead of `binary`: a bare name is looked up in the
/// child's PATH, so checking the name alone would let `env.PATH` or a file
/// named like an allowed binary slip through.
pub fn check_run(
  binary: &str,
  cwd: Option<&str>,
  path_env: Option<&str>,
) -> Result<Option<PathBuf>, JsErrorBox> {
  let p = permissions();
  if p.allow_all {
    return Ok(None);
  }
  let deny = || denied("run", &format!("\"{binary}\""), "--allow-run");
  match &p.run {
    Allow::All => Ok(None),
    Allow::Only(bins) => {
      let target = locate_program(binary, cwd, path_env).ok_or_else(deny)?;
      let process_path = std::env::var("PATH").ok();
      if bins
        .iter()
        .any(|b| locate_program(b, None, process_path.as_deref()).is_some_and(|allowed| allowed == target))
      {
        Ok(Some(target))
      } else {
        Err(deny())
      }
    }
    Allow::Deny => Err(deny()),
  }
}

/// Resolve a program name to a canonical file path: names containing a path
/// separator are taken relative to `cwd`, bare names are searched in `path_env`.
fn locate_program(program: &str, cwd: Option<&str>, path_env: Option<&str>) -> Option<PathBuf> {
  let base = || cwd.map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
  if program.contains('/') || (cfg!(windows) && program.contains('\\')) {
    return std::fs::canonicalize(base().join(program)).ok();
  }
  let exts: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat"] } else { &[""] };
  std::env::split_paths(path_env?)
    .flat_map(|dir| exts.iter().map(move |ext| dir.join(format!("{program}{ext}"))))
    .find(|cand| cand.is_file())
    .and_then(|cand| std::fs::canonicalize(base().join(cand)).ok())
}

pub fn check_env() -> Result<(), JsErrorBox> {
  let p = permissions();
  if p.allow_all || p.env {
    Ok(())
  } else {
    Err(denied("env", "environment variables", "--allow-env"))
  }
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

/// One parsed permission flag occurrence.
pub enum PermFlag {
  Read(Allow<PathBuf>),
  Write(Allow<PathBuf>),
  Net(Allow<String>),
  Run(Allow<String>),
  Env,
  All,
}

/// Parse a `--allow-*` value: bare flag => All, `--flag=a,b,c` => Only.
fn allow_list<T: From<String>>(value: Option<&str>) -> Allow<T> {
  match value {
    None => Allow::All,
    Some(v) => Allow::Only(
      v.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(T::from)
        .collect(),
    ),
  }
}

pub fn parse_flag(flag: &str, value: Option<&str>) -> Option<PermFlag> {
  match flag {
    "allow-read" => Some(PermFlag::Read(allow_list::<String>(value).map_paths())),
    "allow-write" => Some(PermFlag::Write(allow_list::<String>(value).map_paths())),
    "allow-net" => Some(PermFlag::Net(allow_list(value))),
    "allow-run" => Some(PermFlag::Run(allow_list(value))),
    "allow-env" => Some(PermFlag::Env),
    "allow-all" => Some(PermFlag::All),
    _ => None,
  }
}

impl Allow<String> {
  fn map_paths(self) -> Allow<PathBuf> {
    match self {
      Allow::Deny => Allow::Deny,
      Allow::All => Allow::All,
      Allow::Only(paths) => Allow::Only(paths.iter().map(|p| resolve(p)).collect()),
    }
  }
}

/// Build a Permissions from parsed flags. Defaults to deny-all.
pub fn from_flags(flags: Vec<PermFlag>) -> Permissions {
  let mut p = Permissions::default();
  for flag in flags {
    match flag {
      PermFlag::Read(v) => p.read = v,
      PermFlag::Write(v) => p.write = v,
      PermFlag::Net(v) => p.net = v,
      PermFlag::Run(v) => p.run = v,
      PermFlag::Env => p.env = true,
      PermFlag::All => p.allow_all = true,
    }
  }
  p
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolve_applies_dotdot_to_missing_paths() {
    let base = resolve(&std::env::temp_dir().to_string_lossy());
    let p = base.join("jse-no-such-dir/../../escape");
    assert_eq!(resolve(p.to_str().unwrap()), base.parent().unwrap().join("escape"));
  }

  #[cfg(unix)]
  #[test]
  fn resolve_follows_dangling_symlinks() {
    let dir = std::env::temp_dir().join(format!("jse-resolve-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let link = dir.join("link");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink("/nonexistent-target/file", &link).unwrap();
    assert_eq!(resolve(link.to_str().unwrap()), PathBuf::from("/nonexistent-target/file"));
    let _ = std::fs::remove_dir_all(&dir);
  }
}
