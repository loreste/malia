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

fn canonical(path: &str) -> PathBuf {
  std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
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
      let target = canonical(path);
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
  let matches = |entry: &str| {
    host == entry || host.split_once(':').is_some_and(|(h, _)| h == entry)
  };
  match &p.net {
    Allow::All => Ok(()),
    Allow::Only(hosts) if hosts.iter().any(|h| matches(h)) => Ok(()),
    _ => Err(denied("net", &format!("\"{host}\""), "--allow-net")),
  }
}

pub fn check_run(binary: &str) -> Result<(), JsErrorBox> {
  let p = permissions();
  if p.allow_all {
    return Ok(());
  }
  let name = Path::new(binary)
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| binary.to_string());
  match &p.run {
    Allow::All => Ok(()),
    Allow::Only(bins) if bins.iter().any(|b| b == binary || *b == name) => Ok(()),
    _ => Err(denied("run", &format!("\"{binary}\""), "--allow-run")),
  }
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
      Allow::Only(paths) => Allow::Only(paths.iter().map(|p| canonical(p)).collect()),
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
