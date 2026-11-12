// jse CLI: `jse run <file>`, `jse init`, `jse start`, `jse dev`, `jse test`, `jse config`, `jse build`, bare `jse` = auto-run/REPL.
use clap::Args;
use clap::Parser;
use clap::Subcommand;
use std::path::{Path, PathBuf};

const STANDALONE_MAGIC: &[u8; 17] = b"__JSE_BUNDLE_V2__";

#[derive(Parser)]
#[command(
  name = "malia",
  alias = "jse",
  disable_version_flag = true,
  about = "A JavaScript/TypeScript and WebAssembly runtime built in Rust"
)]
struct Cli {
  /// Print version (-v, -V, --version).
  #[arg(short = 'v', short_alias = 'V', long = "version", action = clap::ArgAction::SetTrue, global = true)]
  version: bool,

  /// Select Wasm-related runtime options; JavaScript remains V8-executed source.
  #[arg(long, global = true)]
  wasm: bool,

  /// Output path for compiled binary.
  #[arg(short, long, global = true)]
  output: Option<String>,

  /// Preload the specified module at startup (-r / --require <module>).
  #[arg(short = 'r', long = "require", global = true)]
  require: Vec<String>,

  /// Preload the specified ES module at startup (--import <module>).
  #[arg(long = "import", global = true)]
  import: Vec<String>,

  /// Evaluate the given string (-e / --eval <code>).
  #[arg(short = 'e', long = "eval", global = true)]
  eval: Option<String>,

  /// Evaluate the given string and print the result (-p / --print <code>).
  #[arg(short = 'p', long = "print", global = true)]
  print: Option<String>,

  /// Silence warnings (Node.js compatibility).
  #[arg(long = "no-warnings", global = true)]
  no_warnings: bool,

  /// Silence deprecation warnings (Node.js compatibility).
  #[arg(long = "no-deprecation", global = true)]
  no_deprecation: bool,

  /// Trace deprecation warnings (Node.js compatibility).
  #[arg(long = "trace-deprecation", global = true)]
  trace_deprecation: bool,

  /// Trace warnings (Node.js compatibility).
  #[arg(long = "trace-warnings", global = true)]
  trace_warnings: bool,

  /// Enable source maps (Node.js compatibility).
  #[arg(long = "enable-source-maps", global = true)]
  enable_source_maps: bool,

  /// Experimental ES modules (Node.js compatibility).
  #[arg(long = "experimental-modules", global = true)]
  experimental_modules: bool,

  /// Experimental VM modules (Node.js compatibility).
  #[arg(long = "experimental-vm-modules", global = true)]
  experimental_vm_modules: bool,

  /// Expose garbage collector (Node.js compatibility).
  #[arg(long = "expose-gc", global = true)]
  expose_gc: bool,

  /// Activate V8 inspector (default 127.0.0.1:9229).
  #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "127.0.0.1:9229", global = true)]
  inspect: Option<String>,

  /// Activate V8 inspector and break before user code starts.
  #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "127.0.0.1:9229", global = true)]
  inspect_brk: Option<String>,

  /// Check syntax without executing (-c / --check).
  #[arg(short = 'c', long = "check", global = true)]
  check: bool,

  /// Interactive mode / REPL (-i / --interactive).
  #[arg(short = 'i', long = "interactive", global = true)]
  interactive: bool,

  /// Custom module loader (Node.js compatibility).
  #[arg(long = "loader", global = true)]
  loader: Option<String>,

  /// Process title (Node.js compatibility).
  #[arg(long = "title", global = true)]
  title: Option<String>,

  /// Unhandled rejections behavior (Node.js compatibility).
  #[arg(long = "unhandled-rejections", global = true)]
  unhandled_rejections: Option<String>,

  /// DNS result order (Node.js compatibility).
  #[arg(long = "dns-result-order", global = true)]
  dns_result_order: Option<String>,

  /// Max old space size in MB (Node.js compatibility).
  #[arg(long = "max-old-space-size", global = true)]
  max_old_space_size: Option<u64>,

  #[command(subcommand)]
  command: Option<Command>,
}

#[derive(Args, Clone, Default)]
pub struct PermissionArgs {
  /// Allow filesystem reads [optionally restricted to =path1,path2].
  #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "*")]
  allow_read: Option<String>,
  /// Allow filesystem writes [optionally restricted to =path1,path2].
  #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "*")]
  allow_write: Option<String>,
  /// Allow network access (fetch/serve) [optionally restricted to =host1,host2].
  #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "*")]
  allow_net: Option<String>,
  /// Allow spawning subprocesses [optionally restricted to =bin1,bin2].
  #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "*")]
  allow_run: Option<String>,
  /// Allow reading environment variables.
  #[arg(long)]
  allow_env: bool,
  /// Allow everything.
  #[arg(long, alias = "allow-all")]
  allow_all: bool,
}

impl PermissionArgs {
  fn is_empty(&self) -> bool {
    self.allow_read.is_none()
      && self.allow_write.is_none()
      && self.allow_net.is_none()
      && self.allow_run.is_none()
      && !self.allow_env
      && !self.allow_all
  }

  fn build(&self) -> js_engine::permissions::Permissions {
    use js_engine::permissions::PermFlag;
    let mut flags = Vec::new();
    let mut push = |name: &str, value: &Option<String>| {
      if let Some(v) = value {
        let parsed = js_engine::permissions::parse_flag(name, if v == "*" { None } else { Some(v) });
        if let Some(parsed) = parsed {
          flags.push(parsed);
        }
      }
    };
    push("allow-read", &self.allow_read);
    push("allow-write", &self.allow_write);
    push("allow-net", &self.allow_net);
    push("allow-run", &self.allow_run);
    if self.allow_env {
      flags.push(PermFlag::Env);
    }
    if self.allow_all {
      flags.push(PermFlag::All);
    }
    js_engine::permissions::from_flags(flags)
  }
}

#[derive(Subcommand)]
enum ConfigAction {
  /// Show full resolved configuration and active environment.
  Show,
  /// Get a specific configuration key (e.g., entry, env.PORT, permissions).
  Get { key: String },
}

#[derive(Subcommand)]
enum Command {
  /// Run a JavaScript or TypeScript file, or a script from jse.json / package.json.
  Run {
    /// Path to the main module or script name (default: auto-detected from jse.json).
    file: Option<String>,
    /// Watch file for changes and automatically reload.
    #[arg(short, long)]
    watch: bool,
    #[command(flatten)]
    permissions: PermissionArgs,
    /// Arguments exposed to the script as process.argv[2..].
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Initialize a new project with a jse.json or jse.toml configuration.
  Init {
    /// Force overwrite if config file already exists.
    #[arg(short, long)]
    force: bool,
    /// Generate jse.toml instead of jse.json.
    #[arg(long)]
    toml: bool,
  },
  /// Start the project using jse.json entry or start script (with auto-clustering if configured).
  Start {
    #[command(flatten)]
    permissions: PermissionArgs,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Run the project in development mode with automatic reload on file changes.
  Dev {
    #[command(flatten)]
    permissions: PermissionArgs,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Run test script or test files.
  Test {
    #[command(flatten)]
    permissions: PermissionArgs,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Install npm dependencies or add packages (`jse install`, `jse add express`, `jse i lodash`).
  #[command(alias = "i", alias = "add")]
  Install {
    /// Package names to install (empty to install all dependencies from package.json).
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    packages: Vec<String>,
    /// Save as development dependency (-D / --save-dev).
    #[arg(short = 'D', long)]
    save_dev: bool,
    /// Install globally (-g / --global).
    #[arg(short = 'g', long)]
    global: bool,
  },
  /// Remove packages from node_modules and package.json.
  #[command(alias = "rm", alias = "remove", alias = "un")]
  Uninstall {
    /// Package names to remove.
    #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
    packages: Vec<String>,
    /// Remove a global package (-g / --global).
    #[arg(short = 'g', long)]
    global: bool,
  },
  /// List installed packages.
  #[command(alias = "ls")]
  List {
    /// Show all levels of dependency tree.
    #[arg(long)]
    all: bool,
    /// List globally installed packages.
    #[arg(short = 'g', long)]
    global: bool,
  },
  /// Symlink a local package into node_modules or globally.
  Link {
    /// Path to the package directory to link (omit to link current package globally).
    target: Option<String>,
  },
  /// Check installed packages for known vulnerabilities.
  Audit,
  /// Create a tarball from the current package.
  Pack,
  /// Publish the current package to the npm registry.
  Publish {
    /// Distribution tag (default: latest).
    #[arg(long)]
    tag: Option<String>,
  },
  /// Show packages with newer versions available.
  Outdated,
  /// Manage the package download cache.
  Cache {
    /// Subcommand: clean, ls.
    action: Option<String>,
  },
  /// Execute a local package binary from node_modules/.bin or via npx (`jse x prettier`, `jse x prisma`).
  #[command(alias = "dlx", alias = "exec")]
  X {
    /// Command or binary name to execute.
    command: String,
    /// Arguments passed to the binary.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Run npm directly with full arguments passthrough (`jse npm install`, `jse npm audit`).
  Npm {
    /// Arguments passed to npm.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Inspect and display the active configuration and environment.
  Config {
    #[command(subcommand)]
    action: Option<ConfigAction>,
  },
  /// Embed entry source in a host-platform runtime executable (dependencies and assets are not bundled).
  Build {
    /// Path to the main module (default: entry from jse.json).
    file: Option<String>,
    /// Output executable binary path.
    #[arg(short, long)]
    output: Option<String>,
    /// Embed entry source in the current runtime executable (default: true).
    #[arg(long, default_value_t = true)]
    standalone: bool,
  },
  /// Embed entry source in a host runtime executable or Malia-specific Wasm source container.
  Compile {
    /// Path to the main module (.js, .ts, .mjs, .cjs).
    file: String,
    /// Create a Malia source container, not portable JS-to-Wasm compilation.
    #[arg(long)]
    wasm: bool,
    /// Embed entry source for the host platform; dependencies and assets remain external.
    #[arg(long)]
    standalone: bool,
    /// Output file path (default: dist/<file> or <file>.wasm).
    #[arg(short, long)]
    output: Option<String>,
  },
  /// Run a file and report wall-clock execution time.
  Bench {
    file: String,
    #[command(flatten)]
    permissions: PermissionArgs,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Start the interactive REPL.
  Repl,
  /// Evaluate a snippet as an ES module (`process.argv` is `["jse", "-e", ...]`).
  Eval {
    /// Source to evaluate.
    code: String,
    #[command(flatten)]
    permissions: PermissionArgs,
    /// Arguments exposed to the snippet as process.argv[2..].
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
  },
  /// Diagnose project health: deps, security, config, versions.
  Doctor,
  /// Start a static file server for a directory.
  Serve {
    /// Directory to serve (default: current directory).
    dir: Option<String>,
    /// Port to listen on (default: 3000).
    #[arg(long, default_value = "3000")]
    port: u16,
    /// Bind address (default: 0.0.0.0).
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
  },
  /// Remove node_modules, caches, and temp files.
  Clean {
    /// Also remove the global cache (~/.malia/cache).
    #[arg(long)]
    all: bool,
  },
  /// Self-update malia to the latest version.
  Upgrade,
  /// Show resolved environment variables from .env files and config.
  Env,
  /// Scan source code for security vulnerabilities (XSS, injection, secrets).
  Scan {
    /// Files or directories to scan (default: current directory).
    #[arg(default_value = ".")]
    path: String,
  },
  /// Show what permissions a script needs before running it.
  Permissions {
    /// File to analyze.
    file: String,
  },
  /// Generate a Software Bill of Materials (SBOM) in CycloneDX JSON format.
  Sbom,
  /// Scan for leaked secrets, API keys, and credentials in source files.
  Secrets {
    /// Directory to scan (default: current directory).
    #[arg(default_value = ".")]
    path: String,
  },
  /// Show full dependency tree with license and maintainer info.
  Deps {
    /// Show full tree (not just top-level).
    #[arg(long)]
    tree: bool,
    /// Show license info.
    #[arg(long)]
    licenses: bool,
  },
  /// Generate production deployment files (Dockerfile, docker-compose.yml, systemd service).
  Deploy {
    /// Target: docker, compose, systemd, all (default: all).
    #[arg(default_value = "all")]
    target: String,
  },
  /// CPU and memory profiling.
  Profile {
    /// File to profile.
    file: String,
    /// Duration in seconds (default: 10).
    #[arg(long, default_value = "10")]
    duration: u32,
    #[command(flatten)]
    permissions: PermissionArgs,
  },
  /// Database migration runner.
  Migrate {
    /// Subcommand: up, down, create <name>, status.
    action: String,
    /// Migration name (for create).
    name: Option<String>,
  },
  /// Encrypt or decrypt .env files for safe git storage.
  #[command(name = "env-encrypt")]
  EnvEncrypt {
    /// Action: encrypt, decrypt.
    action: String,
    /// Encryption key (or set MALIA_ENV_KEY).
    #[arg(long)]
    key: Option<String>,
  },
  /// Run custom scripts defined in jse.json / package.json or execute files directly.
  #[command(external_subcommand)]
  Custom(Vec<String>),
}

/// Run a program on a blocking thread, then exit with its process.exitCode
/// if non-zero.
async fn supervise<F>(f: F) -> anyhow::Result<()>
where
  F: FnOnce() -> anyhow::Result<()> + Send + 'static,
{
  tokio::task::spawn_blocking(f).await??;
  let code = js_engine::runtime::exit_code();
  if code != 0 {
    std::process::exit(code);
  }
  Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EmbeddedApplication {
  version: u32,
  source: String,
  permissions: js_engine::permissions::Permissions,
}

fn check_standalone_binary() -> anyhow::Result<Option<EmbeddedApplication>> {
  use std::io::{Read, Seek, SeekFrom};
  let mut file = std::fs::File::open(std::env::current_exe()?)?;
  let length = file.metadata()?.len();
  if length < 25 {
    return Ok(None);
  }
  file.seek(SeekFrom::End(-25))?;
  let mut trailer = [0u8; 25];
  file.read_exact(&mut trailer)?;
  anyhow::ensure!(
    &trailer[8..] != b"__JSE_BUNDLE_V1__",
    "legacy entry embedding has no permission manifest; rebuild it"
  );
  if &trailer[8..] != STANDALONE_MAGIC {
    return Ok(None);
  }
  let payload_len = u64::from_le_bytes(trailer[..8].try_into()?);
  anyhow::ensure!(
    payload_len <= 16 * 1024 * 1024 && payload_len <= length - 25,
    "invalid embedded payload length"
  );
  file.seek(SeekFrom::Start(length - 25 - payload_len))?;
  let mut bytes = vec![0; payload_len as usize];
  file.read_exact(&mut bytes)?;
  let app: EmbeddedApplication = serde_json::from_slice(&bytes)?;
  anyhow::ensure!(app.version == 2, "unsupported embedded application version");
  Ok(Some(app))
}

fn create_standalone_binary(entry_path: &Path, output_path: &Path) -> anyhow::Result<()> {
  // Windows only runs files with an executable extension.
  let with_exe;
  let output_path = if cfg!(windows) && output_path.extension().is_none() {
    with_exe = output_path.with_extension("exe");
    with_exe.as_path()
  } else {
    output_path
  };
  let current_exe = std::env::current_exe()?;
  let exe_bytes = std::fs::read(&current_exe)?;

  let raw_code = std::fs::read_to_string(entry_path)?;
  let media_type = deno_ast::MediaType::from_path(entry_path);
  let code = if js_engine::ts::should_transpile(&media_type) {
    let spec = deno_core::ModuleSpecifier::from_file_path(
      entry_path.canonicalize().unwrap_or_else(|_| entry_path.to_path_buf()),
    )
    .unwrap_or_else(|_| deno_core::ModuleSpecifier::parse("file:///app.ts").unwrap());
    let (js, _) = js_engine::ts::transpile(&spec, media_type, raw_code)?;
    js
  } else {
    raw_code
  };

  if let Some(parent) = output_path.parent()
    && !parent.as_os_str().is_empty()
  {
    std::fs::create_dir_all(parent)?;
  }

  let config = js_engine::config::JseConfig::discover(&std::env::current_dir()?)?;
  let permissions = match config {
    Some((_, config)) => config.build_permissions()?.unwrap_or_default(),
    None => js_engine::permissions::Permissions::default(),
  };
  eprintln!(
    "Entry-source embedding only: dependencies, workers and assets remain external; host platform only. Permissions: {}",
    if permissions.allow_all {
      "explicit allow-all"
    } else {
      "restricted manifest"
    }
  );
  let payload = serde_json::to_vec(&EmbeddedApplication {
    version: 2,
    source: code,
    permissions,
  })?;
  anyhow::ensure!(payload.len() <= 16 * 1024 * 1024, "embedded source exceeds 16 MiB");
  let code_bytes = payload.as_slice();
  let code_len = (code_bytes.len() as u64).to_le_bytes();

  let mut out = Vec::with_capacity(exe_bytes.len() + code_bytes.len() + 25);
  out.extend_from_slice(&exe_bytes);
  out.extend_from_slice(code_bytes);
  out.extend_from_slice(&code_len);
  out.extend_from_slice(STANDALONE_MAGIC);

  std::fs::write(output_path, &out)?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(output_path, std::fs::Permissions::from_mode(0o755));
  }

  println!("✓ Standalone binary created successfully: {}", output_path.display());
  Ok(())
}

fn detect_package_manager(base_dir: &Path) -> &'static str {
  let mut cur = Some(base_dir);
  while let Some(d) = cur {
    if d.join("pnpm-lock.yaml").is_file() {
      return "pnpm";
    }
    if d.join("yarn.lock").is_file() {
      return "yarn";
    }
    if d.join("bun.lockb").is_file() || d.join("bun.lock").is_file() {
      return "bun";
    }
    if d.join("package-lock.json").is_file() {
      return "npm";
    }
    cur = d.parent();
  }
  "npm"
}

fn find_local_bin(start_dir: &Path, bin_name: &str) -> Option<PathBuf> {
  if bin_name.contains('/') || bin_name.contains('\\') {
    return None;
  }
  let mut cur = Some(start_dir);
  while let Some(d) = cur {
    let bin_dir = d.join("node_modules").join(".bin");
    // On Windows npm writes a .cmd shim next to an extensionless shell
    // script that Windows cannot execute, so the shims come first.
    #[cfg(windows)]
    for ext in ["cmd", "exe"] {
      let candidate = bin_dir.join(format!("{bin_name}.{ext}"));
      if candidate.is_file() {
        return Some(candidate);
      }
    }
    let exact = bin_dir.join(bin_name);
    if exact.is_file() {
      return Some(exact);
    }
    cur = d.parent();
  }
  None
}

fn run_with_watch(
  tokio_rt: &tokio::runtime::Runtime,
  file: &str,
  permissions: js_engine::permissions::Permissions,
  args: &[String],
) -> anyhow::Result<()> {
  println!("[jse:watch] Watching {} for changes...", file);
  let target_path = PathBuf::from(file);
  let mut last_mtime = std::fs::metadata(&target_path).and_then(|m| m.modified()).ok();

  loop {
    let f = file.to_string();
    let a = args.to_vec();
    let p = permissions.clone();

    js_engine::permissions::set_permissions(p);
    js_engine::ops::set_argv(make_argv(&f, &a));

    // Not supervise(): a non-zero exit code must not end the watcher.
    let result = tokio_rt
      .block_on(async move { tokio::task::spawn_blocking(move || js_engine::runtime::run_file_blocking(&f)).await })
      .map_err(anyhow::Error::from)
      .and_then(|r| r);
    if let Err(e) = result {
      eprintln!("[jse:watch] Execution error: {e:#}");
    }

    println!("[jse:watch] Waiting for file changes...");
    loop {
      std::thread::sleep(std::time::Duration::from_millis(300));
      let cur_mtime = std::fs::metadata(&target_path).and_then(|m| m.modified()).ok();
      if cur_mtime != last_mtime {
        last_mtime = cur_mtime;
        println!("\n[jse:watch] Change detected in {}, reloading...", file);
        break;
      }
    }
  }
}

async fn supervise_cluster(entry: PathBuf, workers: usize, args: Vec<String>) -> anyhow::Result<()> {
  println!("[jse:cluster] Spawning {workers} cluster workers across available CPU cores...");
  let current_exe = std::env::current_exe()?;
  let mut children: Vec<(usize, std::process::Child)> = Vec::new();

  for id in 1..=workers {
    let mut cmd = std::process::Command::new(&current_exe);
    cmd.arg("run");
    cmd.arg(&entry);
    cmd.args(&args);
    cmd.env("NODE_UNIQUE_ID", id.to_string());
    let child = cmd.spawn()?;
    children.push((id, child));
  }

  loop {
    tokio::select! {
      _ = tokio::signal::ctrl_c() => {
        println!("\n[jse:cluster] Shutting down cluster workers...");
        for (_, mut child) in children {
          let _ = child.kill();
        }
        break;
      }
      _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
        for (id, child) in &mut children {
          if let Ok(Some(status)) = child.try_wait() {
            println!("[jse:cluster] Worker {id} exited ({status}). Respawning...");
            let mut cmd = std::process::Command::new(&current_exe);
            cmd.arg("run");
            cmd.arg(&entry);
            cmd.args(&args);
            cmd.env("NODE_UNIQUE_ID", id.to_string());
            if let Ok(new_child) = cmd.spawn() {
              *child = new_child;
            }
          }
        }
      }
    }
  }
  Ok(())
}

/// Run an external tool with inherited stdio; returns its exit code.
/// Package-manager launchers are .cmd scripts on Windows, and Command only
/// tries appending .exe.
/// Load .env files automatically. Order (later overrides earlier):
///   .env, .env.local, .env.<NODE_ENV>, .env.<NODE_ENV>.local
/// Only sets vars that aren't already in the environment (existing vars win).
fn chrono_now() -> String {
  // ISO 8601 timestamp without chrono crate
  let secs = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs();
  // Rough conversion -- good enough for SBOM timestamps
  let days = secs / 86400;
  let time_of_day = secs % 86400;
  let hours = time_of_day / 3600;
  let minutes = (time_of_day % 3600) / 60;
  let seconds = time_of_day % 60;
  // Days since epoch to date (simplified)
  let mut y = 1970u64;
  let mut remaining = days;
  loop {
    let leap = y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
    let year_days = if leap { 366 } else { 365 };
    if remaining < year_days {
      break;
    }
    remaining -= year_days;
    y += 1;
  }
  let leap = y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
  let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let mut m = 0;
  for md in &month_days {
    if remaining < *md {
      break;
    }
    remaining -= md;
    m += 1;
  }
  format!(
    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
    y,
    m + 1,
    remaining + 1,
    hours,
    minutes,
    seconds
  )
}

fn rand_bytes(n: usize) -> Vec<u8> {
  let mut buf = vec![0u8; n];
  getrandom::fill(&mut buf).expect("getrandom failed");
  buf
}

fn hex_encode_bytes(b: &[u8]) -> String {
  b.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Vec<u8> {
  (0..s.len())
    .step_by(2)
    .filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
    .collect()
}

fn encrypt_aes256(plaintext: &[u8], key_hex: &str) -> Vec<u8> {
  use ring::aead;
  let key_bytes = hex_decode(key_hex);
  let key_bytes = if key_bytes.len() >= 32 {
    &key_bytes[..32]
  } else {
    // Pad short keys with SHA-256
    let h = ring::digest::digest(&ring::digest::SHA256, key_hex.as_bytes());
    return encrypt_aes256(plaintext, &hex_encode_bytes(h.as_ref()));
  };
  let key = aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes).expect("bad key");
  let nonce_bytes = rand_bytes(12);
  let mut in_out = plaintext.to_vec();
  let nonce = aead::Nonce::try_assume_unique_for_key(&nonce_bytes).unwrap();
  let sealing_key = aead::LessSafeKey::new(key);
  sealing_key
    .seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut in_out)
    .expect("encryption failed");
  // Output: nonce (12) + ciphertext + tag
  let mut out = nonce_bytes;
  out.extend_from_slice(&in_out);
  out
}

fn decrypt_aes256(data: &[u8], key_hex: &str) -> Result<Vec<u8>, String> {
  use ring::aead;
  if data.len() < 12 + 16 {
    return Err("data too short".into());
  }
  let key_bytes = hex_decode(key_hex);
  let key_bytes_slice = if key_bytes.len() >= 32 {
    key_bytes[..32].to_vec()
  } else {
    let h = ring::digest::digest(&ring::digest::SHA256, key_hex.as_bytes());
    h.as_ref().to_vec()
  };
  let key = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes_slice).map_err(|e| format!("{e}"))?;
  let nonce = aead::Nonce::try_assume_unique_for_key(&data[..12]).map_err(|e| format!("{e}"))?;
  let mut ciphertext = data[12..].to_vec();
  let opening_key = aead::LessSafeKey::new(key);
  let plaintext = opening_key
    .open_in_place(nonce, aead::Aad::empty(), &mut ciphertext)
    .map_err(|_| "decryption failed (wrong key?)")?;
  Ok(plaintext.to_vec())
}

fn dir_size(path: &Path) -> u64 {
  let mut total = 0;
  if let Ok(entries) = std::fs::read_dir(path) {
    for entry in entries.flatten() {
      let p = entry.path();
      if p.is_dir() {
        total += dir_size(&p);
      } else if let Ok(meta) = p.metadata() {
        total += meta.len();
      }
    }
  }
  total
}

fn load_dotenv(dir: &Path) {
  let node_env = std::env::var("NODE_ENV").unwrap_or_default();
  let files: Vec<PathBuf> = [
    Some(".env".to_string()),
    Some(".env.local".to_string()),
    if !node_env.is_empty() {
      Some(format!(".env.{node_env}"))
    } else {
      None
    },
    if !node_env.is_empty() {
      Some(format!(".env.{node_env}.local"))
    } else {
      None
    },
  ]
  .into_iter()
  .flatten()
  .map(|f| dir.join(f))
  .collect();

  for file in &files {
    if let Ok(content) = std::fs::read_to_string(file) {
      for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
          continue;
        }
        if let Some((key, val)) = line.split_once('=') {
          let key = key.trim();
          let val = val.trim();
          // Strip surrounding quotes
          let val = if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
            &val[1..val.len() - 1]
          } else {
            val
          };
          // Only set if not already present (existing env wins)
          if std::env::var(key).is_err() {
            // Safety: called once at startup before any threads are spawned.
            unsafe { std::env::set_var(key, val) };
          }
        }
      }
    }
  }
}

fn tool_program(program: &str) -> String {
  match program {
    "npm" | "npx" | "yarn" | "pnpm" if cfg!(windows) => format!("{program}.cmd"),
    _ => program.to_string(),
  }
}

/// Run a command, printing a clear error if the binary is missing or fails to start.
fn exec_cmd(cmd: &mut std::process::Command) -> anyhow::Result<i32> {
  match cmd.status() {
    Ok(s) => Ok(s.code().unwrap_or(0)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      let prog = format!("{:?}", cmd.get_program());
      eprintln!("error: command not found: {}", prog.trim_matches('"'));
      eprintln!("Make sure it is installed and available on your PATH.");
      Ok(127)
    }
    Err(e) => {
      let prog = format!("{:?}", cmd.get_program());
      eprintln!("error: failed to run {}: {e}", prog.trim_matches('"'));
      Ok(1)
    }
  }
}

/// Handle invocation as `npm` -- translate npm commands to built-in operations.
fn run_as_npm(args: &[String]) -> anyhow::Result<()> {
  let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
  let sub = args.first().map(String::as_str).unwrap_or("help");

  // Collect flags
  let global = args.iter().any(|a| a == "-g" || a == "--global");
  let save_dev = args.iter().any(|a| a == "-D" || a == "--save-dev");
  let _save_exact = args.iter().any(|a| a == "-E" || a == "--save-exact");
  let _save_optional = args.iter().any(|a| a == "-O" || a == "--save-optional");
  let _production = args.iter().any(|a| a == "--production" || a == "--omit=dev");
  // --prefix support
  let prefix_dir = args.windows(2).find_map(|w| {
    if w[0] == "--prefix" {
      Some(PathBuf::from(&w[1]))
    } else {
      None
    }
  });
  let current_dir = prefix_dir.unwrap_or(current_dir);
  let packages: Vec<String> = args
    .iter()
    .skip(1) // skip the subcommand
    .filter(|a| !a.starts_with('-'))
    .filter(|a| {
      // Skip the value that follows --prefix
      !args.windows(2).any(|w| w[0] == "--prefix" && w[1] == **a)
    })
    .cloned()
    .collect();

  match sub {
    "install" | "i" | "add" | "ci" => {
      if global {
        if packages.is_empty() {
          eprintln!("error: --global requires at least one package name");
          std::process::exit(1);
        }
        if let Err(e) = js_engine::pkg::install_global(&packages) {
          eprintln!("error: {e}");
          std::process::exit(1);
        }
      } else if packages.is_empty() {
        if let Err(e) = js_engine::pkg::install_all(&current_dir) {
          eprintln!("error: {e}");
          std::process::exit(1);
        }
      } else if let Err(e) = js_engine::pkg::install_packages(&current_dir, &packages, save_dev) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "uninstall" | "un" | "remove" | "rm" => {
      if packages.is_empty() {
        eprintln!("error: must provide a package name to remove");
        std::process::exit(1);
      }
      let result = if global {
        js_engine::pkg::uninstall_global(&packages)
      } else {
        js_engine::pkg::uninstall(&current_dir, &packages)
      };
      if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "ls" | "list" => {
      let all = args.iter().any(|a| a == "--all");
      if let Err(e) = js_engine::pkg::list_packages(&current_dir, all, global) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "init" | "create" => {
      let init_json = serde_json::json!({
        "name": current_dir.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or("project".into()),
        "version": "1.0.0",
        "description": "",
        "main": "index.js",
        "scripts": {
          "test": "echo \"Error: no test specified\" && exit 1",
          "start": "malia run index.js"
        },
        "keywords": [],
        "license": "ISC"
      });
      let pkg_path = current_dir.join("package.json");
      if pkg_path.exists()
        && !args
          .iter()
          .any(|a| a == "-y" || a == "--yes" || a == "-f" || a == "--force")
      {
        eprintln!("package.json already exists. Use -y to overwrite.");
        std::process::exit(1);
      }
      let json = serde_json::to_string_pretty(&init_json).unwrap();
      std::fs::write(&pkg_path, format!("{json}\n"))
        .map_err(|e| format!("Cannot write package.json: {e}"))
        .unwrap();
      println!("Wrote {}", pkg_path.display());
    }
    "run" | "run-script" => {
      if let Some(script) = packages.first() {
        // Re-exec as malia run <script>
        let code = exec_cmd(
          std::process::Command::new(std::env::current_exe()?)
            .arg("run")
            .arg("--allow-all")
            .arg(script)
            .args(&packages[1..]),
        )?;
        std::process::exit(code);
      } else {
        eprintln!("Usage: npm run <script>");
        std::process::exit(1);
      }
    }
    "test" | "t" => {
      let code = exec_cmd(
        std::process::Command::new(std::env::current_exe()?)
          .arg("test")
          .arg("--allow-all")
          .args(&packages),
      )?;
      std::process::exit(code);
    }
    "start" => {
      let code = exec_cmd(
        std::process::Command::new(std::env::current_exe()?)
          .arg("start")
          .arg("--allow-all")
          .args(&packages),
      )?;
      std::process::exit(code);
    }
    "link" | "ln" => {
      let target = packages.first().map(|s| s.as_str());
      if let Err(e) = js_engine::pkg::link_local(&current_dir, target) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "audit" => {
      if let Err(e) = js_engine::pkg::audit(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "pack" => {
      if let Err(e) = js_engine::pkg::pack(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "publish" => {
      let tag = args
        .iter()
        .find_map(|a| a.strip_prefix("--tag=").map(String::from))
        .or_else(|| {
          args
            .windows(2)
            .find_map(|w| if w[0] == "--tag" { Some(w[1].clone()) } else { None })
        });
      if let Err(e) = js_engine::pkg::publish(&current_dir, tag.as_deref()) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "outdated" => {
      if let Err(e) = js_engine::pkg::outdated(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "cache" => {
      let action = packages.first().map(|s| s.as_str());
      let result = match action {
        Some("clean") | Some("clear") => js_engine::pkg::cache_clean(),
        Some("ls") | Some("list") | None => js_engine::pkg::cache_list(),
        Some(other) => Err(format!("Unknown cache action: {other}. Use: clean, ls")),
      };
      if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "update" | "up" | "upgrade" => {
      // Update = outdated check + reinstall
      if packages.is_empty() {
        // Update all
        if let Err(e) = js_engine::pkg::install_all(&current_dir) {
          eprintln!("error: {e}");
          std::process::exit(1);
        }
      } else if let Err(e) = js_engine::pkg::install_packages(&current_dir, &packages, false) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "info" | "view" | "show" => {
      if let Some(name) = packages.first() {
        if let Err(e) = js_engine::pkg::info(name) {
          eprintln!("error: {e}");
          std::process::exit(1);
        }
      } else {
        eprintln!("Usage: npm info <package>");
        std::process::exit(1);
      }
    }
    "prune" => {
      if let Err(e) = js_engine::pkg::prune(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "dedupe" | "ddp" => {
      if let Err(e) = js_engine::pkg::dedupe(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "fund" => {
      if let Err(e) = js_engine::pkg::fund(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "whoami" => {
      if let Err(e) = js_engine::pkg::whoami() {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
    }
    "prefix" => {
      let val = if global {
        let home = std::env::var("HOME")
          .or_else(|_| std::env::var("USERPROFILE"))
          .unwrap_or_else(|_| "/tmp".into());
        format!("{home}/.malia")
      } else {
        js_engine::pkg::prefix(&current_dir)
      };
      println!("{val}");
    }
    "root" => {
      println!("{}", js_engine::pkg::root(&current_dir, global));
    }
    "exec" => {
      // npm exec <cmd> -> malia x <cmd>
      if let Some(cmd) = packages.first() {
        let pkg_args: Vec<String> = packages[1..].to_vec();
        let cd = current_dir.clone();
        std::process::exit(run_package_bin(&cd, cmd, &pkg_args)?);
      } else {
        eprintln!("Usage: npm exec <command>");
        std::process::exit(1);
      }
    }
    "rebuild" | "rb" => {
      // Rebuild = re-run install scripts for all installed packages
      let nm = current_dir.join("node_modules");
      if nm.exists()
        && let Ok(entries) = std::fs::read_dir(&nm)
      {
        for entry in entries.flatten() {
          if entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            // re-run install/postinstall scripts
            js_engine::pkg::run_lifecycle_script_pub(&entry.path(), "install");
            js_engine::pkg::run_lifecycle_script_pub(&entry.path(), "postinstall");
          }
        }
      }
      println!("Rebuild complete.");
    }
    "config" | "c" | "set" | "get" => {
      // Basic config support
      let action = if sub == "set" || sub == "get" {
        sub
      } else {
        packages.first().map(|s| s.as_str()).unwrap_or("list")
      };
      match action {
        "list" | "ls" => {
          println!(
            "registry = {}",
            std::env::var("NPM_REGISTRY").unwrap_or_else(|_| "https://registry.npmjs.org".into())
          );
          println!("cache = {}", js_engine::pkg::cache_dir_str());
          println!("prefix = {}", js_engine::pkg::prefix(&current_dir));
          if global {
            println!("global = true");
          }
        }
        "get" => {
          let key = if sub == "get" {
            packages.first()
          } else {
            packages.get(1)
          };
          match key.map(|s| s.as_str()) {
            Some("registry") => println!(
              "{}",
              std::env::var("NPM_REGISTRY").unwrap_or_else(|_| "https://registry.npmjs.org".into())
            ),
            Some("cache") => println!("{}", js_engine::pkg::cache_dir_str()),
            Some("prefix") => println!("{}", js_engine::pkg::prefix(&current_dir)),
            Some(k) => println!("undefined (key: {k})"),
            None => eprintln!("Usage: npm config get <key>"),
          }
        }
        "set" => {
          eprintln!("npm config set: edit ~/.npmrc directly to change settings.");
        }
        _ => {
          eprintln!("Usage: npm config <list|get|set>");
        }
      }
    }
    "version" | "-v" | "--version" => {
      println!("malia-npm/{}", env!("CARGO_PKG_VERSION"));
    }
    "help" | "--help" | "-h" => {
      println!("malia built-in package manager (npm-compatible)");
      println!();
      println!("Usage: npm <command>");
      println!();
      println!("Commands:");
      println!("  install, i       Install packages");
      println!("  uninstall, rm    Remove packages");
      println!("  update, up       Update packages");
      println!("  list, ls         List installed packages");
      println!("  outdated         Show outdated packages");
      println!("  info, view       Show package info from registry");
      println!("  audit            Check for vulnerabilities");
      println!("  fund             Show funding info");
      println!("  init             Create a package.json");
      println!("  link             Symlink a local package");
      println!("  pack             Create a tarball");
      println!("  publish          Publish to registry");
      println!("  prune            Remove extraneous packages");
      println!("  dedupe           Reduce duplication");
      println!("  rebuild          Re-run install scripts");
      println!("  cache            Manage download cache");
      println!("  config           Manage configuration");
      println!("  whoami           Show logged-in user");
      println!("  prefix           Print prefix directory");
      println!("  root             Print node_modules directory");
      println!("  exec             Execute a package binary");
      println!("  run              Run a script from package.json");
      println!("  test, t          Run the test script");
      println!("  start            Run the start script");
      println!("  version          Show version");
    }
    other => {
      eprintln!("npm {other}: unknown command");
      eprintln!("Run `npm help` for usage.");
      std::process::exit(1);
    }
  }
  Ok(())
}

fn run_tool(program: &str, args: &[String]) -> anyhow::Result<i32> {
  exec_cmd(std::process::Command::new(tool_program(program)).args(args))
}

/// `jse x <bin>`: a node_modules/.bin binary, falling back to npx.
fn run_package_bin(current_dir: &Path, command: &str, args: &[String]) -> anyhow::Result<i32> {
  if let Some(local_bin) = find_local_bin(current_dir, command) {
    return run_tool(&local_bin.to_string_lossy(), args);
  }
  let mut npx_args = vec![command.to_string()];
  npx_args.extend_from_slice(args);
  run_tool("npx", &npx_args)
}

#[allow(dead_code)]
fn main() -> anyhow::Result<()> {
  run()
}

pub fn run() -> anyhow::Result<()> {
  js_engine::logger::init();
  js_engine::panic::init();

  // Check if running as a standalone compiled application binary
  if let Some(embedded) = check_standalone_binary()? {
    js_engine::permissions::set_permissions(embedded.permissions);
    let embedded_code = embedded.source;
    let args: Vec<String> = std::env::args().collect();
    js_engine::ops::set_argv(args);
    let tokio_rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&embedded_code)));
    if let Err(e) = result {
      eprintln!("error: {e:#}");
      std::process::exit(1);
    }
    return Ok(());
  }

  let mut raw_args: Vec<String> = std::env::args().collect();

  // If invoked as `npm` or `npx` (via shim), translate to malia subcommands.
  let invoked_as = raw_args
    .first()
    .and_then(|a| Path::new(a).file_stem())
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_default();
  if invoked_as == "npm" {
    return run_as_npm(&raw_args[1..]);
  }
  if invoked_as == "npx" {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if raw_args.len() > 1 {
      std::process::exit(run_package_bin(&current_dir, &raw_args[1], &raw_args[2..])?);
    } else {
      eprintln!("Usage: npx <command> [args...]");
      std::process::exit(1);
    }
  }
  // Invoked as `node` -- behave like node: run file, eval, or REPL
  if invoked_as == "node" {
    // `node --version` should print the Node-compatible version
    if raw_args.get(1).is_some_and(|a| a == "--version" || a == "-v") {
      // Keep in sync with process.version in src/js/03_process.js.
      println!("v26.12.0");
      std::process::exit(0);
    }
    // Rewrite argv[0] to malia so clap parses correctly
    if !raw_args.is_empty() {
      raw_args[0] = "malia".to_string();
    }
    // `node` with no args -> REPL; `node file.js` -> run
    // This falls through to normal malia CLI parsing below
  }

  // `npm` and `x`/`exec`/`dlx` pass everything after them to the tool;
  // clap would otherwise take global flags such as --version for itself.
  match raw_args.get(1).map(String::as_str) {
    Some("npm") => std::process::exit(run_tool("npm", &raw_args[2..])?),
    Some("x" | "exec" | "dlx") if raw_args.len() > 2 => {
      let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
      std::process::exit(run_package_bin(&current_dir, &raw_args[2], &raw_args[3..])?);
    }
    _ => {}
  }

  if let Ok(node_opts) = std::env::var("NODE_OPTIONS") {
    let opts = node_opts.split_whitespace().map(String::from).collect::<Vec<_>>();
    if raw_args.len() > 1 {
      raw_args.splice(1..1, opts);
    } else {
      raw_args.extend(opts);
    }
  }

  // Auto-load .env files (like dotenv, but built-in and zero-config).
  // Loads .env, .env.local, .env.<NODE_ENV>, .env.<NODE_ENV>.local
  load_dotenv(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

  let cli = match Cli::try_parse_from(&raw_args) {
    Ok(c) => c,
    Err(e) => {
      e.exit();
    }
  };

  if cli.version {
    let bin_name = raw_args.first().map(|s| s.as_str()).unwrap_or("");
    let is_node_bin = bin_name.ends_with("node") || bin_name.ends_with("node.exe");
    if is_node_bin {
      // Keep in sync with process.version in src/js/03_process.js.
      println!("v26.12.0");
    } else {
      let exe_name = current_exe_name();
      println!("{} {}", exe_name, env!("CARGO_PKG_VERSION"));
    }
    return Ok(());
  }

  // -c / --check: parse the file (the first non-flag argument, after an
  // optional `run`) without executing it.
  if cli.check {
    let target = raw_args
      .iter()
      .skip(1)
      .find(|a| !a.starts_with('-') && a.as_str() != "run");
    let Some(target) = target else {
      eprintln!("error: --check needs a file");
      std::process::exit(9);
    };
    if let Err(e) = js_engine::ts::check_syntax(Path::new(target)) {
      eprintln!("{e}");
      std::process::exit(1);
    }
    return Ok(());
  }

  let wasm_mode = cli.wasm;
  let output_wasm = cli.output.clone();

  let tokio_rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;

  let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
  let discovered_config = js_engine::config::JseConfig::discover(&current_dir)?;
  let configured_permissions = discovered_config
    .as_ref()
    .map(|(_, cfg)| cfg.build_permissions())
    .transpose()?
    .flatten();

  for req_mod in &cli.require {
    js_engine::runtime::add_preload_module(req_mod.clone());
  }
  for imp_mod in &cli.import {
    js_engine::runtime::add_preload_module(imp_mod.clone());
  }
  if cli.no_warnings {
    js_engine::ops::set_no_warnings(true);
  }

  // --inspect / --inspect-brk
  if let Some(addr) = &cli.inspect_brk {
    let (host, port) = parse_inspect_addr(addr);
    js_engine::runtime::set_inspect_mode(js_engine::runtime::InspectMode::Break { host, port });
  } else if let Some(addr) = &cli.inspect {
    let (host, port) = parse_inspect_addr(addr);
    js_engine::runtime::set_inspect_mode(js_engine::runtime::InspectMode::Listen { host, port });
  }

  if cli.interactive {
    js_engine::permissions::set_permissions(
      configured_permissions
        .clone()
        .unwrap_or_else(js_engine::permissions::Permissions::allow_all),
    );
    js_engine::ops::set_argv(vec![current_exe_name()]);
    return tokio_rt.block_on(supervise(|| {
      let local_rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
      local_rt.block_on(js_engine::runtime::repl())
    }));
  }

  // Handle -e / --eval flag directly: `jse -e "..."`
  if let Some(code) = cli.eval {
    js_engine::permissions::set_permissions(
      configured_permissions
        .clone()
        .unwrap_or_else(js_engine::permissions::Permissions::allow_all),
    );
    js_engine::ops::set_argv(vec![current_exe_name(), "-e".to_string()]);
    let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&code)));
    match result {
      Ok(()) => return Ok(()),
      Err(e) => {
        eprintln!("error: {e:#}");
        std::process::exit(1);
      }
    }
  }

  // Handle -p / --print flag directly: `jse -p "..."`
  if let Some(code) = cli.print {
    js_engine::permissions::set_permissions(
      configured_permissions
        .clone()
        .unwrap_or_else(js_engine::permissions::Permissions::allow_all),
    );
    js_engine::ops::set_argv(vec![current_exe_name(), "-p".to_string()]);
    let script = format!(
      "Promise.resolve(({code})).then(r => console.log(r !== undefined ? r : 'undefined')).catch(err => {{ console.error(err); process.exit(1); }});"
    );
    let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&script)));
    match result {
      Ok(()) => return Ok(()),
      Err(e) => {
        eprintln!("error: {e:#}");
        std::process::exit(1);
      }
    }
  }

  match cli.command {
    Some(Command::Init { force, toml }) => {
      let config_file = if toml {
        current_dir.join("jse.toml")
      } else {
        current_dir.join("jse.json")
      };

      if config_file.exists() && !force {
        let name = config_file
          .file_name()
          .and_then(|n| n.to_str())
          .unwrap_or("config file");
        eprintln!(
          "error: {} already exists in current directory. Use --force to overwrite.",
          name
        );
        std::process::exit(1);
      }

      let template = if toml {
        js_engine::config::JseConfig::default_toml_template()
      } else {
        js_engine::config::JseConfig::default_template()
      };

      std::fs::write(&config_file, template)?;
      let name = config_file.file_name().and_then(|n| n.to_str()).unwrap_or("config");
      println!("✓ Created {}", name);
      Ok(())
    }

    Some(Command::Config { action }) => {
      let (config_path, config) = discovered_config.unwrap_or_else(|| {
        eprintln!("error: No jse.json or jse.toml found in current directory tree.");
        std::process::exit(1);
      });
      let base_dir = config_path.parent().unwrap_or(&current_dir);
      config.apply_env(base_dir);

      match action.unwrap_or(ConfigAction::Show) {
        ConfigAction::Show => {
          println!("=== JSE Runtime Configuration ===");
          println!("Config File: {}", config_path.display());
          println!(
            "Resolved config permissions: {}",
            serde_json::to_string(&config.build_permissions()?)?
          );
          println!("Explicit CLI permission flags replace this policy; null means command defaults apply.");
          if let Some(ref name) = config.name {
            println!("App Name:    {}", name);
          }
          if let Some(ref ver) = config.version {
            println!("Version:     {}", ver);
          }
          if let Some(entry) = config.resolve_entry(base_dir) {
            println!("Entry Point: {}", entry.display());
          }
          if let Some(ref scripts) = config.scripts {
            println!("\nScripts (run with `jse <name>` or `jse run <name>`):");
            for (name, cmd) in scripts {
              println!("  • {:<12} -> {}", name, cmd);
            }
          }
          if let Some(ref paths) = config.paths {
            println!("\nPath Aliases (zero-config import mapping):");
            for (pattern, target) in paths {
              println!("  • {:<12} -> {}", pattern, target);
            }
          }
          if let Some(ref alias) = config.alias {
            println!("\nAliases:");
            for (k, v) in alias {
              println!("  • {:<12} -> {}", k, v);
            }
          }
          if let Ok(env_lock) = js_engine::config::CONFIG_ENV.read()
            && !env_lock.is_empty()
          {
            println!("\nLoaded Environment Variables (process.env):");
            let mut keys: Vec<&String> = env_lock.keys().collect();
            keys.sort();
            for k in keys {
              println!("  • {:<16} = {}", k, env_lock[k]);
            }
          }
        }
        ConfigAction::Get { key } => {
          if let Some(val) = config.get_value(&key) {
            println!("{}", val);
          } else {
            eprintln!("error: Key '{}' not found in configuration.", key);
            std::process::exit(1);
          }
        }
      }
      Ok(())
    }

    Some(Command::Build {
      file,
      output,
      standalone,
    }) => {
      let target_file = match file {
        Some(f) => PathBuf::from(f),
        None => {
          if let Some((ref base_dir, ref cfg)) = discovered_config {
            cfg
              .resolve_entry(base_dir.parent().unwrap_or(&current_dir))
              .unwrap_or_else(|| {
                eprintln!("error: No entry file specified and none found in jse.json");
                std::process::exit(1);
              })
          } else {
            eprintln!("error: No file specified and no jse.json found");
            std::process::exit(1);
          }
        }
      };

      let out_path = output.map(PathBuf::from).unwrap_or_else(|| {
        let stem = target_file.file_stem().and_then(|s| s.to_str()).unwrap_or("app");
        PathBuf::from(format!("dist/{stem}"))
      });

      if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
      }

      if standalone {
        create_standalone_binary(&target_file, &out_path)?;
      }
      Ok(())
    }

    Some(Command::Start { permissions, args }) => {
      let (config_path, config) = discovered_config.unwrap_or_else(|| {
        eprintln!("error: No jse.json or package.json found. Run 'jse init' to create one.");
        std::process::exit(1);
      });
      let base_dir = config_path.parent().unwrap_or(&current_dir);
      config.apply_env(base_dir);

      let entry = config.resolve_entry(base_dir).unwrap_or_else(|| {
        eprintln!("error: Could not resolve entry point in jse.json.");
        std::process::exit(1);
      });

      // Auto-clustering supervisor mode
      if let Some(ref cluster_cfg) = config.cluster
        && std::env::var("NODE_UNIQUE_ID").is_err()
      {
        let workers = match cluster_cfg {
          js_engine::config::ConfigCluster::Auto(_) => default_worker_count(),
          js_engine::config::ConfigCluster::Workers(n) => *n,
        };
        if workers > 1 {
          return tokio_rt.block_on(supervise_cluster(entry, workers, args));
        }
      }

      let perms = if !permissions.is_empty() {
        permissions.build()
      } else {
        config
          .build_permissions()?
          .unwrap_or_else(js_engine::permissions::Permissions::allow_all)
      };

      let entry_str = entry.to_string_lossy().to_string();
      js_engine::permissions::set_permissions(perms);
      js_engine::ops::set_argv(make_argv(&entry_str, &args));
      let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&entry_str)));
      match result {
        Ok(()) => Ok(()),
        Err(e) => {
          eprintln!("error: {e:#}");
          std::process::exit(1);
        }
      }
    }

    Some(Command::Dev { permissions, args }) => {
      let (config_path, config) = discovered_config.unwrap_or_else(|| {
        eprintln!("error: No jse.json found. Run 'jse init' to create one.");
        std::process::exit(1);
      });
      let base_dir = config_path.parent().unwrap_or(&current_dir);
      config.apply_env(base_dir);

      let entry = config.resolve_entry(base_dir).unwrap_or_else(|| {
        eprintln!("error: Could not resolve entry point in jse.json.");
        std::process::exit(1);
      });

      let perms = if !permissions.is_empty() {
        permissions.build()
      } else {
        config
          .build_permissions()?
          .unwrap_or_else(js_engine::permissions::Permissions::allow_all)
      };

      let entry_str = entry.to_string_lossy().to_string();
      run_with_watch(&tokio_rt, &entry_str, perms, &args)
    }

    Some(Command::Test { permissions, args }) => {
      if let Some((ref config_path, ref cfg)) = discovered_config {
        let base_dir = config_path.parent().unwrap_or(&current_dir);
        cfg.apply_env(base_dir);
        if let Some(ref scripts) = cfg.scripts
          && let Some(test_cmd) = scripts.get("test")
        {
          println!("> {}", test_cmd);
          let parts: Vec<&str> = test_cmd.split_whitespace().collect();
          if parts.len() > 1 && (parts[0] == "jse" || parts[0] == "malia") {
            let mut full_args = Vec::new();
            for p in &parts[1..] {
              full_args.push(p.to_string());
            }
            full_args.extend(args.clone());
            let code = exec_cmd(std::process::Command::new(std::env::current_exe()?).args(&full_args))?;
            std::process::exit(code);
          } else if !parts.is_empty() {
            let mut cmd = std::process::Command::new(parts[0]);
            if parts.len() > 1 {
              cmd.args(&parts[1..]);
            }
            cmd.args(&args);
            std::process::exit(exec_cmd(&mut cmd)?);
          }
        }
      }

      // Check test file conventions
      let test_candidates = [
        "tests/index.ts",
        "tests/index.js",
        "test/index.ts",
        "test/index.js",
        "test.ts",
        "test.js",
      ];
      for candidate in test_candidates {
        let p = current_dir.join(candidate);
        if p.is_file() {
          let p_str = p.to_string_lossy().to_string();
          let perms = if !permissions.is_empty() {
            permissions.build()
          } else if let Some((_, ref cfg)) = discovered_config {
            cfg
              .build_permissions()?
              .unwrap_or_else(js_engine::permissions::Permissions::allow_all)
          } else {
            js_engine::permissions::Permissions::allow_all()
          };
          js_engine::permissions::set_permissions(perms);
          js_engine::ops::set_argv(make_argv(&p_str, &args));
          let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&p_str)));
          return match result {
            Ok(()) => Ok(()),
            Err(e) => {
              eprintln!("error: {e:#}");
              std::process::exit(1);
            }
          };
        }
      }
      eprintln!("error: No \"test\" script found in jse.json and no test file found.");
      std::process::exit(1);
    }

    Some(Command::Install {
      packages,
      save_dev,
      global,
    }) => {
      if global {
        if packages.is_empty() {
          eprintln!("error: --global requires at least one package name");
          std::process::exit(1);
        }
        // Try npm first for global installs, fall back to built-in
        let tried = std::process::Command::new(tool_program("npm"))
          .arg("install")
          .arg("-g")
          .args(&packages)
          .status();
        match tried {
          Ok(s) if s.success() => std::process::exit(0),
          _ => {
            // Built-in global installer
            if let Err(e) = js_engine::pkg::install_global(&packages) {
              eprintln!("error: {e}");
              std::process::exit(1);
            }
            std::process::exit(0);
          }
        }
      }

      // Local install: try external package manager first
      let pm = detect_package_manager(&current_dir);
      let mut cmd = std::process::Command::new(tool_program(pm));
      if packages.is_empty() {
        cmd.arg("install");
      } else {
        match pm {
          "yarn" | "pnpm" | "bun" => {
            cmd.arg("add");
            if save_dev {
              cmd.arg("-D");
            }
          }
          _ => {
            cmd.arg("install");
            if save_dev {
              cmd.arg("--save-dev");
            }
          }
        }
        cmd.args(&packages);
      }

      let tried = cmd.status().or_else(|_| {
        std::process::Command::new(tool_program("npm"))
          .arg("install")
          .args(if save_dev { vec!["--save-dev"] } else { vec![] })
          .args(&packages)
          .status()
      });

      match tried {
        Ok(s) if s.success() => std::process::exit(0),
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(_) => {
          // No external package manager -- use built-in installer
          eprintln!("No package manager found, using built-in installer...");
          let result = if packages.is_empty() {
            js_engine::pkg::install_all(&current_dir)
          } else {
            js_engine::pkg::install_packages(&current_dir, &packages, save_dev)
          };
          if let Err(e) = result {
            eprintln!("error: {e}");
            std::process::exit(1);
          }
          std::process::exit(0);
        }
      }
    }

    Some(Command::Uninstall { packages, global }) => {
      if global {
        // Try npm first, fall back to built-in
        let tried = std::process::Command::new(tool_program("npm"))
          .arg("uninstall")
          .arg("-g")
          .args(&packages)
          .status();
        match tried {
          Ok(s) if s.success() => std::process::exit(0),
          _ => {
            if let Err(e) = js_engine::pkg::uninstall_global(&packages) {
              eprintln!("error: {e}");
              std::process::exit(1);
            }
            std::process::exit(0);
          }
        }
      }
      // Try external PM first
      let pm = detect_package_manager(&current_dir);
      let tried = match pm {
        "yarn" | "pnpm" | "bun" => std::process::Command::new(tool_program(pm))
          .arg("remove")
          .args(&packages)
          .status(),
        _ => std::process::Command::new(tool_program("npm"))
          .arg("uninstall")
          .args(&packages)
          .status(),
      };
      match tried {
        Ok(s) if s.success() => std::process::exit(0),
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(_) => {
          eprintln!("No package manager found, using built-in...");
          if let Err(e) = js_engine::pkg::uninstall(&current_dir, &packages) {
            eprintln!("error: {e}");
            std::process::exit(1);
          }
          std::process::exit(0);
        }
      }
    }

    Some(Command::List { all, global }) => {
      // Try npm first
      let mut args = vec!["ls".to_string()];
      if global {
        args.push("-g".into());
      }
      if !all {
        args.push("--depth=0".into());
      }
      let tried = std::process::Command::new(tool_program("npm")).args(&args).status();
      match tried {
        Ok(s) if s.success() => std::process::exit(0),
        _ => {
          if let Err(e) = js_engine::pkg::list_packages(&current_dir, all, global) {
            eprintln!("error: {e}");
            std::process::exit(1);
          }
          std::process::exit(0);
        }
      }
    }

    Some(Command::Link { target }) => {
      if let Err(e) = js_engine::pkg::link_local(&current_dir, target.as_deref()) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Audit) => {
      if let Err(e) = js_engine::pkg::audit(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Pack) => {
      if let Err(e) = js_engine::pkg::pack(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Publish { tag }) => {
      if let Err(e) = js_engine::pkg::publish(&current_dir, tag.as_deref()) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Outdated) => {
      if let Err(e) = js_engine::pkg::outdated(&current_dir) {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Cache { action }) => {
      let result = match action.as_deref() {
        Some("clean") | Some("clear") => js_engine::pkg::cache_clean(),
        Some("ls") | Some("list") | None => js_engine::pkg::cache_list(),
        Some(other) => Err(format!("Unknown cache action: {other}. Use: clean, ls")),
      };
      if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::X { command, args }) => std::process::exit(run_package_bin(&current_dir, &command, &args)?),

    Some(Command::Npm { args }) => std::process::exit(run_tool("npm", &args)?),

    Some(Command::Doctor) => {
      println!("Malia Doctor\n");
      let mut issues = 0u32;
      let mut warnings = 0u32;

      // 1. Check malia version
      println!("  malia version: {}", env!("CARGO_PKG_VERSION"));

      // 2. Check package.json
      let pkg_path = current_dir.join("package.json");
      if pkg_path.exists() {
        println!("  package.json: found");
        if let Ok(content) = std::fs::read_to_string(&pkg_path) {
          if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("(unnamed)");
            let ver = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("(no version)");
            println!("  project: {name}@{ver}");

            // Check for missing fields
            if pkg.get("name").is_none() {
              println!("  WARN: package.json missing 'name'");
              warnings += 1;
            }
            if pkg.get("version").is_none() {
              println!("  WARN: package.json missing 'version'");
              warnings += 1;
            }
            if pkg.get("main").is_none() && pkg.get("exports").is_none() {
              println!("  WARN: package.json missing 'main' or 'exports'");
              warnings += 1;
            }
          } else {
            println!("  ERROR: package.json is invalid JSON");
            issues += 1;
          }
        }
      } else {
        println!("  package.json: not found");
      }

      // 3. Check node_modules
      let nm = current_dir.join("node_modules");
      if nm.exists() {
        let count = std::fs::read_dir(&nm)
          .map(|d| {
            d.filter_map(|e| e.ok())
              .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
              .count()
          })
          .unwrap_or(0);
        println!("  node_modules: {count} packages");
      } else if pkg_path.exists() {
        println!("  WARN: node_modules missing (run 'malia install')");
        warnings += 1;
      }

      // 4. Check lockfile
      if current_dir.join("package-lock.json").exists() {
        println!("  lockfile: package-lock.json");
      } else if current_dir.join("yarn.lock").exists() {
        println!("  lockfile: yarn.lock");
      } else if current_dir.join("pnpm-lock.yaml").exists() {
        println!("  lockfile: pnpm-lock.yaml");
      } else if pkg_path.exists() {
        println!("  WARN: no lockfile found");
        warnings += 1;
      }

      // 5. Check .env
      for env_file in &[".env", ".env.local"] {
        if current_dir.join(env_file).exists() {
          println!("  {env_file}: found");
        }
      }

      // 6. Check for common security issues
      let gitignore = current_dir.join(".gitignore");
      if gitignore.exists() {
        let content = std::fs::read_to_string(&gitignore).unwrap_or_default();
        if !content.contains("node_modules") {
          println!("  WARN: .gitignore doesn't exclude node_modules");
          warnings += 1;
        }
        if !content.contains(".env") {
          println!("  WARN: .gitignore doesn't exclude .env files");
          warnings += 1;
        }
      } else if pkg_path.exists() {
        println!("  WARN: no .gitignore found");
        warnings += 1;
      }

      // 7. Check for vulnerable patterns
      if current_dir.join(".env").exists()
        && let Ok(env_content) = std::fs::read_to_string(current_dir.join(".env"))
      {
        for line in env_content.lines() {
          let line = line.trim();
          if (line.contains("password") || line.contains("secret") || line.contains("token") || line.contains("key"))
            && line.contains("=")
            && !line.starts_with('#')
          {
            let key = line.split('=').next().unwrap_or("");
            let key_lower = key.to_lowercase();
            if key_lower.contains("password") || key_lower.contains("secret") || key_lower.contains("private_key") {
              // Don't print the value, just warn
              println!("  INFO: .env contains sensitive key: {key}");
            }
          }
        }
      }

      // 8. System info
      println!("\n  System:");
      println!("    platform: {}", std::env::consts::OS);
      println!("    arch: {}", std::env::consts::ARCH);
      if let Ok(cwd) = std::env::current_dir() {
        println!("    cwd: {}", cwd.display());
      }

      println!("\n  {} issues, {} warnings", issues, warnings);
      if issues > 0 {
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Serve { dir, port, host }) => {
      let serve_dir = dir.map(PathBuf::from).unwrap_or_else(|| current_dir.clone());
      if !serve_dir.is_dir() {
        eprintln!("error: {} is not a directory", serve_dir.display());
        std::process::exit(1);
      }
      let serve_dir_abs = serve_dir.canonicalize().unwrap_or(serve_dir.clone());
      println!("Serving {} on http://{}:{}", serve_dir_abs.display(), host, port);
      println!("Press Ctrl+C to stop.\n");

      // Use the JS serve infrastructure with a file-serving handler
      let code = format!(
        r#"
        import path from "node:path";
        import fs from "node:fs";
        const ROOT = {root};

        const MIME = {{
          ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
          ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
          ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
          ".ttf": "font/ttf", ".txt": "text/plain", ".xml": "application/xml",
          ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
          ".wasm": "application/wasm", ".map": "application/json",
          ".mjs": "application/javascript", ".ts": "text/plain",
        }};

        jse.serve({{ port: {port}, hostname: "{host}" }}, (req) => {{
          const url = new URL(req.url, "http://localhost");
          let filePath = path.join(ROOT, decodeURIComponent(url.pathname));

          // Security: prevent traversal
          const resolved = path.resolve(filePath);
          if (!resolved.startsWith(ROOT)) {{
            return new Response("Forbidden", {{ status: 403 }});
          }}

          try {{
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {{
              // Try index.html
              const idx = path.join(filePath, "index.html");
              if (fs.existsSync(idx)) {{
                filePath = idx;
              }} else {{
                // Directory listing
                const entries = fs.readdirSync(filePath, {{ withFileTypes: true }});
                const html = entries.map(e => {{
                  const name = e.name + (e.isDirectory() ? "/" : "");
                  return `<li><a href="${{url.pathname === "/" ? "" : url.pathname}}/${{name}}">${{name}}</a></li>`;
                }}).join("\n");
                const title = url.pathname;
                return new Response(
                  `<!DOCTYPE html><html><head><title>Index of ${{title}}</title><style>body{{font-family:monospace;padding:20px}}a{{text-decoration:none}}li{{padding:2px 0}}</style></head><body><h1>Index of ${{title}}</h1><ul>${{html}}</ul></body></html>`,
                  {{ headers: {{ "Content-Type": "text/html" }} }}
                );
              }}
            }}

            const ext = path.extname(filePath);
            const contentType = MIME[ext] || "application/octet-stream";
            const body = fs.readFileSync(filePath);
            const etag = `"${{stat.size.toString(36)}}-${{stat.mtimeMs.toString(36)}}"`;

            if (req.headers.get("if-none-match") === etag) {{
              return new Response(null, {{ status: 304 }});
            }}

            return new Response(body, {{
              headers: {{
                "Content-Type": contentType,
                "ETag": etag,
                "Cache-Control": "public, max-age=0",
              }},
            }});
          }} catch (e) {{
            if (e.code === "ENOENT") {{
              return new Response("Not Found", {{ status: 404, headers: {{ "Content-Type": "text/plain" }} }});
            }}
            return new Response("Internal Server Error", {{ status: 500 }});
          }}
        }});
        "#,
        root = serde_json::to_string(&serve_dir_abs.to_string_lossy().to_string()).unwrap(),
        port = port,
        host = host,
      );

      js_engine::permissions::set_permissions(js_engine::permissions::Permissions {
        read: js_engine::permissions::Allow::All,
        write: js_engine::permissions::Allow::Deny,
        net: js_engine::permissions::Allow::All,
        run: js_engine::permissions::Allow::Deny,
        env: true,
        allow_all: false,
      });
      let tokio_rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
      let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&code)));
      if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Clean { all }) => {
      let mut freed = 0u64;

      // Remove node_modules
      let nm = current_dir.join("node_modules");
      if nm.exists() {
        let size = dir_size(&nm);
        std::fs::remove_dir_all(&nm).map_err(|e| anyhow::anyhow!("Cannot remove node_modules: {e}"))?;
        freed += size;
        println!("  removed node_modules ({:.1} MB)", size as f64 / 1_048_576.0);
      }

      // Remove common temp/cache dirs
      for dir_name in &[".cache", "dist", "build", ".next", ".nuxt", ".turbo"] {
        let d = current_dir.join(dir_name);
        if d.exists() && d.is_dir() {
          let size = dir_size(&d);
          std::fs::remove_dir_all(&d).ok();
          freed += size;
          println!("  removed {dir_name} ({:.1} MB)", size as f64 / 1_048_576.0);
        }
      }

      // Remove package-lock.json (regenerated on install)
      {
        let lock = &"package-lock.json";
        let p = current_dir.join(lock);
        if p.exists() {
          std::fs::remove_file(&p).ok();
          println!("  removed {lock}");
        }
      }

      if all && let Err(e) = js_engine::pkg::cache_clean() {
        eprintln!("  warn: {e}");
      }

      println!("\n  Freed {:.1} MB", freed as f64 / 1_048_576.0);
      std::process::exit(0);
    }

    Some(Command::Upgrade) => {
      println!("Current version: {}", env!("CARGO_PKG_VERSION"));
      println!("Checking for updates...");

      // Fetch latest release tag from GitHub
      let output = std::process::Command::new("curl")
        .args([
          "-fsSL",
          "--max-time",
          "10",
          "https://api.github.com/repos/loreste/malia/releases/latest",
        ])
        .output();

      match output {
        Ok(out) if out.status.success() => {
          let body = String::from_utf8_lossy(&out.stdout);
          if let Some(tag) = body.split("\"tag_name\"").nth(1).and_then(|s| s.split('"').nth(1)) {
            let latest = tag.trim_start_matches('v');
            let current = env!("CARGO_PKG_VERSION");
            if latest == current {
              println!("Already on the latest version ({current}).");
            } else {
              println!("New version available: {latest} (current: {current})");
              println!("\nTo upgrade, run:");
              if cfg!(windows) {
                println!("  irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex");
              } else {
                println!("  curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh");
              }
            }
          }
        }
        _ => {
          eprintln!("Could not check for updates. Run the install script manually:");
          if cfg!(windows) {
            eprintln!("  irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex");
          } else {
            eprintln!("  curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh");
          }
        }
      }
      std::process::exit(0);
    }

    Some(Command::Env) => {
      println!("Resolved environment:\n");

      // Show .env files
      let node_env = std::env::var("NODE_ENV").unwrap_or_default();
      for name in &[
        ".env",
        ".env.local",
        &format!(".env.{node_env}"),
        &format!(".env.{node_env}.local"),
      ] {
        let p = current_dir.join(name);
        if p.exists() {
          println!("  From {name}:");
          if let Ok(content) = std::fs::read_to_string(&p) {
            for line in content.lines() {
              let line = line.trim();
              if line.is_empty() || line.starts_with('#') {
                continue;
              }
              if let Some((key, val)) = line.split_once('=') {
                let key = key.trim();
                // Mask sensitive values
                let display = if key.to_lowercase().contains("password")
                  || key.to_lowercase().contains("secret")
                  || key.to_lowercase().contains("token")
                  || key.to_lowercase().contains("private")
                {
                  "********"
                } else {
                  val.trim()
                };
                println!("    {key}={display}");
              }
            }
            println!();
          }
        }
      }

      // Show config file env
      if let Some((path, cfg)) = &discovered_config
        && let Some(env_map) = &cfg.env
      {
        println!("  From {}:", path.display());
        for (k, v) in env_map {
          println!("    {k}={v}");
        }
        println!();
      }

      // Show key runtime vars
      println!("  Runtime:");
      for var in &["NODE_ENV", "PORT", "HOST", "PATH", "HOME", "SHELL", "TERM", "LANG"] {
        if let Ok(val) = std::env::var(var) {
          let display = if val.len() > 80 {
            format!("{}...", &val[..77])
          } else {
            val
          };
          println!("    {var}={display}");
        }
      }
      std::process::exit(0);
    }

    Some(Command::Scan { path }) => {
      println!("Security Scan: {path}\n");
      let scan_root = PathBuf::from(&path);
      let mut findings = Vec::new();

      // Patterns that indicate security issues
      let vuln_patterns: Vec<(&str, &str, &str)> = vec![
        (
          "eval(",
          "Code Injection",
          "CRITICAL: eval() with dynamic input allows arbitrary code execution",
        ),
        (
          "Function(",
          "Code Injection",
          "HIGH: Function() constructor can execute arbitrary code",
        ),
        (
          "innerHTML",
          "XSS",
          "MEDIUM: innerHTML can introduce cross-site scripting if used with user input",
        ),
        ("document.write", "XSS", "MEDIUM: document.write can introduce XSS"),
        (
          "dangerouslySetInnerHTML",
          "XSS",
          "MEDIUM: React dangerouslySetInnerHTML can introduce XSS",
        ),
        (
          ".exec(",
          "Command Injection",
          "HIGH: exec() may allow command injection if user input reaches it",
        ),
        (
          "child_process",
          "Command Execution",
          "INFO: uses child_process -- ensure inputs are sanitized",
        ),
        (
          "sql`",
          "SQL",
          "INFO: tagged template SQL -- verify all user input flows through parameters",
        ),
        (
          "SELECT * FROM",
          "SQL Injection",
          "MEDIUM: raw SQL string -- use parameterized queries",
        ),
        (
          "INSERT INTO",
          "SQL Injection",
          "MEDIUM: raw SQL string -- use parameterized queries",
        ),
        (
          "req.query",
          "Input Validation",
          "INFO: direct use of query params -- validate/sanitize before use",
        ),
        (
          "req.body",
          "Input Validation",
          "INFO: direct use of request body -- validate/sanitize before use",
        ),
        (
          "req.params",
          "Input Validation",
          "INFO: direct use of route params -- validate/sanitize before use",
        ),
        ("password", "Hardcoded Secret", "HIGH: possible hardcoded password"),
        ("api_key", "Hardcoded Secret", "HIGH: possible hardcoded API key"),
        ("apiKey", "Hardcoded Secret", "HIGH: possible hardcoded API key"),
        ("secret_key", "Hardcoded Secret", "HIGH: possible hardcoded secret key"),
        (
          "private_key",
          "Hardcoded Secret",
          "HIGH: possible hardcoded private key",
        ),
        (
          "Authorization:",
          "Hardcoded Auth",
          "HIGH: possible hardcoded authorization header",
        ),
        (
          "res.redirect(req.",
          "Open Redirect",
          "HIGH: redirect based on user input -- validate destination",
        ),
        (
          "cors({ origin: true",
          "CORS Misconfiguration",
          "MEDIUM: CORS allows all origins",
        ),
        (
          "cors({ origin: '*'",
          "CORS Misconfiguration",
          "MEDIUM: CORS allows all origins",
        ),
        (
          "allowAllOrigins",
          "CORS Misconfiguration",
          "MEDIUM: CORS allows all origins",
        ),
        (
          ".createReadStream(req",
          "Path Traversal",
          "HIGH: file read from user input -- sanitize path",
        ),
        (
          "fs.readFile(req",
          "Path Traversal",
          "HIGH: file read from user input -- sanitize path",
        ),
        (
          "__proto__",
          "Prototype Pollution",
          "HIGH: __proto__ access can lead to prototype pollution",
        ),
        (
          "constructor.prototype",
          "Prototype Pollution",
          "HIGH: prototype access pattern",
        ),
        (
          "Object.assign({}, req",
          "Prototype Pollution",
          "MEDIUM: shallow merge of user input may allow prototype pollution",
        ),
        (
          "JSON.parse(",
          "Unsafe Deserialization",
          "INFO: JSON.parse -- ensure source is trusted",
        ),
        (
          "deserialize(",
          "Unsafe Deserialization",
          "MEDIUM: deserialization of untrusted data",
        ),
        ("http://", "Insecure Transport", "LOW: HTTP URL -- prefer HTTPS"),
        (
          "TLS_REJECT_UNAUTHORIZED",
          "TLS Bypass",
          "CRITICAL: disabling TLS verification",
        ),
        (
          "rejectUnauthorized: false",
          "TLS Bypass",
          "CRITICAL: disabling TLS verification",
        ),
        (
          "NODE_TLS_REJECT_UNAUTHORIZED",
          "TLS Bypass",
          "CRITICAL: disabling TLS verification",
        ),
      ];

      fn scan_file(
        path: &Path,
        patterns: &[(&str, &str, &str)],
        findings: &mut Vec<(String, usize, String, String, String)>,
      ) {
        let content = match std::fs::read_to_string(path) {
          Ok(c) => c,
          Err(_) => return,
        };
        for (i, line) in content.lines().enumerate() {
          let trimmed = line.trim();
          // Skip comments
          if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
            continue;
          }
          for (pattern, category, description) in patterns {
            if line.contains(pattern) {
              // Filter false positives: hardcoded secret patterns need = or :
              if *category == "Hardcoded Secret" || *category == "Hardcoded Auth" {
                let lower = line.to_lowercase();
                if !(lower.contains("= \"")
                  || lower.contains("= '")
                  || lower.contains("=\"")
                  || lower.contains("='")
                  || lower.contains(": \"")
                  || lower.contains(": '"))
                {
                  continue;
                }
                // Skip env var reads
                if lower.contains("process.env") || lower.contains("env.") || lower.contains("getenv") {
                  continue;
                }
              }
              // Skip http:// in comments or docs
              if *pattern == "http://"
                && (trimmed.starts_with('#')
                  || trimmed.starts_with("*")
                  || line.contains("localhost")
                  || line.contains("127.0.0.1")
                  || line.contains("example.com"))
              {
                continue;
              }
              findings.push((
                path.display().to_string(),
                i + 1,
                category.to_string(),
                description.to_string(),
                trimmed.chars().take(100).collect(),
              ));
            }
          }
        }
      }

      fn scan_directory(
        dir: &Path,
        patterns: &[(&str, &str, &str)],
        findings: &mut Vec<(String, usize, String, String, String)>,
      ) {
        let skip = [
          "node_modules",
          ".git",
          "dist",
          "build",
          ".next",
          "vendor",
          "coverage",
          "target",
        ];
        let extensions = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"];
        if let Ok(entries) = std::fs::read_dir(dir) {
          for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
              if !skip.contains(&name.as_str()) {
                scan_directory(&path, patterns, findings);
              }
            } else if extensions.iter().any(|ext| name.ends_with(ext)) {
              scan_file(&path, patterns, findings);
            }
          }
        }
      }

      if scan_root.is_dir() {
        scan_directory(&scan_root, &vuln_patterns, &mut findings);
      } else {
        scan_file(&scan_root, &vuln_patterns, &mut findings);
      }

      if findings.is_empty() {
        println!("  No security issues found.");
      } else {
        let mut by_severity = std::collections::HashMap::new();
        for (file, line, category, description, code) in &findings {
          let severity = if description.starts_with("CRITICAL") {
            "CRITICAL"
          } else if description.starts_with("HIGH") {
            "HIGH"
          } else if description.starts_with("MEDIUM") {
            "MEDIUM"
          } else if description.starts_with("LOW") {
            "LOW"
          } else {
            "INFO"
          };
          by_severity
            .entry(severity)
            .or_insert_with(Vec::new)
            .push((file, line, category, description, code));
        }
        for severity in &["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] {
          if let Some(items) = by_severity.get(severity) {
            println!("  [{severity}] ({} findings)", items.len());
            for (file, line, category, description, code) in items {
              println!("    {file}:{line} [{category}]");
              println!("      {description}");
              println!("      > {code}");
              println!();
            }
          }
        }
        let total = findings.len();
        let critical = by_severity.get("CRITICAL").map(|v| v.len()).unwrap_or(0);
        let high = by_severity.get("HIGH").map(|v| v.len()).unwrap_or(0);
        println!("  {total} findings: {critical} critical, {high} high");
        if critical > 0 {
          std::process::exit(2);
        }
        if high > 0 {
          std::process::exit(1);
        }
      }
      std::process::exit(0);
    }

    Some(Command::Permissions { file }) => {
      println!("Permission analysis: {file}\n");
      let content = std::fs::read_to_string(&file).map_err(|e| anyhow::anyhow!("Cannot read {file}: {e}"))?;

      let mut needs_read = false;
      let mut needs_write = false;
      let mut needs_net = false;
      let mut needs_run = false;
      let mut needs_env = false;
      let mut details = Vec::new();

      let _checks: Vec<(&str, &str, &mut bool, &str)> = vec![];
      // Filesystem read
      for pattern in &[
        "fs.readFile",
        "fs.readdir",
        "fs.stat",
        "fs.access",
        "fs.createReadStream",
        "fs.read",
        "require(",
        "import ",
      ] {
        if content.contains(pattern) && !needs_read {
          needs_read = true;
          details.push(format!("  --allow-read    (uses {pattern})"));
        }
      }
      for pattern in &[
        "fs.writeFile",
        "fs.mkdir",
        "fs.rename",
        "fs.unlink",
        "fs.rm",
        "fs.createWriteStream",
        "fs.appendFile",
        "fs.copyFile",
      ] {
        if content.contains(pattern) && !needs_write {
          needs_write = true;
          details.push(format!("  --allow-write   (uses {pattern})"));
        }
      }
      for pattern in &[
        "fetch(",
        "http.request",
        "http.get",
        "https.request",
        "net.connect",
        "jse.serve",
        "malia.serve",
        "WebSocket",
      ] {
        if content.contains(pattern) && !needs_net {
          needs_net = true;
          details.push(format!("  --allow-net     (uses {pattern})"));
        }
      }
      for pattern in &["child_process", "exec(", "execFile", "spawn(", "fork("] {
        if content.contains(pattern) && !needs_run {
          needs_run = true;
          details.push(format!("  --allow-run     (uses {pattern})"));
        }
      }
      for pattern in &["process.env", "Deno.env"] {
        if content.contains(pattern) && !needs_env {
          needs_env = true;
          details.push(format!("  --allow-env     (uses {pattern})"));
        }
      }

      if details.is_empty() {
        println!("  No special permissions required.");
        println!("  Safe to run with: malia run {file}");
      } else {
        println!("  Required permissions:");
        for d in &details {
          println!("{d}");
        }
        let mut flags = Vec::new();
        if needs_read {
          flags.push("--allow-read");
        }
        if needs_write {
          flags.push("--allow-write");
        }
        if needs_net {
          flags.push("--allow-net");
        }
        if needs_run {
          flags.push("--allow-run");
        }
        if needs_env {
          flags.push("--allow-env");
        }
        println!("\n  Run with: malia run {} {file}", flags.join(" "));
        println!("  Or use:   malia run --allow-all {file}");
      }
      std::process::exit(0);
    }

    Some(Command::Sbom) => {
      let pkg_path = current_dir.join("package.json");
      if !pkg_path.exists() {
        eprintln!("error: No package.json found");
        std::process::exit(1);
      }
      let content = std::fs::read_to_string(&pkg_path)?;
      let pkg: serde_json::Value = serde_json::from_str(&content)?;
      let nm = current_dir.join("node_modules");

      let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
      let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");

      let mut components = Vec::new();
      if nm.exists()
        && let Ok(entries) = std::fs::read_dir(&nm)
      {
        for entry in entries.flatten() {
          let pkg_json = entry.path().join("package.json");
          if let Ok(c) = std::fs::read_to_string(&pkg_json)
            && let Ok(p) = serde_json::from_str::<serde_json::Value>(&c)
          {
            let pname = p.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
            let pver = p.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
            let license = p.get("license").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
            let desc = p.get("description").and_then(|v| v.as_str()).unwrap_or("");
            components.push(serde_json::json!({
              "type": "library",
              "name": pname,
              "version": pver,
              "purl": format!("pkg:npm/{pname}@{pver}"),
              "licenses": [{ "license": { "id": license } }],
              "description": desc,
            }));
          }
        }
      }

      let sbom = serde_json::json!({
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
          "component": {
            "type": "application",
            "name": name,
            "version": version,
          },
          "tools": [{
            "vendor": "malia",
            "name": "malia-sbom",
            "version": env!("CARGO_PKG_VERSION"),
          }],
          "timestamp": chrono_now(),
        },
        "components": components,
      });

      let output = serde_json::to_string_pretty(&sbom).unwrap();
      let sbom_path = current_dir.join("sbom.cdx.json");
      std::fs::write(&sbom_path, format!("{output}\n"))?;
      println!(
        "Generated SBOM: {} ({} components)",
        sbom_path.display(),
        components.len()
      );
      std::process::exit(0);
    }

    Some(Command::Secrets { path }) => {
      println!("Secret Scanner: {path}\n");
      let scan_dir = PathBuf::from(&path);

      // Patterns that match leaked secrets
      let secret_patterns: Vec<(&str, &str)> = vec![
        (r#"AKIA[0-9A-Z]{16}"#, "AWS Access Key ID"),
        ("ghp_", "GitHub Personal Access Token"),
        ("gho_", "GitHub OAuth Token"),
        ("ghs_", "GitHub Server Token"),
        ("github_pat_", "GitHub Fine-Grained PAT"),
        ("sk-", "OpenAI / Stripe Secret Key"),
        ("sk_live_", "Stripe Live Secret Key"),
        ("sk_test_", "Stripe Test Secret Key"),
        ("pk_live_", "Stripe Live Publishable Key"),
        ("rk_live_", "Stripe Restricted Key"),
        ("SG.", "SendGrid API Key"),
        ("xoxb-", "Slack Bot Token"),
        ("xoxp-", "Slack User Token"),
        ("hooks.slack.com/services", "Slack Webhook URL"),
        ("-----BEGIN RSA PRIVATE KEY-----", "RSA Private Key"),
        ("-----BEGIN EC PRIVATE KEY-----", "EC Private Key"),
        ("-----BEGIN PRIVATE KEY-----", "Private Key (PKCS#8)"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----", "OpenSSH Private Key"),
        ("AIza", "Google API Key"),
        ("ya29.", "Google OAuth Token"),
        ("ANTHROPIC_API_KEY", "Anthropic API Key (env reference)"),
        ("npm_", "npm Access Token"),
        ("eyJ", "JWT Token (base64 header)"),
      ];

      let skip_dirs = [
        "node_modules",
        ".git",
        "dist",
        "build",
        "target",
        "vendor",
        "coverage",
        ".next",
      ];
      let skip_exts = [
        ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".lock", ".map",
      ];
      let mut total_findings = 0u32;

      fn scan_secrets(
        dir: &Path,
        patterns: &[(&str, &str)],
        skip_dirs: &[&str],
        skip_exts: &[&str],
        findings: &mut u32,
      ) {
        if let Ok(entries) = std::fs::read_dir(dir) {
          for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
              if !skip_dirs.contains(&name.as_str()) {
                scan_secrets(&path, patterns, skip_dirs, skip_exts, findings);
              }
            } else {
              if skip_exts.iter().any(|ext| name.ends_with(ext)) {
                continue;
              }
              if let Ok(content) = std::fs::read_to_string(&path) {
                for (i, line) in content.lines().enumerate() {
                  let trimmed = line.trim();
                  if trimmed.starts_with("//") || trimmed.starts_with('#') {
                    continue;
                  }
                  for (pattern, label) in patterns {
                    if line.contains(pattern) {
                      // Skip env var references (process.env.X = ...)
                      if line.contains("process.env") || line.contains("std::env") || line.contains("os.environ") {
                        continue;
                      }
                      // Skip commented patterns
                      if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with("*") {
                        continue;
                      }
                      *findings += 1;
                      let masked = if line.len() > 60 {
                        format!("{}...", &line.trim()[..std::cmp::min(60, line.trim().len())])
                      } else {
                        line.trim().to_string()
                      };
                      println!("  {}:{} [{}]", path.display(), i + 1, label);
                      println!("    > {masked}");
                      println!();
                    }
                  }
                }
              }
            }
          }
        }
      }

      if scan_dir.is_dir() {
        scan_secrets(&scan_dir, &secret_patterns, &skip_dirs, &skip_exts, &mut total_findings);
      } else if let Ok(content) = std::fs::read_to_string(&scan_dir) {
        for (i, line) in content.lines().enumerate() {
          for (pattern, label) in &secret_patterns {
            if line.contains(pattern) {
              total_findings += 1;
              println!("  {}:{} [{}]", scan_dir.display(), i + 1, label);
              println!("    > {}", line.trim());
              println!();
            }
          }
        }
      }

      if total_findings == 0 {
        println!("  No leaked secrets found.");
      } else {
        println!("  {total_findings} potential secret(s) found.");
        println!("  Review each finding. Add secrets to .env (gitignored) instead of source code.");
      }
      if total_findings > 0 {
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Deps { tree, licenses }) => {
      let pkg_path = current_dir.join("package.json");
      if !pkg_path.exists() {
        eprintln!("error: No package.json found");
        std::process::exit(1);
      }
      let content = std::fs::read_to_string(&pkg_path)?;
      let pkg: serde_json::Value = serde_json::from_str(&content)?;
      let nm = current_dir.join("node_modules");

      let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("project");
      let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
      println!("{name}@{version}");

      let mut total_packages = 0u32;
      let mut total_size = 0u64;
      let mut license_map: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

      for key in &["dependencies", "devDependencies"] {
        if let Some(deps) = pkg.get(*key).and_then(|v| v.as_object()) {
          for (dep_name, dep_spec) in deps {
            let dep_dir = nm.join(dep_name);
            let ver = js_engine::pkg::read_pkg_version_pub(&dep_dir)
              .unwrap_or_else(|| dep_spec.as_str().unwrap_or("?").to_string());

            let mut extra = String::new();
            if licenses {
              let license = dep_dir
                .join("package.json")
                .exists()
                .then(|| {
                  std::fs::read_to_string(dep_dir.join("package.json"))
                    .ok()
                    .and_then(|c| {
                      serde_json::from_str::<serde_json::Value>(&c)
                        .ok()?
                        .get("license")?
                        .as_str()
                        .map(String::from)
                    })
                })
                .flatten()
                .unwrap_or_else(|| "UNKNOWN".into());
              *license_map.entry(license.clone()).or_insert(0) += 1;
              extra = format!(" ({license})");
            }

            let size = if dep_dir.exists() { dir_size(&dep_dir) } else { 0 };
            total_size += size;
            total_packages += 1;

            let is_dev = *key == "devDependencies";
            let tag = if is_dev { " [dev]" } else { "" };
            println!("  +- {dep_name}@{ver}{extra}{tag}");

            if tree {
              // Show sub-deps
              let sub_pkg = dep_dir.join("package.json");
              if let Ok(sub_content) = std::fs::read_to_string(&sub_pkg)
                && let Ok(sub) = serde_json::from_str::<serde_json::Value>(&sub_content)
                && let Some(sub_deps) = sub.get("dependencies").and_then(|v| v.as_object())
              {
                for (sd_name, sd_spec) in sub_deps {
                  let sd_dir = nm.join(sd_name);
                  let sd_ver = js_engine::pkg::read_pkg_version_pub(&sd_dir)
                    .unwrap_or_else(|| sd_spec.as_str().unwrap_or("?").to_string());
                  println!("  |  +- {sd_name}@{sd_ver}");
                }
              }
            }
          }
        }
      }

      println!(
        "\n  {total_packages} packages, {:.1} MB on disk",
        total_size as f64 / 1_048_576.0
      );
      if licenses && !license_map.is_empty() {
        println!("\n  Licenses:");
        let mut sorted: Vec<_> = license_map.into_iter().collect();
        sorted.sort_by_key(|b| std::cmp::Reverse(b.1));
        for (lic, count) in &sorted {
          println!("    {lic}: {count}");
        }
      }
      std::process::exit(0);
    }

    Some(Command::Deploy { target }) => {
      let pkg_path = current_dir.join("package.json");
      let name = if pkg_path.exists() {
        std::fs::read_to_string(&pkg_path)
          .ok()
          .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
          .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
          .unwrap_or_else(|| "app".into())
      } else {
        "app".into()
      };
      let entry = discovered_config
        .as_ref()
        .and_then(|(_, cfg)| cfg.entry.clone())
        .unwrap_or_else(|| "index.js".into());
      let port = std::env::var("PORT").unwrap_or_else(|_| "3000".into());

      let gen_docker = target == "docker" || target == "all";
      let gen_compose = target == "compose" || target == "all";
      let gen_systemd = target == "systemd" || target == "all";

      if gen_docker && !current_dir.join("Dockerfile").exists() {
        let dockerfile = format!(
          "FROM ubuntu:24.04\n\
           RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*\n\
           RUN curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh\n\
           ENV PATH=\"/root/.malia/bin:$PATH\"\n\
           WORKDIR /app\n\
           COPY package.json ./\n\
           RUN malia install --production 2>/dev/null || true\n\
           COPY . .\n\
           EXPOSE {port}\n\
           ENV NODE_ENV=production PORT={port}\n\
           CMD [\"malia\", \"run\", \"--allow-all\", \"{entry}\"]\n",
          port = port,
          entry = entry
        );
        std::fs::write(current_dir.join("Dockerfile"), &dockerfile)?;
        println!("  Generated: Dockerfile");
      }

      if gen_docker && !current_dir.join(".dockerignore").exists() {
        std::fs::write(
          current_dir.join(".dockerignore"),
          "node_modules\n.git\n.env.local\n.env.*.local\ndist\nbuild\n.cache\ncoverage\n*.log\n",
        )?;
        println!("  Generated: .dockerignore");
      }

      if gen_compose && !current_dir.join("docker-compose.yml").exists() {
        let compose = format!(
          "services:\n\
           \x20 {name}:\n\
           \x20   build: .\n\
           \x20   ports:\n\
           \x20     - \"{port}:{port}\"\n\
           \x20   environment:\n\
           \x20     - NODE_ENV=production\n\
           \x20     - PORT={port}\n\
           \x20   restart: unless-stopped\n\
           \x20   healthcheck:\n\
           \x20     test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:{port}/health\"]\n\
           \x20     interval: 30s\n\
           \x20     timeout: 10s\n\
           \x20     retries: 3\n",
          name = name,
          port = port
        );
        std::fs::write(current_dir.join("docker-compose.yml"), &compose)?;
        println!("  Generated: docker-compose.yml");
      }

      if gen_systemd {
        let service = format!(
          "[Unit]\nDescription={name}\nAfter=network.target\n\n\
           [Service]\nType=simple\nUser=www-data\n\
           WorkingDirectory={cwd}\n\
           ExecStart=/usr/local/bin/malia run --allow-all {entry}\n\
           Restart=always\nRestartSec=3\n\
           Environment=NODE_ENV=production PORT={port}\n\
           StandardOutput=journal\nStandardError=journal\n\n\
           [Install]\nWantedBy=multi-user.target\n",
          name = name,
          cwd = current_dir.display(),
          entry = entry,
          port = port
        );
        let svc_path = current_dir.join(format!("{name}.service"));
        std::fs::write(&svc_path, &service)?;
        println!("  Generated: {}.service", name);
        println!(
          "  Install:   sudo cp {0}.service /etc/systemd/system/ && sudo systemctl enable --now {0}",
          name
        );
      }
      println!("\n  Deploy with: docker compose up -d");
      std::process::exit(0);
    }

    Some(Command::Profile {
      file,
      duration,
      permissions: _,
    }) => {
      println!("Profiling {} for {}s...\n", file, duration);
      js_engine::permissions::set_permissions(js_engine::permissions::Permissions::allow_all());
      let code = format!(
        r#"
        const inspector = require("node:inspector");
        const fs = require("node:fs");
        const session = new inspector.Session();
        session.connect();

        // Start CPU profiling
        session.post("Profiler.enable", () => {{
          session.post("Profiler.start", async () => {{
            // Run the target file
            try {{
              await import("file://" + require("node:path").resolve("{}"));
            }} catch (e) {{
              console.error("Error:", e.message);
            }}

            // Wait for duration
            await new Promise(r => setTimeout(r, {} * 1000));

            // Stop and collect profile
            session.post("Profiler.stop", (err, {{ profile }}) => {{
              if (err) {{ console.error("Profile error:", err); process.exit(1); }}

              // Analyze top functions
              const nodes = profile.nodes || [];
              const samples = profile.samples || [];
              const timeDeltas = profile.timeDeltas || [];

              // Count samples per node
              const counts = {{}};
              for (const id of samples) counts[id] = (counts[id] || 0) + 1;

              // Sort by sample count
              const top = nodes
                .filter(n => counts[n.id])
                .map(n => ({{
                  fn: n.callFrame.functionName || "(anonymous)",
                  file: n.callFrame.url.replace(/.*\//, ""),
                  line: n.callFrame.lineNumber + 1,
                  samples: counts[n.id] || 0,
                  pct: ((counts[n.id] || 0) / samples.length * 100).toFixed(1),
                }}))
                .sort((a, b) => b.samples - a.samples)
                .slice(0, 20);

              console.log("Top functions by CPU time:\n");
              console.log("  %Time  Samples  Function");
              console.log("  -----  -------  --------");
              for (const t of top) {{
                console.log(`  ${{t.pct.padStart(5)}}%  ${{String(t.samples).padStart(7)}}  ${{t.fn}} (${{t.file}}:${{t.line}})`);
              }}

              // Save raw profile
              const outPath = "profile-" + Date.now() + ".cpuprofile";
              fs.writeFileSync(outPath, JSON.stringify(profile));
              console.log(`\nFull profile saved: ${{outPath}}`);
              console.log("Open in Chrome DevTools: chrome://inspect -> Open dedicated DevTools -> Performance -> Load profile");

              // Memory snapshot
              const mem = process.memoryUsage();
              console.log(`\nMemory: RSS=${{(mem.rss/1048576).toFixed(1)}}MB Heap=${{(mem.heapUsed/1048576).toFixed(1)}}/${{(mem.heapTotal/1048576).toFixed(1)}}MB`);

              process.exit(0);
            }});
          }});
        }});
        "#,
        file, duration
      );
      let tokio_rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
      let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&code)));
      if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
      }
      std::process::exit(0);
    }

    Some(Command::Migrate { action, name }) => {
      let migrations_dir = current_dir.join("migrations");
      match action.as_str() {
        "create" => {
          let mig_name = name.as_deref().unwrap_or("unnamed");
          let _ = std::fs::create_dir_all(&migrations_dir);
          let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
          let up = migrations_dir.join(format!("{ts}_{mig_name}.up.sql"));
          let down = migrations_dir.join(format!("{ts}_{mig_name}.down.sql"));
          std::fs::write(&up, format!("-- Migration: {mig_name} (up)\n\n"))?;
          std::fs::write(&down, format!("-- Migration: {mig_name} (down)\n\n"))?;
          println!("Created:");
          println!("  {}", up.display());
          println!("  {}", down.display());
        }
        "up" | "down" | "status" => {
          // Run migrations using built-in SQLite for tracking
          let code = format!(
            r#"
            import fs from "node:fs";
            import path from "node:path";

            const migrationsDir = "{}";
            const action = "{}";

            // Track applied migrations
            const db = jse.sql.open(".malia-migrations.db");
            db.query("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT)");

            const applied = new Set(db.query("SELECT name FROM migrations").map(r => r.name));

            if (action === "status") {{
              const files = fs.existsSync(migrationsDir)
                ? fs.readdirSync(migrationsDir).filter(f => f.endsWith(".up.sql")).sort()
                : [];
              console.log("Migration status:\n");
              for (const f of files) {{
                const name = f.replace(".up.sql", "");
                console.log(`  ${{applied.has(name) ? "[x]" : "[ ]"}} ${{name}}`);
              }}
              if (files.length === 0) console.log("  No migrations found in " + migrationsDir);
            }} else if (action === "up") {{
              const files = fs.existsSync(migrationsDir)
                ? fs.readdirSync(migrationsDir).filter(f => f.endsWith(".up.sql")).sort()
                : [];
              let ran = 0;
              for (const f of files) {{
                const name = f.replace(".up.sql", "");
                if (applied.has(name)) continue;
                const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
                if (sql.trim()) {{
                  db.query(sql);
                  db.query("INSERT INTO migrations VALUES (?, datetime('now'))", name);
                  console.log("  Applied: " + name);
                  ran++;
                }}
              }}
              if (ran === 0) console.log("  All migrations are up to date.");
              else console.log(`\n  ${{ran}} migration(s) applied.`);
            }} else if (action === "down") {{
              const files = fs.existsSync(migrationsDir)
                ? fs.readdirSync(migrationsDir).filter(f => f.endsWith(".down.sql")).sort().reverse()
                : [];
              const lastApplied = [...applied].sort().pop();
              if (!lastApplied) {{ console.log("  No migrations to roll back."); }}
              else {{
                const downFile = lastApplied + ".down.sql";
                const downPath = path.join(migrationsDir, downFile);
                if (fs.existsSync(downPath)) {{
                  const sql = fs.readFileSync(downPath, "utf8");
                  if (sql.trim()) db.query(sql);
                  db.query("DELETE FROM migrations WHERE name = ?", lastApplied);
                  console.log("  Rolled back: " + lastApplied);
                }} else {{
                  console.log("  No down migration for: " + lastApplied);
                }}
              }}
            }}
            "#,
            migrations_dir.display(),
            action
          );
          js_engine::permissions::set_permissions(js_engine::permissions::Permissions::allow_all());
          let tokio_rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
          let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&code)));
          if let Err(e) = result {
            eprintln!("error: {e:#}");
            std::process::exit(1);
          }
        }
        other => {
          eprintln!("Unknown migrate action: {other}. Use: create, up, down, status");
          std::process::exit(1);
        }
      }
      std::process::exit(0);
    }

    Some(Command::EnvEncrypt { action, key }) => {
      let env_key = key.or_else(|| std::env::var("MALIA_ENV_KEY").ok()).unwrap_or_else(|| {
        // Generate a key if none provided
        let k = hex_encode_bytes(&rand_bytes(32));
        eprintln!("Generated key (save this): {k}");
        eprintln!("Set MALIA_ENV_KEY={k} or pass --key={k}\n");
        k
      });

      match action.as_str() {
        "encrypt" => {
          let env_path = current_dir.join(".env");
          if !env_path.exists() {
            eprintln!("error: No .env file found");
            std::process::exit(1);
          }
          let plaintext = std::fs::read(&env_path)?;
          let encrypted = encrypt_aes256(&plaintext, &env_key);
          let out_path = current_dir.join(".env.encrypted");
          std::fs::write(&out_path, &encrypted)?;
          println!("Encrypted .env -> .env.encrypted ({} bytes)", encrypted.len());
          println!("Safe to commit .env.encrypted to git.");
          println!("Add .env to .gitignore if not already there.");
        }
        "decrypt" => {
          let enc_path = current_dir.join(".env.encrypted");
          if !enc_path.exists() {
            eprintln!("error: No .env.encrypted file found");
            std::process::exit(1);
          }
          let encrypted = std::fs::read(&enc_path)?;
          match decrypt_aes256(&encrypted, &env_key) {
            Ok(plaintext) => {
              let out_path = current_dir.join(".env");
              std::fs::write(&out_path, &plaintext)?;
              println!("Decrypted .env.encrypted -> .env ({} bytes)", plaintext.len());
            }
            Err(e) => {
              eprintln!("error: Decryption failed: {e}");
              eprintln!("Check your MALIA_ENV_KEY.");
              std::process::exit(1);
            }
          }
        }
        other => {
          eprintln!("Unknown action: {other}. Use: encrypt, decrypt");
          std::process::exit(1);
        }
      }
      std::process::exit(0);
    }

    Some(Command::Run {
      file,
      watch,
      permissions,
      args,
    }) => {
      // 1. Resolve target file or script from jse.json
      let (target_file, config_perms) = match file {
        Some(f) => {
          // Check if 'f' is a script defined in jse.json
          if let Some((_, ref cfg)) = discovered_config
            && let Some(scripts) = &cfg.scripts
            && let Some(cmd_line) = scripts.get(&f)
          {
            println!("> {}", cmd_line);
            let parts: Vec<&str> = cmd_line.split_whitespace().collect();
            if !parts.is_empty() {
              if parts[0] == "jse" || parts[0] == "malia" {
                let mut full_args: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
                full_args.extend(args.clone());
                let code = exec_cmd(std::process::Command::new(std::env::current_exe()?).args(&full_args))?;
                std::process::exit(code);
              } else {
                let mut cmd = std::process::Command::new(parts[0]);
                if parts.len() > 1 {
                  cmd.args(&parts[1..]);
                }
                cmd.args(&args);
                std::process::exit(exec_cmd(&mut cmd)?);
              }
            }
          }
          let resolved = js_engine::runtime::resolve_target_path(&current_dir.join(&f))
            .or_else(|| js_engine::runtime::resolve_target_path(Path::new(&f)))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(f);
          (
            resolved,
            discovered_config
              .as_ref()
              .map(|(_, cfg)| cfg.build_permissions())
              .transpose()?
              .flatten(),
          )
        }
        None => {
          // Auto-detect entry from config
          if let Some((ref base_dir, ref cfg)) = discovered_config {
            let entry = cfg
              .resolve_entry(base_dir.parent().unwrap_or(&current_dir))
              .unwrap_or_else(|| {
                eprintln!("error: No file provided and could not resolve entry in jse.json");
                std::process::exit(1);
              });
            let p = cfg.build_permissions()?;
            (entry.to_string_lossy().to_string(), p)
          } else {
            eprintln!("error: No file provided and no jse.json configuration found.");
            std::process::exit(1);
          }
        }
      };

      // Apply environment from config if discovered
      if let Some((ref config_path, ref cfg)) = discovered_config {
        let base_dir = config_path.parent().unwrap_or(&current_dir);
        cfg.apply_env(base_dir);
      }

      let is_wasm = wasm_mode || target_file.ends_with(".wasm");
      js_engine::optimizer::set_wasm_mode(is_wasm);
      js_engine::optimizer::init_v8_optimizations(is_wasm);

      if let Some(ref out_path) = output_wasm.filter(|_| wasm_mode) {
        let wasm_bytes = js_engine::wasm_compiler::compile_file_to_wasm(Path::new(&target_file))?;
        std::fs::write(out_path, &wasm_bytes)?;
      }

      let perms = if !permissions.is_empty() {
        permissions.build()
      } else if let Some(p) = config_perms {
        p
      } else {
        permissions.build()
      };

      if watch {
        run_with_watch(&tokio_rt, &target_file, perms, &args)
      } else {
        js_engine::permissions::set_permissions(perms);
        js_engine::ops::set_argv(make_argv(&target_file, &args));
        let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&target_file)));
        match result {
          Ok(()) => Ok(()),
          Err(e) => {
            eprintln!("error: {e:#}");
            std::process::exit(1);
          }
        }
      }
    }

    Some(Command::Compile {
      file,
      wasm,
      standalone,
      output,
    }) => {
      let is_wasm = wasm || (!standalone && output.as_ref().map(|o| o.ends_with(".wasm")).unwrap_or(false));
      if is_wasm {
        eprintln!("--wasm packages source; it does not compile JavaScript to portable Wasm instructions.");
        let out_path = output.or(output_wasm).unwrap_or_else(|| {
          let path = Path::new(&file);
          path.with_extension("wasm").to_string_lossy().to_string()
        });
        let wasm_bytes = js_engine::wasm_compiler::compile_file_to_wasm(Path::new(&file))?;
        std::fs::write(&out_path, &wasm_bytes)?;
        println!(
          "Created Malia source container {} -> {} ({} bytes; application execution requires Malia)",
          file,
          out_path,
          wasm_bytes.len()
        );
        Ok(())
      } else {
        let out_path = output.map(PathBuf::from).unwrap_or_else(|| {
          let p = Path::new(&file);
          let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("app");
          PathBuf::from(format!("dist/{stem}"))
        });
        if let Some(parent) = out_path.parent() {
          let _ = std::fs::create_dir_all(parent);
        }
        create_standalone_binary(Path::new(&file), &out_path)?;
        Ok(())
      }
    }

    Some(Command::Bench {
      file,
      permissions,
      args,
    }) => {
      js_engine::permissions::set_permissions(if permissions.is_empty() {
        configured_permissions.clone().unwrap_or_else(|| permissions.build())
      } else {
        permissions.build()
      });
      js_engine::ops::set_argv(make_argv(&file, &args));
      let f = file.clone();
      let start = std::time::Instant::now();
      let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&f)));
      let elapsed = start.elapsed();
      result?;
      println!("bench: {} in {:.3}ms", file, elapsed.as_secs_f64() * 1000.0);
      Ok(())
    }

    Some(Command::Eval {
      code,
      permissions,
      args,
    }) => {
      js_engine::permissions::set_permissions(if permissions.is_empty() {
        configured_permissions.clone().unwrap_or_else(|| permissions.build())
      } else {
        permissions.build()
      });
      let mut argv = vec![current_exe_name(), "-e".to_string()];
      argv.extend(args);
      js_engine::ops::set_argv(argv);
      let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_code_blocking(&code)));
      match result {
        Ok(()) => Ok(()),
        Err(e) => {
          eprintln!("error: {e:#}");
          std::process::exit(1);
        }
      }
    }

    Some(Command::Custom(mut custom_args)) => {
      if custom_args.is_empty() {
        return Ok(());
      }
      let target = custom_args.remove(0);

      // 1. Check if target is a script in jse.json / package.json
      if let Some((ref config_path, ref cfg)) = discovered_config {
        let base_dir = config_path.parent().unwrap_or(&current_dir);
        cfg.apply_env(base_dir);
        if let Some(ref scripts) = cfg.scripts
          && let Some(cmd_line) = scripts.get(&target)
        {
          println!("> {}", cmd_line);
          let parts: Vec<&str> = cmd_line.split_whitespace().collect();
          if parts.len() > 1 && (parts[0] == "jse" || parts[0] == "malia") {
            let mut full_args = Vec::new();
            for p in &parts[1..] {
              full_args.push(p.to_string());
            }
            full_args.extend(custom_args);
            let code = exec_cmd(std::process::Command::new(std::env::current_exe()?).args(&full_args))?;
            std::process::exit(code);
          } else if !parts.is_empty() {
            let mut cmd = std::process::Command::new(parts[0]);
            if parts.len() > 1 {
              cmd.args(&parts[1..]);
            }
            cmd.args(&custom_args);
            std::process::exit(exec_cmd(&mut cmd)?);
          }
        }
      }

      // 2. Check if target is a local node_modules/.bin executable (e.g. `jse prettier`, `jse tsc`, `jse prisma`)
      if let Some(local_bin) = find_local_bin(&current_dir, &target) {
        std::process::exit(exec_cmd(std::process::Command::new(&local_bin).args(&custom_args))?);
      }

      // 3. Check if target is a file, script, or directory entry
      let resolved_target = js_engine::runtime::resolve_target_path(&current_dir.join(&target))
        .or_else(|| js_engine::runtime::resolve_target_path(Path::new(&target)));

      if let Some(p) = resolved_target {
        if let Some((ref config_path, ref cfg)) = discovered_config {
          let base_dir = config_path.parent().unwrap_or(&current_dir);
          cfg.apply_env(base_dir);
        }
        let p_str = p.to_string_lossy().to_string();
        let perms = if let Some((_, ref cfg)) = discovered_config {
          cfg
            .build_permissions()?
            .unwrap_or_else(js_engine::permissions::Permissions::allow_all)
        } else {
          js_engine::permissions::Permissions::allow_all()
        };
        js_engine::permissions::set_permissions(perms);
        js_engine::ops::set_argv(make_argv(&p_str, &custom_args));
        let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&p_str)));
        return match result {
          Ok(()) => Ok(()),
          Err(e) => {
            eprintln!("error: {e:#}");
            std::process::exit(1);
          }
        };
      }

      eprintln!("error: Unknown command or script '{}'.", target);
      if let Some((_, ref cfg)) = discovered_config
        && let Some(ref scripts) = cfg.scripts
      {
        let script_names: Vec<&str> = scripts.keys().map(|s| s.as_str()).collect();
        eprintln!("Available scripts: {}", script_names.join(", "));
      }
      std::process::exit(1);
    }

    Some(Command::Repl) | None => {
      // If no command is given, check if a jse.json or package.json entry exists to run!
      if let Some((ref config_path, ref cfg)) = discovered_config {
        let base_dir = config_path.parent().unwrap_or(&current_dir);
        if let Some(entry) = cfg.resolve_entry(base_dir) {
          cfg.apply_env(base_dir);

          // Auto-cluster supervisor mode
          if let Some(ref cluster_cfg) = cfg.cluster
            && std::env::var("NODE_UNIQUE_ID").is_err()
          {
            let workers = match cluster_cfg {
              js_engine::config::ConfigCluster::Auto(_) => default_worker_count(),
              js_engine::config::ConfigCluster::Workers(n) => *n,
            };
            if workers > 1 {
              return tokio_rt.block_on(supervise_cluster(entry, workers, Vec::new()));
            }
          }

          let perms = cfg
            .build_permissions()?
            .unwrap_or_else(js_engine::permissions::Permissions::allow_all);
          js_engine::permissions::set_permissions(perms);
          let entry_str = entry.to_string_lossy().to_string();
          js_engine::ops::set_argv(vec![current_exe_name(), entry_str.clone()]);
          let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&entry_str)));
          return match result {
            Ok(()) => Ok(()),
            Err(e) => {
              eprintln!("error: {e:#}");
              std::process::exit(1);
            }
          };
        }
      }

      // Check if current directory has a conventional entry (package.json main, index.js, app.js, server.js)
      if let Some(entry) = js_engine::runtime::resolve_target_path(&current_dir) {
        let perms = js_engine::permissions::Permissions::allow_all();
        js_engine::permissions::set_permissions(perms);
        let entry_str = entry.to_string_lossy().to_string();
        js_engine::ops::set_argv(vec![current_exe_name(), entry_str.clone()]);
        let result = tokio_rt.block_on(supervise(move || js_engine::runtime::run_file_blocking(&entry_str)));
        return match result {
          Ok(()) => Ok(()),
          Err(e) => {
            eprintln!("error: {e:#}");
            std::process::exit(1);
          }
        };
      }

      // Otherwise drop into interactive REPL
      js_engine::permissions::set_permissions(js_engine::permissions::Permissions::allow_all());
      js_engine::ops::set_argv(vec![current_exe_name()]);
      tokio_rt.block_on(supervise(|| {
        let local_rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        local_rt.block_on(js_engine::runtime::repl())
      }))
    }
  }
}

/// Worker/cluster count: leave one core for the main thread and OS.
fn default_worker_count() -> usize {
  std::thread::available_parallelism()
    .map(|n| n.get().max(2) - 1)
    .unwrap_or(1)
}

fn parse_inspect_addr(addr: &str) -> (String, u16) {
  if let Some((host, port_str)) = addr.rsplit_once(':')
    && let Ok(port) = port_str.parse::<u16>()
  {
    return (host.to_string(), port);
  }
  if let Ok(port) = addr.parse::<u16>() {
    return ("127.0.0.1".to_string(), port);
  }
  ("127.0.0.1".to_string(), 9229)
}

fn current_exe_name() -> String {
  std::env::args()
    .next()
    .and_then(|p| {
      Path::new(&p)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
    })
    .filter(|s| s == "jse" || s == "malia")
    .unwrap_or_else(|| "malia".to_string())
}

fn make_argv(file: &str, args: &[String]) -> Vec<String> {
  let mut argv = vec![current_exe_name(), file.to_string()];
  argv.extend(args.iter().cloned());
  argv
}
