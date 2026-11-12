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
      if nm.exists() {
        if let Ok(entries) = std::fs::read_dir(&nm) {
          for entry in entries.flatten() {
            if entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
              // re-run install/postinstall scripts
              js_engine::pkg::run_lifecycle_script_pub(&entry.path(), "install");
              js_engine::pkg::run_lifecycle_script_pub(&entry.path(), "postinstall");
            }
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
