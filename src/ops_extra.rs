// Included from ops.rs (same module). Filesystem, TCP/TLS, zlib, HMAC,
// DNS, and OS ops that back the Node-compatible builtins.
use std::io::Write;

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/// An I/O failure shaped like Node's fs errors: message
/// `ENOENT: no such file or directory, open '/x'` plus `code`, `errno`,
/// `syscall`, and `path` properties.
#[derive(Debug)]
struct NodeIoError {
  code: &'static str,
  errno: i32,
  syscall: String,
  path: Option<String>,
  dest: Option<String>,
  message: String,
}

impl std::fmt::Display for NodeIoError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.message)
  }
}

impl std::error::Error for NodeIoError {}

impl deno_error::JsErrorClass for NodeIoError {
  fn get_class(&self) -> std::borrow::Cow<'static, str> {
    "Error".into()
  }

  fn get_message(&self) -> std::borrow::Cow<'static, str> {
    self.message.clone().into()
  }

  fn get_additional_properties(&self) -> deno_error::AdditionalProperties {
    use deno_error::PropertyValue;
    let mut props: Vec<(std::borrow::Cow<'static, str>, PropertyValue)> = vec![
      ("errno".into(), PropertyValue::Number(self.errno as f64)),
      ("code".into(), PropertyValue::String(self.code.into())),
      ("syscall".into(), PropertyValue::String(self.syscall.clone().into())),
    ];
    if let Some(path) = &self.path {
      props.push(("path".into(), PropertyValue::String(path.clone().into())));
    }
    if let Some(dest) = &self.dest {
      props.push(("dest".into(), PropertyValue::String(dest.clone().into())));
    }
    Box::new(props.into_iter())
  }

  fn get_ref(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
    self
  }
}

/// libuv's description for common error codes (what Node prints).
fn uv_description(code: &str) -> Option<&'static str> {
  Some(match code {
    "ENOENT" => "no such file or directory",
    "EEXIST" => "file already exists",
    "EACCES" => "permission denied",
    "EPERM" => "operation not permitted",
    "EISDIR" => "illegal operation on a directory",
    "ENOTDIR" => "not a directory",
    "ENOTEMPTY" => "directory not empty",
    "EBADF" => "bad file descriptor",
    "EINVAL" => "invalid argument",
    "EMFILE" => "too many open files",
    "ELOOP" => "too many symbolic links encountered",
    "EXDEV" => "cross-device link not permitted",
    "ENAMETOOLONG" => "name too long",
    "EBUSY" => "resource busy or locked",
    "ENOSPC" => "no space left on device",
    "EROFS" => "read-only file system",
    "EAGAIN" => "resource temporarily unavailable",
    "ECONNREFUSED" => "connection refused",
    "ECONNRESET" => "connection reset by peer",
    "EADDRINUSE" => "address already in use",
    "ETIMEDOUT" => "connection timed out",
    "EPIPE" => "broken pipe",
    _ => return None,
  })
}

/// Node's errno: libuv's negated error number. On Unix that is the OS errno;
/// on Windows libuv has its own numbering (uv/errno.h).
fn uv_errno(code: &str, err: &std::io::Error) -> i32 {
  if cfg!(windows) {
    return match code {
      "ENOENT" => -4058,
      "EEXIST" => -4075,
      "EACCES" => -4092,
      "EPERM" => -4048,
      "EISDIR" => -4068,
      "ENOTDIR" => -4052,
      "ENOTEMPTY" => -4051,
      "EBADF" => -4083,
      "EINVAL" => -4071,
      "EMFILE" => -4066,
      "ELOOP" => -4067,
      "EXDEV" => -4037,
      "ENAMETOOLONG" => -4064,
      "EBUSY" => -4082,
      "ENOSPC" => -4055,
      "EROFS" => -4036,
      "EAGAIN" => -4088,
      "ECONNREFUSED" => -4078,
      "ECONNRESET" => -4077,
      "EADDRINUSE" => -4091,
      "ETIMEDOUT" => -4039,
      "EPIPE" => -4047,
      _ => -4070, // EIO
    };
  }
  err.raw_os_error().map_or(-5, |n| -n)
}

fn node_io_error(syscall: &str, path: Option<&str>, dest: Option<&str>, err: std::io::Error) -> JsErrorBox {
  let code = deno_error::get_error_code(&err).unwrap_or("EIO");
  let description = uv_description(code).map(str::to_string).unwrap_or_else(|| {
    // Strip Rust's " (os error N)" suffix and lowercase like libuv.
    let text = err.to_string();
    let text = text.split(" (os error").next().unwrap_or(&text).to_string();
    let mut chars = text.chars();
    chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default()
  });
  let mut message = format!("{code}: {description}, {syscall}");
  if let Some(path) = path {
    message.push_str(&format!(" '{path}'"));
  }
  if let Some(dest) = dest {
    message.push_str(&format!(" -> '{dest}'"));
  }
  let errno = uv_errno(code, &err);
  JsErrorBox::from_err(NodeIoError {
    code,
    errno,
    syscall: syscall.to_string(),
    path: path.map(str::to_string),
    dest: dest.map(str::to_string),
    message,
  })
}

fn io_box(syscall: &str, path: &str, err: std::io::Error) -> JsErrorBox {
  node_io_error(syscall, Some(path), None, err)
}

fn io_box_dest(syscall: &str, path: &str, dest: &str, err: std::io::Error) -> JsErrorBox {
  node_io_error(syscall, Some(path), Some(dest), err)
}

fn io_box_fd(syscall: &str, err: std::io::Error) -> JsErrorBox {
  node_io_error(syscall, None, None, err)
}

/// Run blocking host work off the isolate thread. The JS event loop keeps
/// polling timers, sockets, and other tasks while this runs. The pool is
/// larger than Node's default libuv pool (4), so concurrent file and
/// compression work overlaps instead of queueing behind four workers.
async fn off_thread<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, JsErrorBox> + Send + 'static,
) -> Result<T, JsErrorBox> {
  match tokio::task::spawn_blocking(work).await {
    Ok(result) => result,
    Err(err) => Err(JsErrorBox::generic(format!("blocking task: {err}"))),
  }
}

#[derive(serde::Serialize)]
struct DirEntryInfo {
  name: String,
  is_file: bool,
  is_dir: bool,
  is_symlink: bool,
}

fn readdir_at(path: &str) -> Result<Vec<DirEntryInfo>, JsErrorBox> {
  crate::permissions::check_read(path)?;
  let mut out = Vec::new();
  for entry in std::fs::read_dir(path).map_err(|e| io_box("readdir", path, e))? {
    let entry = entry.map_err(|e| io_box("readdir", path, e))?;
    let file_type = entry.file_type().map_err(|e| io_box("readdir", path, e))?;
    out.push(DirEntryInfo {
      name: entry.file_name().to_string_lossy().into_owned(),
      is_file: file_type.is_file(),
      is_dir: file_type.is_dir(),
      is_symlink: file_type.is_symlink(),
    });
  }
  out.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(out)
}

#[op2]
#[serde]
pub fn op_readdir_sync(#[string] path: String) -> Result<Vec<DirEntryInfo>, JsErrorBox> {
  readdir_at(&path)
}

fn mkdir_at(path: &str, recursive: bool) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(path)?;
  let result = if recursive {
    std::fs::create_dir_all(path)
  } else {
    std::fs::create_dir(path)
  };
  result.map_err(|e| io_box("mkdir", path, e))
}

#[op2(fast)]
pub fn op_mkdir_sync(#[string] path: String, recursive: bool) -> Result<(), JsErrorBox> {
  mkdir_at(&path, recursive)
}

/// kind: 0 unlink, 1 rmdir, 2 rm. `force` swallows NotFound.
fn remove_at(path: &str, kind: u32, recursive: bool, force: bool) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(path)?;
  let p = std::path::Path::new(path);
  let result = match kind {
    0 => std::fs::remove_file(p),
    1 => std::fs::remove_dir(p),
    _ if recursive => std::fs::remove_dir_all(p),
    _ if p.is_dir() => std::fs::remove_dir(p),
    _ => std::fs::remove_file(p),
  };
  match result {
    Ok(()) => Ok(()),
    Err(e) if force && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(io_box("rm", path, e)),
  }
}

#[op2(fast)]
pub fn op_remove_sync(
  #[string] path: String,
  kind: u32,
  recursive: bool,
  force: bool,
) -> Result<(), JsErrorBox> {
  remove_at(&path, kind, recursive, force)
}

fn rename_at(from: &str, to: &str) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(from)?;
  crate::permissions::check_write(to)?;
  std::fs::rename(from, to).map_err(|e| io_box_dest("rename", from, to, e))
}

#[op2(fast)]
pub fn op_rename_sync(#[string] from: String, #[string] to: String) -> Result<(), JsErrorBox> {
  rename_at(&from, &to)
}

/// `excl` is COPYFILE_EXCL: fail with EEXIST instead of overwriting.
fn copy_file_at(from: &str, to: &str, excl: bool) -> Result<(), JsErrorBox> {
  crate::permissions::check_read(from)?;
  crate::permissions::check_write(to)?;
  let err = |e| io_box_dest("copyfile", from, to, e);
  if excl {
    let mut src = std::fs::File::open(from).map_err(err)?;
    let mut dst = std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(to)
      .map_err(err)?;
    std::io::copy(&mut src, &mut dst).map_err(err)?;
    let perms = src.metadata().map_err(err)?.permissions();
    return dst.set_permissions(perms).map_err(err);
  }
  std::fs::copy(from, to).map(|_| ()).map_err(err)
}

#[op2(fast)]
pub fn op_copy_file_sync(#[string] from: String, #[string] to: String, excl: bool) -> Result<(), JsErrorBox> {
  copy_file_at(&from, &to, excl)
}

fn append_bytes_at(path: &str, data: &[u8]) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(path)?;
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(|e| io_box("open", path, e))?;
  file.write_all(data).map_err(|e| io_box("open", path, e))
}

#[op2(fast)]
pub fn op_append_bytes_sync(#[string] path: String, #[buffer] data: &[u8]) -> Result<(), JsErrorBox> {
  append_bytes_at(&path, data)
}

fn realpath_at(path: &str) -> Result<String, JsErrorBox> {
  crate::permissions::check_read(path)?;
  let full = std::fs::canonicalize(path).map_err(|e| io_box("realpath", path, e))?;
  let text = full.to_string_lossy().into_owned();
  crate::permissions::check_read(&text)?;
  Ok(text)
}

#[op2]
#[string]
pub fn op_realpath_sync(#[string] path: String) -> Result<String, JsErrorBox> {
  realpath_at(&path)
}

fn access_at(path: &str, mode: u32) -> Result<(), JsErrorBox> {
  crate::permissions::check_read(path)?;
  let meta = std::fs::metadata(path).map_err(|e| io_box("access", path, e))?;
  if mode != 0 && crate::platform::access_denied(&meta, mode) {
    return Err(io_box("access", path, std::io::ErrorKind::PermissionDenied.into()));
  }
  Ok(())
}

#[op2(fast)]
pub fn op_access_sync(#[string] path: String, mode: u32) -> Result<(), JsErrorBox> {
  access_at(&path, mode)
}

fn chmod_at(path: &str, mode: u32) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(path)?;
  crate::platform::set_mode(path, mode).map_err(|e| io_box("chmod", path, e))
}

#[op2(fast)]
pub fn op_chmod_sync(#[string] path: String, mode: u32) -> Result<(), JsErrorBox> {
  chmod_at(&path, mode)
}

fn truncate_at(path: &str, len: f64) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(path)?;
  let file = std::fs::OpenOptions::new()
    .write(true)
    .open(path)
    .map_err(|e| io_box("open", path, e))?;
  file
    .set_len(len.max(0.0) as u64)
    .map_err(|e| io_box("open", path, e))
}

#[op2(fast)]
pub fn op_truncate_sync(#[string] path: String, len: f64) -> Result<(), JsErrorBox> {
  truncate_at(&path, len)
}

fn read_range_at(path: &str, offset: f64, len: u32) -> Result<Vec<u8>, JsErrorBox> {
  use std::io::Read;
  use std::io::Seek;
  crate::permissions::check_read(path)?;
  if offset < 0.0 {
    return Err(JsErrorBox::generic("read: negative offset"));
  }
  let len = (len as usize).min(1024 * 1024);
  let mut file = std::fs::File::open(path).map_err(|e| io_box("open", path, e))?;
  file
    .seek(std::io::SeekFrom::Start(offset as u64))
    .map_err(|e| io_box("open", path, e))?;
  let mut buf = vec![0u8; len];
  let n = file.read(&mut buf).map_err(|e| io_box("open", path, e))?;
  buf.truncate(n);
  Ok(buf)
}

#[op2]
#[buffer]
pub fn op_read_range(#[string] path: String, offset: f64, len: u32) -> Result<Vec<u8>, JsErrorBox> {
  read_range_at(&path, offset, len)
}

fn symlink_at(target: &str, link: &str) -> Result<(), JsErrorBox> {
  // The target may not exist; only the new link path is a write.
  crate::permissions::check_write(link)?;
  crate::platform::symlink(target, link).map_err(|e| io_box_dest("symlink", target, link, e))
}

#[op2(fast)]
pub fn op_symlink_sync(#[string] target: String, #[string] link: String) -> Result<(), JsErrorBox> {
  symlink_at(&target, &link)
}

fn readlink_at(path: &str) -> Result<String, JsErrorBox> {
  crate::permissions::check_read(path)?;
  let target = std::fs::read_link(path).map_err(|e| io_box("readlink", path, e))?;
  Ok(target.to_string_lossy().into_owned())
}

#[op2]
#[string]
pub fn op_readlink_sync(#[string] path: String) -> Result<String, JsErrorBox> {
  readlink_at(&path)
}

fn random_alnum(n: usize) -> String {
  const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let mut buf = vec![0u8; n];
  getrandom::fill(&mut buf).ok();
  buf
    .into_iter()
    .map(|b| CHARS[(b as usize) % CHARS.len()] as char)
    .collect()
}

fn mkdtemp_at(prefix: &str) -> Result<String, JsErrorBox> {
  let template = if prefix.ends_with("XXXXXX") {
    prefix.to_string()
  } else {
    format!("{prefix}XXXXXX")
  };
  let stem = &template[..template.len() - 6];
  for _ in 0..64 {
    let name = format!("{stem}{}", random_alnum(6));
    crate::permissions::check_write(&name)?;
    match std::fs::create_dir(&name) {
      Ok(()) => return Ok(name),
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(io_box("mkdtemp", &name, e)),
    }
  }
  Err(JsErrorBox::generic("mkdtemp: failed to create a unique directory"))
}

#[op2]
#[string]
pub fn op_mkdtemp_sync(#[string] prefix: String) -> Result<String, JsErrorBox> {
  mkdtemp_at(&prefix)
}

#[op2]
#[serde]
pub async fn op_readdir(#[string] path: String) -> Result<Vec<DirEntryInfo>, JsErrorBox> {
  off_thread(move || readdir_at(&path)).await
}

#[op2]
pub async fn op_mkdir(#[string] path: String, recursive: bool) -> Result<(), JsErrorBox> {
  off_thread(move || mkdir_at(&path, recursive)).await
}

#[op2]
pub async fn op_remove(
  #[string] path: String,
  kind: u32,
  recursive: bool,
  force: bool,
) -> Result<(), JsErrorBox> {
  off_thread(move || remove_at(&path, kind, recursive, force)).await
}

#[op2]
pub async fn op_rename(#[string] from: String, #[string] to: String) -> Result<(), JsErrorBox> {
  off_thread(move || rename_at(&from, &to)).await
}

#[op2]
pub async fn op_copy_file(#[string] from: String, #[string] to: String, excl: bool) -> Result<(), JsErrorBox> {
  off_thread(move || copy_file_at(&from, &to, excl)).await
}

fn file_times(atime_secs: f64, mtime_secs: f64) -> std::fs::FileTimes {
  let at = |secs: f64| std::time::UNIX_EPOCH + std::time::Duration::from_secs_f64(secs.max(0.0));
  std::fs::FileTimes::new().set_accessed(at(atime_secs)).set_modified(at(mtime_secs))
}

fn utimes_at(path: &str, atime_secs: f64, mtime_secs: f64) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(path)?;
  let file = crate::platform::open_for_set_times(path).map_err(|e| io_box("utime", path, e))?;
  file
    .set_times(file_times(atime_secs, mtime_secs))
    .map_err(|e| io_box("utime", path, e))
}

#[op2(fast)]
pub fn op_utimes_sync(#[string] path: String, atime_secs: f64, mtime_secs: f64) -> Result<(), JsErrorBox> {
  utimes_at(&path, atime_secs, mtime_secs)
}

#[op2]
pub async fn op_utimes(#[string] path: String, atime_secs: f64, mtime_secs: f64) -> Result<(), JsErrorBox> {
  off_thread(move || utimes_at(&path, atime_secs, mtime_secs)).await
}

fn link_at(existing: &str, new_path: &str) -> Result<(), JsErrorBox> {
  crate::permissions::check_read(existing)?;
  crate::permissions::check_write(new_path)?;
  std::fs::hard_link(existing, new_path).map_err(|e| io_box_dest("link", existing, new_path, e))
}

#[op2(fast)]
pub fn op_link_sync(#[string] existing: String, #[string] new_path: String) -> Result<(), JsErrorBox> {
  link_at(&existing, &new_path)
}

#[op2]
pub async fn op_link(#[string] existing: String, #[string] new_path: String) -> Result<(), JsErrorBox> {
  off_thread(move || link_at(&existing, &new_path)).await
}

#[op2]
pub async fn op_append_bytes(
  #[string] path: String,
  #[buffer(copy)] data: Vec<u8>,
) -> Result<(), JsErrorBox> {
  off_thread(move || append_bytes_at(&path, &data)).await
}

#[op2]
#[string]
pub async fn op_realpath(#[string] path: String) -> Result<String, JsErrorBox> {
  off_thread(move || realpath_at(&path)).await
}

#[op2]
pub async fn op_access(#[string] path: String, mode: u32) -> Result<(), JsErrorBox> {
  off_thread(move || access_at(&path, mode)).await
}

#[op2]
pub async fn op_chmod(#[string] path: String, mode: u32) -> Result<(), JsErrorBox> {
  off_thread(move || chmod_at(&path, mode)).await
}

#[op2]
pub async fn op_truncate(#[string] path: String, len: f64) -> Result<(), JsErrorBox> {
  off_thread(move || truncate_at(&path, len)).await
}

#[op2]
#[buffer]
pub async fn op_read_range_at(
  #[string] path: String,
  offset: f64,
  len: u32,
) -> Result<Vec<u8>, JsErrorBox> {
  off_thread(move || read_range_at(&path, offset, len)).await
}

#[op2]
pub async fn op_symlink(#[string] target: String, #[string] link: String) -> Result<(), JsErrorBox> {
  off_thread(move || symlink_at(&target, &link)).await
}

#[op2]
#[string]
pub async fn op_readlink(#[string] path: String) -> Result<String, JsErrorBox> {
  off_thread(move || readlink_at(&path)).await
}

#[op2]
#[string]
pub async fn op_mkdtemp(#[string] prefix: String) -> Result<String, JsErrorBox> {
  off_thread(move || mkdtemp_at(&prefix)).await
}

#[op2(fast)]
pub fn op_chdir(#[string] path: String) -> Result<(), JsErrorBox> {
  crate::permissions::check_read(&path)?;
  std::env::set_current_dir(&path).map_err(|e| io_box("chdir", &path, e))
}

#[derive(serde::Serialize)]
struct FsConstants {
  #[serde(rename = "F_OK")]
  f_ok: i32,
  #[serde(rename = "R_OK")]
  r_ok: i32,
  #[serde(rename = "W_OK")]
  w_ok: i32,
  #[serde(rename = "X_OK")]
  x_ok: i32,
  #[serde(rename = "O_RDONLY")]
  o_rdonly: i32,
  #[serde(rename = "O_WRONLY")]
  o_wronly: i32,
  #[serde(rename = "O_RDWR")]
  o_rdwr: i32,
  #[serde(rename = "O_APPEND")]
  o_append: i32,
  #[serde(rename = "O_CREAT")]
  o_creat: i32,
  #[serde(rename = "O_EXCL")]
  o_excl: i32,
  #[serde(rename = "O_TRUNC")]
  o_trunc: i32,
  #[serde(rename = "O_SYNC")]
  o_sync: i32,
}

#[op2]
#[serde]
pub fn op_fs_constants() -> FsConstants {
  use crate::platform::{F_OK, R_OK, W_OK, X_OK};
  let [o_rdonly, o_wronly, o_rdwr, o_append, o_creat, o_excl, o_trunc, o_sync] = crate::platform::open_flags();
  FsConstants {
    f_ok: F_OK as i32,
    r_ok: R_OK as i32,
    w_ok: W_OK as i32,
    x_ok: X_OK as i32,
    o_rdonly,
    o_wronly,
    o_rdwr,
    o_append,
    o_creat,
    o_excl,
    o_trunc,
    o_sync,
  }
}

#[op2]
#[serde]
pub fn op_lstat_sync(#[string] path: String) -> Result<StatInfo, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  stat_info(&path, false)
}

#[op2]
#[serde]
pub async fn op_lstat(#[string] path: String) -> Result<StatInfo, JsErrorBox> {
  off_thread(move || {
    crate::permissions::check_read(&path)?;
    stat_info(&path, false)
  })
  .await
}

// ---------------------------------------------------------------------------
// TCP + TLS client
// ---------------------------------------------------------------------------

enum NetReader {
  Tcp(tokio::net::tcp::OwnedReadHalf),
  Tls(tokio::io::ReadHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>),
  #[cfg(unix)]
  Unix(tokio::net::unix::OwnedReadHalf),
  #[cfg(windows)]
  Pipe(PipeIo),
}

enum NetWriter {
  Tcp(tokio::net::tcp::OwnedWriteHalf),
  Tls(tokio::io::WriteHalf<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>),
  #[cfg(unix)]
  Unix(tokio::net::unix::OwnedWriteHalf),
  #[cfg(windows)]
  Pipe(PipeIo),
}

/// One named-pipe instance shared by the read and write halves.
///
/// `tokio::io::split` keeps the handle alive until both halves drop, and
/// `AsyncWrite::poll_shutdown` only flushes. The peer's `ReadFile` then
/// blocks forever. Closing the last `Arc` is what delivers EOF (unread
/// bytes stay readable; the next read is `ERROR_BROKEN_PIPE`).
#[cfg(windows)]
#[derive(Clone)]
struct PipeIo {
  pipe: WinPipe,
  close: Arc<std::sync::atomic::AtomicBool>,
  wake: Arc<tokio::sync::Notify>,
}

#[cfg(windows)]
#[derive(Clone)]
enum WinPipe {
  Server(Arc<tokio::net::windows::named_pipe::NamedPipeServer>),
  Client(Arc<tokio::net::windows::named_pipe::NamedPipeClient>),
}

#[cfg(windows)]
fn pipe_pair(pipe: WinPipe) -> (NetReader, NetWriter) {
  let io = PipeIo {
    pipe,
    close: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    wake: Arc::new(tokio::sync::Notify::new()),
  };
  (NetReader::Pipe(io.clone()), NetWriter::Pipe(io))
}

#[cfg(windows)]
fn is_pipe_eof(err: &std::io::Error) -> bool {
  // 109 ERROR_BROKEN_PIPE, 232 ERROR_NO_DATA, 233 ERROR_PIPE_NOT_CONNECTED.
  matches!(err.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset)
    || matches!(err.raw_os_error(), Some(109) | Some(232) | Some(233))
}

struct Conn {
  reader: Option<NetReader>,
  writer: Option<NetWriter>,
  closed: bool,
}

struct ServerSlot {
  shutdown: Option<tokio::sync::oneshot::Sender<()>>,
  incoming: Arc<TokioMutex<mpsc::UnboundedReceiver<ConnInfo>>>,
}

#[derive(Default)]
struct NetInner {
  next_id: u32,
  conns: HashMap<u32, Conn>,
  servers: HashMap<u32, ServerSlot>,
}

struct NetState {
  inner: Arc<StdMutex<NetInner>>,
}

fn net_inner(state: &mut OpState) -> Arc<StdMutex<NetInner>> {
  if !state.has::<NetState>() {
    state.put(NetState {
      inner: Arc::new(StdMutex::new(NetInner::default())),
    });
  }
  state.borrow::<NetState>().inner.clone()
}

#[derive(Clone, serde::Serialize)]
struct ConnInfo {
  id: u32,
  remote_address: String,
  remote_port: u16,
  local_address: String,
  local_port: u16,
}

fn conn_info(id: u32, peer: std::net::SocketAddr, local: Option<std::net::SocketAddr>) -> ConnInfo {
  ConnInfo {
    id,
    remote_address: peer.ip().to_string(),
    remote_port: peer.port(),
    local_address: local.map(|a| a.ip().to_string()).unwrap_or_default(),
    local_port: local.map(|a| a.port()).unwrap_or(0),
  }
}

fn insert_conn(inner: &StdMutex<NetInner>, reader: NetReader, writer: NetWriter, info_peer: std::net::SocketAddr, local: Option<std::net::SocketAddr>) -> ConnInfo {
  let mut guard = inner.lock().unwrap();
  let id = guard.next_id;
  guard.next_id += 1;
  guard.conns.insert(
    id,
    Conn {
      reader: Some(reader),
      writer: Some(writer),
      closed: false,
    },
  );
  conn_info(id, info_peer, local)
}

/// Windows named pipe paths (\\.\pipe\name, \\?\pipe\name).
#[cfg(windows)]
fn is_pipe_name(path: &str) -> bool {
  let lower = path.to_ascii_lowercase();
  lower.starts_with(r"\\.\pipe\") || lower.starts_with(r"\\?\pipe\")
}

#[cfg(any(unix, windows))]
fn insert_conn_unix(inner: &StdMutex<NetInner>, reader: NetReader, writer: NetWriter, path: &str) -> ConnInfo {
  let mut guard = inner.lock().unwrap();
  let id = guard.next_id;
  guard.next_id += 1;
  guard.conns.insert(
    id,
    Conn {
      reader: Some(reader),
      writer: Some(writer),
      closed: false,
    },
  );
  ConnInfo {
    id,
    remote_address: path.to_string(),
    remote_port: 0,
    local_address: path.to_string(),
    local_port: 0,
  }
}

#[derive(serde::Serialize)]
struct ListenInfo {
  id: u32,
  port: u16,
  host: String,
}

#[op2]
#[serde]
pub async fn op_net_listen(
  state: Rc<RefCell<OpState>>,
  #[string] host: String,
  port: u32,
) -> Result<ListenInfo, JsErrorBox> {
  #[cfg(unix)]
  if port == 0 && (host.starts_with('/') || host.starts_with('.')) {
    crate::permissions::check_write(&host)?;
    let _ = std::fs::remove_file(&host);
    let listener = tokio::net::UnixListener::bind(&host)
      .map_err(|e| JsErrorBox::generic(format!("listen unix {host}: {e}")))?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (acc_tx, acc_rx) = mpsc::unbounded_channel();
    let inner = {
      let mut st = state.borrow_mut();
      net_inner(&mut st)
    };
    let id = {
      let mut guard = inner.lock().unwrap();
      let id = guard.next_id;
      guard.next_id += 1;
      guard.servers.insert(
        id,
        ServerSlot {
          shutdown: Some(shutdown_tx),
          incoming: Arc::new(TokioMutex::new(acc_rx)),
        },
      );
      id
    };
    let task_inner = inner.clone();
    let sock_path = host.clone();
    tokio::spawn(async move {
      let mut shutdown_rx = shutdown_rx;
      loop {
        let accepted = tokio::select! {
          biased;
          _ = &mut shutdown_rx => break,
          result = listener.accept() => result,
        };
        let Ok((stream, _)) = accepted else { break };
        let (reader, writer) = stream.into_split();
        let conn_id = {
          let mut guard = task_inner.lock().unwrap();
          let conn_id = guard.next_id;
          guard.next_id += 1;
          guard.conns.insert(
            conn_id,
            Conn {
              reader: Some(NetReader::Unix(reader)),
              writer: Some(NetWriter::Unix(writer)),
              closed: false,
            },
          );
          conn_id
        };
        if acc_tx.send(ConnInfo {
          id: conn_id,
          remote_address: sock_path.clone(),
          remote_port: 0,
          local_address: sock_path.clone(),
          local_port: 0,
        }).is_err() {
          break;
        }
      }
    });
    return Ok(ListenInfo {
      id,
      port: 0,
      host,
    });
  }

  // Windows named pipe server: one pipe instance per client; the next
  // instance is created before a connected one is handed off, so a client
  // arriving in between is not refused.
  #[cfg(windows)]
  if port == 0 && is_pipe_name(&host) {
    use tokio::net::windows::named_pipe::ServerOptions;
    crate::permissions::check_write(&host)?;
    let first = ServerOptions::new()
      .first_pipe_instance(true)
      .create(&host)
      .map_err(|e| io_box("listen", &host, e))?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (acc_tx, acc_rx) = mpsc::unbounded_channel();
    let inner = {
      let mut st = state.borrow_mut();
      net_inner(&mut st)
    };
    let id = {
      let mut guard = inner.lock().unwrap();
      let id = guard.next_id;
      guard.next_id += 1;
      guard.servers.insert(
        id,
        ServerSlot {
          shutdown: Some(shutdown_tx),
          incoming: Arc::new(TokioMutex::new(acc_rx)),
        },
      );
      id
    };
    let task_inner = inner.clone();
    let pipe_name = host.clone();
    tokio::spawn(async move {
      let mut shutdown_rx = shutdown_rx;
      let mut server = first;
      loop {
        let connected = tokio::select! {
          biased;
          _ = &mut shutdown_rx => break,
          result = server.connect() => result,
        };
        if connected.is_err() {
          break;
        }
        let Ok(next) = ServerOptions::new().create(&pipe_name) else { break };
        let connected = std::mem::replace(&mut server, next);
        let (reader, writer) = pipe_pair(WinPipe::Server(Arc::new(connected)));
        let info = insert_conn_unix(&task_inner, reader, writer, &pipe_name);
        if acc_tx.send(info).is_err() {
          break;
        }
      }
    });
    return Ok(ListenInfo { id, port: 0, host });
  }

  crate::permissions::check_net(&host)?;
  let std_listener = bind_reuse_tcp(host.as_str(), port as u16)
    .map_err(|e| JsErrorBox::generic(format!("listen {host}:{port}: {e}")))?;
  let listener = tokio::net::TcpListener::from_std(std_listener)
    .map_err(|e| JsErrorBox::generic(format!("listen {host}:{port}: {e}")))?;
  let local = listener
    .local_addr()
    .map_err(|e| JsErrorBox::generic(format!("listen: {e}")))?;
  let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
  let (acc_tx, acc_rx) = mpsc::unbounded_channel();
  let inner = {
    let mut st = state.borrow_mut();
    net_inner(&mut st)
  };
  let id = {
    let mut guard = inner.lock().unwrap();
    let id = guard.next_id;
    guard.next_id += 1;
    guard.servers.insert(
      id,
      ServerSlot {
        shutdown: Some(shutdown_tx),
        incoming: Arc::new(TokioMutex::new(acc_rx)),
      },
    );
    id
  };
  let task_inner = inner.clone();
  tokio::spawn(async move {
    let mut shutdown_rx = shutdown_rx;
    loop {
      let accepted = tokio::select! {
        biased;
        _ = &mut shutdown_rx => break,
        result = listener.accept() => result,
      };
      let Ok((stream, peer)) = accepted else { break };
      let local_addr = stream.local_addr().ok();
      let (reader, writer) = stream.into_split();
      let conn_id = {
        let mut guard = task_inner.lock().unwrap();
        let conn_id = guard.next_id;
        guard.next_id += 1;
        guard.conns.insert(
          conn_id,
          Conn {
            reader: Some(NetReader::Tcp(reader)),
            writer: Some(NetWriter::Tcp(writer)),
            closed: false,
          },
        );
        conn_id
      };
      if acc_tx.send(conn_info(conn_id, peer, local_addr)).is_err() {
        break;
      }
    }
  });
  Ok(ListenInfo {
    id,
    port: local.port(),
    host: local.ip().to_string(),
  })
}

#[op2]
#[serde]
pub async fn op_net_accept(
  state: Rc<RefCell<OpState>>,
  id: u32,
) -> Result<Option<ConnInfo>, JsErrorBox> {
  let incoming = {
    let st = state.borrow();
    let Some(inner) = try_net(&st) else {
      return Ok(None);
    };
    let guard = inner.lock().unwrap();
    guard.servers.get(&id).map(|slot| slot.incoming.clone())
  };
  let Some(incoming) = incoming else {
    return Ok(None);
  };
  let mut rx = incoming.lock().await;
  Ok(rx.recv().await)
}

fn try_net(state: &OpState) -> Option<Arc<StdMutex<NetInner>>> {
  state.try_borrow::<NetState>().map(|net| net.inner.clone())
}

#[op2]
#[serde]
pub async fn op_net_connect(
  state: Rc<RefCell<OpState>>,
  #[string] host: String,
  port: u32,
) -> Result<ConnInfo, JsErrorBox> {
  #[cfg(unix)]
  if port == 0 || host.starts_with('/') || host.starts_with('.') {
    crate::permissions::check_read(&host)?;
    crate::permissions::check_write(&host)?;
    let stream = tokio::net::UnixStream::connect(&host)
      .await
      .map_err(|e| JsErrorBox::generic(format!("connect unix {host}: {e}")))?;
    let (reader, writer) = stream.into_split();
    let inner = {
      let mut st = state.borrow_mut();
      net_inner(&mut st)
    };
    return Ok(insert_conn_unix(&inner, NetReader::Unix(reader), NetWriter::Unix(writer), &host));
  }

  #[cfg(windows)]
  if is_pipe_name(&host) {
    use tokio::net::windows::named_pipe::ClientOptions;
    crate::permissions::check_read(&host)?;
    crate::permissions::check_write(&host)?;
    // The listen task has to reach ConnectNamedPipe before open() succeeds.
    // Until then Windows returns ERROR_PIPE_BUSY (231). A bounded retry
    // yields so that task can run; giving up beats hanging the test runner.
    tokio::task::yield_now().await;
    let mut tries = 0u32;
    let client = loop {
      match ClientOptions::new().open(&host) {
        Ok(client) => break client,
        Err(e) if e.raw_os_error() == Some(231) && tries < 250 => {
          tries += 1;
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        Err(e) => return Err(io_box("connect", &host, e)),
      }
    };
    let (reader, writer) = pipe_pair(WinPipe::Client(Arc::new(client)));
    let inner = {
      let mut st = state.borrow_mut();
      net_inner(&mut st)
    };
    return Ok(insert_conn_unix(&inner, reader, writer, &host));
  }

  crate::permissions::check_net(&host)?;
  let stream = tokio::net::TcpStream::connect((host.as_str(), port as u16))
    .await
    .map_err(|e| JsErrorBox::generic(format!("connect {host}:{port}: {e}")))?;
  let peer = stream
    .peer_addr()
    .map_err(|e| JsErrorBox::generic(format!("connect: {e}")))?;
  let local = stream.local_addr().ok();
  let (reader, writer) = stream.into_split();
  let inner = {
    let mut st = state.borrow_mut();
    net_inner(&mut st)
  };
  Ok(insert_conn(&inner, NetReader::Tcp(reader), NetWriter::Tcp(writer), peer, local))
}

#[derive(Clone, Copy)]
struct NoVerify {
  algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl std::fmt::Debug for NoVerify {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("NoVerify")
  }
}

impl rustls::client::danger::ServerCertVerifier for NoVerify {
  fn verify_server_cert(
    &self,
    _end_entity: &rustls::pki_types::CertificateDer<'_>,
    _intermediates: &[rustls::pki_types::CertificateDer<'_>],
    _server_name: &rustls::pki_types::ServerName<'_>,
    _ocsp_response: &[u8],
    _now: rustls::pki_types::UnixTime,
  ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
    // Chain trust is skipped. Handshake signatures are still checked below.
    Ok(rustls::client::danger::ServerCertVerified::assertion())
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &rustls::pki_types::CertificateDer<'_>,
    dss: &rustls::DigitallySignedStruct,
  ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &rustls::pki_types::CertificateDer<'_>,
    dss: &rustls::DigitallySignedStruct,
  ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
  }

  fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
    self.algorithms.supported_schemes()
  }
}

fn tls_client_config(insecure: bool) -> Arc<rustls::ClientConfig> {
  static SECURE: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
  static INSECURE: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
  let cell = if insecure { &INSECURE } else { &SECURE };
  cell
    .get_or_init(|| {
      let provider = rustls::crypto::aws_lc_rs::default_provider();
      let algorithms = provider.signature_verification_algorithms;
      let builder = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("rustls default protocol versions");
      let config = if insecure {
        builder
          .dangerous()
          .with_custom_certificate_verifier(Arc::new(NoVerify { algorithms }))
          .with_no_client_auth()
      } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        builder.with_root_certificates(roots).with_no_client_auth()
      };
      Arc::new(config)
    })
    .clone()
}

#[op2]
#[serde]
pub async fn op_tls_connect(
  state: Rc<RefCell<OpState>>,
  #[string] host: String,
  port: u32,
  #[string] servername: String,
  insecure: bool,
) -> Result<ConnInfo, JsErrorBox> {
  crate::permissions::check_net(&host)?;
  let stream = tokio::net::TcpStream::connect((host.as_str(), port as u16))
    .await
    .map_err(|e| JsErrorBox::generic(format!("connect {host}:{port}: {e}")))?;
  let peer = stream
    .peer_addr()
    .map_err(|e| JsErrorBox::generic(format!("connect: {e}")))?;
  let local = stream.local_addr().ok();
  let name = rustls::pki_types::ServerName::try_from(servername.as_str())
    .map_err(|_| JsErrorBox::generic(format!("invalid server name '{servername}'")))?
    .to_owned();
  let connector = tokio_rustls::TlsConnector::from(tls_client_config(insecure));
  let tls = connector
    .connect(name, stream)
    .await
    .map_err(|e| JsErrorBox::generic(format!("tls handshake {servername}: {e}")))?;
  let (reader, writer) = tokio::io::split(tls);
  let inner = {
    let mut st = state.borrow_mut();
    net_inner(&mut st)
  };
  Ok(insert_conn(&inner, NetReader::Tls(reader), NetWriter::Tls(writer), peer, local))
}

async fn read_some(reader: &mut NetReader) -> std::io::Result<Vec<u8>> {
  use tokio::io::AsyncReadExt;
  let mut buf = vec![0u8; 16 * 1024];
  let n = match reader {
    NetReader::Tcp(r) => r.read(&mut buf).await?,
    NetReader::Tls(r) => r.read(&mut buf).await?,
    #[cfg(unix)]
    NetReader::Unix(r) => r.read(&mut buf).await?,
    #[cfg(windows)]
    NetReader::Pipe(io) => return read_win_pipe(io).await,
  };
  buf.truncate(n);
  Ok(buf)
}

#[cfg(windows)]
async fn read_win_pipe(io: &PipeIo) -> std::io::Result<Vec<u8>> {
  let mut buf = vec![0u8; 16 * 1024];
  loop {
    // Subscribe before checking the flag so a shutdown between the check
    // and the wait cannot be missed (`notify_one` stores a permit).
    let notified = io.wake.notified();
    if io.close.load(Ordering::Acquire) {
      return Ok(Vec::new());
    }
    tokio::select! {
      biased;
      _ = notified => continue,
      ready = pipe_readable(&io.pipe) => {
        ready?;
        match pipe_try_read(&io.pipe, &mut buf) {
          Ok(0) => return Ok(Vec::new()),
          Ok(n) => {
            buf.truncate(n);
            return Ok(buf);
          }
          Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
          Err(e) if is_pipe_eof(&e) => return Ok(Vec::new()),
          Err(e) => return Err(e),
        }
      }
    }
  }
}

#[cfg(windows)]
async fn pipe_readable(pipe: &WinPipe) -> std::io::Result<()> {
  match pipe {
    WinPipe::Server(pipe) => pipe.readable().await,
    WinPipe::Client(pipe) => pipe.readable().await,
  }
}

#[cfg(windows)]
fn pipe_try_read(pipe: &WinPipe, buf: &mut [u8]) -> std::io::Result<usize> {
  match pipe {
    WinPipe::Server(pipe) => pipe.try_read(buf),
    WinPipe::Client(pipe) => pipe.try_read(buf),
  }
}

#[cfg(windows)]
async fn write_win_pipe(io: &PipeIo, data: &[u8]) -> std::io::Result<()> {
  let mut written = 0;
  while written < data.len() {
    if io.close.load(Ordering::Acquire) {
      return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pipe closed"));
    }
    pipe_writable(&io.pipe).await?;
    match pipe_try_write(&io.pipe, &data[written..]) {
      Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "pipe write")),
      Ok(n) => written += n,
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
      Err(e) => return Err(e),
    }
  }
  Ok(())
}

#[cfg(windows)]
async fn pipe_writable(pipe: &WinPipe) -> std::io::Result<()> {
  match pipe {
    WinPipe::Server(pipe) => pipe.writable().await,
    WinPipe::Client(pipe) => pipe.writable().await,
  }
}

#[cfg(windows)]
fn pipe_try_write(pipe: &WinPipe, buf: &[u8]) -> std::io::Result<usize> {
  match pipe {
    WinPipe::Server(pipe) => pipe.try_write(buf),
    WinPipe::Client(pipe) => pipe.try_write(buf),
  }
}

#[op2]
#[buffer]
pub async fn op_net_read(state: Rc<RefCell<OpState>>, id: u32) -> Result<Vec<u8>, JsErrorBox> {
  let reader = {
    let st = state.borrow();
    let Some(inner) = try_net(&st) else {
      return Ok(Vec::new());
    };
    let mut guard = inner.lock().unwrap();
    match guard.conns.get_mut(&id) {
      Some(conn) if !conn.closed => conn.reader.take(),
      _ => return Ok(Vec::new()),
    }
  };
  let Some(mut reader) = reader else {
    return Err(JsErrorBox::generic("socket read already in progress"));
  };
  let result = read_some(&mut reader).await;
  let put_back = match &result {
    Ok(buf) => !buf.is_empty(),
    Err(_) => true,
  };
  if put_back {
    let st = state.borrow();
    if let Some(inner) = try_net(&st) {
      let mut guard = inner.lock().unwrap();
      if let Some(conn) = guard.conns.get_mut(&id) {
        if conn.closed {
          drop(reader);
        } else {
          conn.reader = Some(reader);
        }
      }
    }
  }
  result.map_err(|e| JsErrorBox::generic(format!("socket read: {e}")))
}

#[op2]
pub async fn op_net_write(
  state: Rc<RefCell<OpState>>,
  id: u32,
  #[buffer(copy)] data: Vec<u8>,
) -> Result<(), JsErrorBox> {
  use tokio::io::AsyncWriteExt;
  let writer = {
    let st = state.borrow();
    let Some(inner) = try_net(&st) else {
      return Err(JsErrorBox::generic("socket is closed"));
    };
    let mut guard = inner.lock().unwrap();
    match guard.conns.get_mut(&id) {
      Some(conn) if !conn.closed => conn.writer.take(),
      _ => return Err(JsErrorBox::generic("socket is closed")),
    }
  };
  let Some(mut writer) = writer else {
    return Err(JsErrorBox::generic("socket write already in progress"));
  };
  let result = match &mut writer {
    NetWriter::Tcp(w) => w.write_all(&data).await,
    NetWriter::Tls(w) => w.write_all(&data).await,
    #[cfg(unix)]
    NetWriter::Unix(w) => w.write_all(&data).await,
    #[cfg(windows)]
    NetWriter::Pipe(io) => write_win_pipe(io, &data).await,
  };
  {
    let st = state.borrow();
    if let Some(inner) = try_net(&st) {
      let mut guard = inner.lock().unwrap();
      if let Some(conn) = guard.conns.get_mut(&id)
        && !conn.closed
      {
        conn.writer = Some(writer);
      }
    }
  }
  result.map_err(|e| JsErrorBox::generic(format!("socket write: {e}")))
}

#[op2]
pub async fn op_net_shutdown(state: Rc<RefCell<OpState>>, id: u32) -> Result<(), JsErrorBox> {
  use tokio::io::AsyncWriteExt;
  let writer = {
    let st = state.borrow();
    let Some(inner) = try_net(&st) else {
      return Ok(());
    };
    let mut guard = inner.lock().unwrap();
    let Some(conn) = guard.conns.get_mut(&id) else {
      return Ok(());
    };
    let writer = conn.writer.take();
    #[cfg(windows)]
    if let Some(NetWriter::Pipe(io)) = &writer {
      // Wake an in-flight read so it drops its clone. Together with the
      // writer clone (and an idle reader, dropped here) that closes the
      // instance and the peer observes EOF.
      io.close.store(true, Ordering::Release);
      io.wake.notify_one();
      conn.closed = true;
      conn.reader.take();
    }
    writer
  };
  if let Some(mut writer) = writer {
    let _ = match &mut writer {
      NetWriter::Tcp(w) => w.shutdown().await,
      NetWriter::Tls(w) => w.shutdown().await,
      #[cfg(unix)]
      NetWriter::Unix(w) => w.shutdown().await,
      #[cfg(windows)]
      NetWriter::Pipe(_) => Ok(()),
    };
  }
  Ok(())
}

#[op2(fast)]
pub fn op_net_close(state: &mut OpState, id: u32) {
  let inner = net_inner(state);
  let mut guard = inner.lock().unwrap();
  if let Some(conn) = guard.conns.get_mut(&id) {
    conn.closed = true;
    #[cfg(windows)]
    {
      // The in-flight read holds the other clone and is blocked in
      // `readable()`. Wake it so the last Arc can drop and the peer
      // observes EOF.
      let wake = |io: &PipeIo| {
        io.close.store(true, Ordering::Release);
        io.wake.notify_one();
      };
      if let Some(NetReader::Pipe(io)) = &conn.reader {
        wake(io);
      }
      if let Some(NetWriter::Pipe(io)) = &conn.writer {
        wake(io);
      }
    }
    conn.reader.take();
    conn.writer.take();
  }
}

#[op2(fast)]
pub fn op_net_close_server(state: &mut OpState, id: u32) {
  let inner = net_inner(state);
  let mut guard = inner.lock().unwrap();
  if let Some(slot) = guard.servers.remove(&id) {
    // Dropping the sender ends the accept loop.
    drop(slot.shutdown);
  }
}

// ---------------------------------------------------------------------------
// zlib (gzip / zlib / raw deflate). Brotli stays unsupported in JS.
// ---------------------------------------------------------------------------

enum ZStream {
  GzipEnc(flate2::write::GzEncoder<Vec<u8>>),
  GzipDec(flate2::write::GzDecoder<Vec<u8>>),
  ZlibEnc(flate2::write::ZlibEncoder<Vec<u8>>),
  ZlibDec(flate2::write::ZlibDecoder<Vec<u8>>),
  RawEnc(flate2::write::DeflateEncoder<Vec<u8>>),
  RawDec(flate2::write::DeflateDecoder<Vec<u8>>),
  BrotliEnc(Box<brotli::CompressorWriter<Vec<u8>>>),
  BrotliDec(Box<brotli::DecompressorWriter<Vec<u8>>>),
}

struct ZEntry {
  // Taken out while a write runs on the blocking pool, so a second write
  // cannot use the encoder at the same time and the RefCell is not held
  // across the await.
  stream: Option<ZStream>,
  finished: bool,
}

#[derive(Default)]
struct ZTable {
  next_id: u32,
  entries: HashMap<u32, ZEntry>,
}

fn z_table(state: &mut OpState) -> &mut ZTable {
  if !state.has::<ZTable>() {
    state.put(ZTable::default());
  }
  state.borrow_mut::<ZTable>()
}

fn compression(level: i32) -> flate2::Compression {
  let level = if level < 0 { 6 } else { level.clamp(0, 9) as u32 };
  flate2::Compression::new(level)
}

/// A zlib failure with Node's `code`/`errno` (corrupt input is Z_DATA_ERROR).
#[derive(Debug)]
struct ZlibError(String);

impl std::fmt::Display for ZlibError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for ZlibError {}

impl deno_error::JsErrorClass for ZlibError {
  fn get_class(&self) -> std::borrow::Cow<'static, str> {
    "Error".into()
  }

  fn get_message(&self) -> std::borrow::Cow<'static, str> {
    self.0.clone().into()
  }

  fn get_additional_properties(&self) -> deno_error::AdditionalProperties {
    use deno_error::PropertyValue;
    Box::new(
      [
        ("errno".into(), PropertyValue::Number(-3.0)),
        ("code".into(), PropertyValue::String("Z_DATA_ERROR".into())),
      ]
      .into_iter(),
    )
  }

  fn get_ref(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
    self
  }
}

fn z_feed(stream: &mut ZStream, data: &[u8], finish: bool) -> Result<Vec<u8>, JsErrorBox> {
  use std::io::Write;
  let err = |e: std::io::Error| JsErrorBox::from_err(ZlibError(e.to_string()));
  macro_rules! feed {
    ($enc:expr) => {{
      if !data.is_empty() {
        $enc.write_all(data).map_err(err)?;
      }
      $enc.flush().map_err(err)?;
      if finish {
        $enc.try_finish().map_err(err)?;
      }
      Ok(std::mem::take($enc.get_mut()))
    }};
  }
  match stream {
    ZStream::GzipEnc(enc) => feed!(enc),
    ZStream::GzipDec(enc) => feed!(enc),
    ZStream::ZlibEnc(enc) => feed!(enc),
    ZStream::ZlibDec(enc) => feed!(enc),
    ZStream::RawEnc(enc) => feed!(enc),
    ZStream::RawDec(enc) => feed!(enc),
    ZStream::BrotliEnc(enc) => {
      if !data.is_empty() {
        enc.write_all(data).map_err(err)?;
      }
      if finish {
        // into_inner() writes the final meta-block; flush() alone leaves
        // the stream unterminated.
        let done = std::mem::replace(enc, Box::new(brotli::CompressorWriter::new(Vec::new(), 4096, 11, 22)));
        return Ok(done.into_inner());
      }
      enc.flush().map_err(err)?;
      Ok(std::mem::take(enc.get_mut()))
    }
    ZStream::BrotliDec(dec) if finish => {
      if !data.is_empty() {
        dec.write_all(data).map_err(err)?;
      }
      let done = std::mem::replace(dec, Box::new(brotli::DecompressorWriter::new(Vec::new(), 4096)));
      // into_inner() fails when the compressed stream is incomplete.
      done
        .into_inner()
        .map_err(|_| JsErrorBox::from_err(ZlibError("unexpected end of file".into())))
    }
    ZStream::BrotliDec(dec) => {
      if !data.is_empty() {
        dec.write_all(data).map_err(err)?;
      }
      dec.flush().map_err(err)?;
      let mut out = std::mem::take(dec.get_mut());
      // Drain remaining buffered data if any
      while let Ok(n) = dec.write(&[]) {
        if n == 0 {
          break;
        }
      }
      let _ = dec.flush();
      out.extend(std::mem::take(dec.get_mut()));
      Ok(out)
    }
  }
}

fn z_open(kind: u32, level: i32) -> Result<ZStream, JsErrorBox> {
  let flate_level = compression(level);
  Ok(match kind {
    0 => ZStream::GzipEnc(flate2::write::GzEncoder::new(Vec::new(), flate_level)),
    1 => ZStream::GzipDec(flate2::write::GzDecoder::new(Vec::new())),
    2 => ZStream::ZlibEnc(flate2::write::ZlibEncoder::new(Vec::new(), flate_level)),
    3 => ZStream::ZlibDec(flate2::write::ZlibDecoder::new(Vec::new())),
    4 => ZStream::RawEnc(flate2::write::DeflateEncoder::new(Vec::new(), flate_level)),
    5 => ZStream::RawDec(flate2::write::DeflateDecoder::new(Vec::new())),
    6 => {
      let q = if level < 0 { 11 } else { level.clamp(0, 11) as u32 };
      ZStream::BrotliEnc(Box::new(brotli::CompressorWriter::new(Vec::new(), 4096, q, 22)))
    }
    7 => ZStream::BrotliDec(Box::new(brotli::DecompressorWriter::new(Vec::new(), 4096))),
    _ => return Err(JsErrorBox::generic("unknown zlib kind")),
  })
}

#[op2(fast)]
pub fn op_zlib_new(state: &mut OpState, kind: u32, level: i32) -> Result<u32, JsErrorBox> {
  let stream = z_open(kind, level)?;
  let table = z_table(state);
  let id = table.next_id;
  table.next_id += 1;
  table.entries.insert(
    id,
    ZEntry {
      stream: Some(stream),
      finished: false,
    },
  );
  Ok(id)
}

#[op2]
#[buffer]
pub fn op_zlib_write(
  state: &mut OpState,
  id: u32,
  #[buffer] data: &[u8],
  finish: bool,
) -> Result<Vec<u8>, JsErrorBox> {
  let table = z_table(state);
  let entry = table
    .entries
    .get_mut(&id)
    .ok_or_else(|| JsErrorBox::generic("zlib stream is closed"))?;
  if entry.finished {
    return Err(JsErrorBox::generic("zlib stream is finished"));
  }
  let stream = entry
    .stream
    .as_mut()
    .ok_or_else(|| JsErrorBox::generic("zlib write already in progress"))?;
  let out = z_feed(stream, data, finish)?;
  if finish {
    entry.finished = true;
  }
  Ok(out)
}

/// One-shot gzip/deflate off the isolate thread. Used by the callback and
/// promise forms so a large buffer does not stall timers and sockets.
#[op2]
#[buffer]
pub async fn op_zlib_oneshot(
  kind: u32,
  level: i32,
  #[buffer(copy)] data: Vec<u8>,
) -> Result<Vec<u8>, JsErrorBox> {
  off_thread(move || {
    let mut stream = z_open(kind, level)?;
    z_feed(&mut stream, &data, true)
  })
  .await
}

/// Streaming write. The encoder is moved onto the blocking pool for the
/// duration of the call and put back afterwards.
#[op2]
#[buffer]
pub async fn op_zlib_write_off(
  state: Rc<RefCell<OpState>>,
  id: u32,
  #[buffer(copy)] data: Vec<u8>,
  finish: bool,
) -> Result<Vec<u8>, JsErrorBox> {
  let stream = {
    let mut st = state.borrow_mut();
    let entry = z_table(&mut st)
      .entries
      .get_mut(&id)
      .ok_or_else(|| JsErrorBox::generic("zlib stream is closed"))?;
    if entry.finished {
      return Err(JsErrorBox::generic("zlib stream is finished"));
    }
    entry
      .stream
      .take()
      .ok_or_else(|| JsErrorBox::generic("zlib write already in progress"))?
  };

  let joined = tokio::task::spawn_blocking(move || {
    let mut stream = stream;
    let fed = z_feed(&mut stream, &data, finish);
    (stream, fed)
  })
  .await;

  let (stream, fed) = match joined {
    Ok(pair) => pair,
    Err(err) => return Err(JsErrorBox::generic(format!("blocking task: {err}"))),
  };

  let mut st = state.borrow_mut();
  if let Some(entry) = z_table(&mut st).entries.get_mut(&id) {
    entry.stream = Some(stream);
    if finish && fed.is_ok() {
      entry.finished = true;
    }
  }
  fed
}

#[op2(fast)]
pub fn op_zlib_close(state: &mut OpState, id: u32) {
  z_table(state).entries.remove(&id);
}

// ---------------------------------------------------------------------------
// HMAC (md5, sha1, sha224, sha256, sha384, sha512) and PBKDF2 on it.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum MacAlgo {
  Sha224,
  Sha256,
  Sha384,
  Sha512,
  Sha1,
  Md5,
}

enum HmacInner {
  Sha224(sha2::Sha224),
  Sha256(sha2::Sha256),
  Sha384(sha2::Sha384),
  Sha512(sha2::Sha512),
  Sha1(sha1::Sha1),
  Md5(md5::Context),
}

struct Hmac {
  algo: MacAlgo,
  opad: Vec<u8>,
  inner: HmacInner,
}

#[derive(Default)]
struct HmacTable {
  next_id: u32,
  macs: HashMap<u32, Hmac>,
}

fn hmac_table(state: &mut OpState) -> &mut HmacTable {
  if !state.has::<HmacTable>() {
    state.put(HmacTable::default());
  }
  state.borrow_mut::<HmacTable>()
}

fn parse_mac(algo: &str) -> Result<MacAlgo, JsErrorBox> {
  let name = algo.to_ascii_lowercase();
  match name.strip_prefix("rsa-").unwrap_or(&name).replace('-', "").as_str() {
    "sha224" => Ok(MacAlgo::Sha224),
    "sha256" => Ok(MacAlgo::Sha256),
    "sha384" => Ok(MacAlgo::Sha384),
    "sha512" => Ok(MacAlgo::Sha512),
    "sha1" => Ok(MacAlgo::Sha1),
    "md5" => Ok(MacAlgo::Md5),
    other => Err(JsErrorBox::generic(format!("unsupported hmac algorithm: {other}"))),
  }
}

fn hash_key(algo: MacAlgo, key: &[u8]) -> Vec<u8> {
  use sha2::Digest;
  match algo {
    MacAlgo::Sha224 => sha2::Sha224::digest(key).to_vec(),
    MacAlgo::Sha256 => sha2::Sha256::digest(key).to_vec(),
    MacAlgo::Sha384 => sha2::Sha384::digest(key).to_vec(),
    MacAlgo::Sha512 => sha2::Sha512::digest(key).to_vec(),
    MacAlgo::Sha1 => sha1::Sha1::digest(key).to_vec(),
    MacAlgo::Md5 => md5::compute(key).0.to_vec(),
  }
}

fn prime_inner(algo: MacAlgo, ipad: &[u8]) -> HmacInner {
  use sha2::Digest;
  match algo {
    MacAlgo::Sha224 => {
      let mut hasher = sha2::Sha224::new();
      hasher.update(ipad);
      HmacInner::Sha224(hasher)
    }
    MacAlgo::Sha384 => {
      let mut hasher = sha2::Sha384::new();
      hasher.update(ipad);
      HmacInner::Sha384(hasher)
    }
    MacAlgo::Sha256 => {
      let mut hasher = sha2::Sha256::new();
      hasher.update(ipad);
      HmacInner::Sha256(hasher)
    }
    MacAlgo::Sha512 => {
      let mut hasher = sha2::Sha512::new();
      hasher.update(ipad);
      HmacInner::Sha512(hasher)
    }
    MacAlgo::Sha1 => {
      let mut hasher = sha1::Sha1::new();
      hasher.update(ipad);
      HmacInner::Sha1(hasher)
    }
    MacAlgo::Md5 => {
      let mut ctx = md5::Context::new();
      ctx.consume(ipad);
      HmacInner::Md5(ctx)
    }
  }
}

fn hmac_update(inner: &mut HmacInner, data: &[u8]) {
  use sha2::Digest;
  match inner {
    HmacInner::Sha224(hasher) => hasher.update(data),
    HmacInner::Sha256(hasher) => hasher.update(data),
    HmacInner::Sha384(hasher) => hasher.update(data),
    HmacInner::Sha512(hasher) => hasher.update(data),
    HmacInner::Sha1(hasher) => hasher.update(data),
    HmacInner::Md5(ctx) => ctx.consume(data),
  }
}

fn outer_digest(algo: MacAlgo, opad: &[u8], inner: &[u8]) -> Vec<u8> {
  use sha2::Digest;
  match algo {
    MacAlgo::Sha224 => {
      let mut hasher = sha2::Sha224::new();
      hasher.update(opad);
      hasher.update(inner);
      hasher.finalize().to_vec()
    }
    MacAlgo::Sha384 => {
      let mut hasher = sha2::Sha384::new();
      hasher.update(opad);
      hasher.update(inner);
      hasher.finalize().to_vec()
    }
    MacAlgo::Sha256 => {
      let mut hasher = sha2::Sha256::new();
      hasher.update(opad);
      hasher.update(inner);
      hasher.finalize().to_vec()
    }
    MacAlgo::Sha512 => {
      let mut hasher = sha2::Sha512::new();
      hasher.update(opad);
      hasher.update(inner);
      hasher.finalize().to_vec()
    }
    MacAlgo::Sha1 => {
      let mut hasher = sha1::Sha1::new();
      hasher.update(opad);
      hasher.update(inner);
      hasher.finalize().to_vec()
    }
    MacAlgo::Md5 => {
      let mut ctx = md5::Context::new();
      ctx.consume(opad);
      ctx.consume(inner);
      ctx.compute().0.to_vec()
    }
  }
}

fn inner_digest(inner: HmacInner) -> Vec<u8> {
  use sha2::Digest;
  match inner {
    HmacInner::Sha224(hasher) => hasher.finalize().to_vec(),
    HmacInner::Sha256(hasher) => hasher.finalize().to_vec(),
    HmacInner::Sha384(hasher) => hasher.finalize().to_vec(),
    HmacInner::Sha512(hasher) => hasher.finalize().to_vec(),
    HmacInner::Sha1(hasher) => hasher.finalize().to_vec(),
    HmacInner::Md5(ctx) => ctx.compute().0.to_vec(),
  }
}

#[op2(fast)]
pub fn op_hmac_new(state: &mut OpState, #[string] algo: String, #[buffer] key: &[u8]) -> Result<u32, JsErrorBox> {
  let algo = parse_mac(&algo)?;
  let block = match algo {
    MacAlgo::Sha384 | MacAlgo::Sha512 => 128,
    _ => 64,
  };
  let mut key = if key.len() > block {
    hash_key(algo, key)
  } else {
    key.to_vec()
  };
  key.resize(block, 0);
  let mut ipad = key.clone();
  let mut opad = key;
  for byte in &mut ipad {
    *byte ^= 0x36;
  }
  for byte in &mut opad {
    *byte ^= 0x5c;
  }
  let mac = Hmac {
    algo,
    opad,
    inner: prime_inner(algo, &ipad),
  };
  let table = hmac_table(state);
  let id = table.next_id;
  table.next_id += 1;
  table.macs.insert(id, mac);
  Ok(id)
}

#[op2(fast)]
pub fn op_hmac_update(state: &mut OpState, id: u32, #[buffer] data: &[u8]) -> Result<(), JsErrorBox> {
  match hmac_table(state).macs.get_mut(&id) {
    Some(mac) => {
      hmac_update(&mut mac.inner, data);
      Ok(())
    }
    None => Err(JsErrorBox::generic("hmac already digested or unknown")),
  }
}

#[op2]
#[buffer]
pub fn op_hmac_digest(state: &mut OpState, id: u32) -> Result<Vec<u8>, JsErrorBox> {
  let mac = hmac_table(state)
    .macs
    .remove(&id)
    .ok_or_else(|| JsErrorBox::generic("hmac already digested or unknown"))?;
  let inner = inner_digest(mac.inner);
  Ok(outer_digest(mac.algo, &mac.opad, &inner))
}

fn pbkdf2_derive(algo: MacAlgo, pass: &[u8], salt: &[u8], iterations: u32, keylen: usize) -> Vec<u8> {
  let block = match algo {
    MacAlgo::Sha384 | MacAlgo::Sha512 => 128,
    _ => 64,
  };
  let mut padded_key = if pass.len() > block {
    hash_key(algo, pass)
  } else {
    pass.to_vec()
  };
  padded_key.resize(block, 0);

  let mut ipad = padded_key.clone();
  let mut opad = padded_key;
  for b in &mut ipad {
    *b ^= 0x36;
  }
  for b in &mut opad {
    *b ^= 0x5c;
  }

  let hlen = match algo {
    MacAlgo::Md5 => 16,
    MacAlgo::Sha1 => 20,
    MacAlgo::Sha224 => 28,
    MacAlgo::Sha256 => 32,
    MacAlgo::Sha384 => 48,
    MacAlgo::Sha512 => 64,
  };

  let num_blocks = keylen.div_ceil(hlen);
  let mut derived = Vec::with_capacity(num_blocks * hlen);

  for block_idx in 1..=(num_blocks as u32) {
    let mut salt_and_idx = Vec::with_capacity(salt.len() + 4);
    salt_and_idx.extend_from_slice(salt);
    salt_and_idx.extend_from_slice(&block_idx.to_be_bytes());

    let mut inner = prime_inner(algo, &ipad);
    hmac_update(&mut inner, &salt_and_idx);
    let inner_hash = inner_digest(inner);
    let mut u = outer_digest(algo, &opad, &inner_hash);
    let mut acc = u.clone();

    for _ in 1..iterations {
      let mut inner = prime_inner(algo, &ipad);
      hmac_update(&mut inner, &u);
      let inner_hash = inner_digest(inner);
      u = outer_digest(algo, &opad, &inner_hash);
      for (a, b) in acc.iter_mut().zip(u.iter()) {
        *a ^= *b;
      }
    }
    derived.extend_from_slice(&acc);
  }

  derived.truncate(keylen);
  derived
}

#[op2]
#[buffer]
pub fn op_crypto_pbkdf2(
  #[string] algo: String,
  #[buffer] pass: &[u8],
  #[buffer] salt: &[u8],
  iterations: u32,
  keylen: u32,
) -> Result<Vec<u8>, JsErrorBox> {
  let algo = parse_mac(&algo)?;
  if iterations == 0 {
    return Err(JsErrorBox::generic("iterations must be > 0"));
  }
  Ok(pbkdf2_derive(algo, pass, salt, iterations, keylen as usize))
}

fn scrypt_derive(pass: &[u8], salt: &[u8], cost: f64, block_size: u32, parallelization: u32, keylen: u32, maxmem: f64) -> Result<Vec<u8>, JsErrorBox> {
  let invalid = |msg: &str| JsErrorBox::range_error(format!("Invalid scrypt params: {msg}"));
  if !(cost >= 2.0 && cost.fract() == 0.0 && (cost as u64).is_power_of_two()) {
    return Err(invalid("N must be a power of 2 greater than 1"));
  }
  // Node rejects parameters whose working set exceeds maxmem (default 32 MiB).
  if 128.0 * cost * block_size as f64 > maxmem {
    return Err(invalid("memory limit exceeded"));
  }
  let log_n = (cost as u64).trailing_zeros() as u8;
  let params = scrypt::Params::new(log_n, block_size, parallelization, keylen as usize)
    .map_err(|e| invalid(&e.to_string()))?;
  let mut out = vec![0u8; keylen as usize];
  scrypt::scrypt(pass, salt, &params, &mut out).map_err(|e| invalid(&e.to_string()))?;
  Ok(out)
}

#[op2]
#[buffer]
pub fn op_crypto_scrypt_sync(
  #[buffer] pass: &[u8],
  #[buffer] salt: &[u8],
  cost: f64,
  block_size: u32,
  parallelization: u32,
  keylen: u32,
  maxmem: f64,
) -> Result<Vec<u8>, JsErrorBox> {
  scrypt_derive(pass, salt, cost, block_size, parallelization, keylen, maxmem)
}

#[op2]
#[buffer]
#[allow(clippy::too_many_arguments)]
pub async fn op_crypto_scrypt(
  #[buffer(copy)] pass: Vec<u8>,
  #[buffer(copy)] salt: Vec<u8>,
  cost: f64,
  block_size: u32,
  parallelization: u32,
  keylen: u32,
  maxmem: f64,
) -> Result<Vec<u8>, JsErrorBox> {
  off_thread(move || scrypt_derive(&pass, &salt, cost, block_size, parallelization, keylen, maxmem)).await
}

#[derive(serde::Serialize)]
pub struct CipherEncryptResult {
  #[serde(with = "serde_bytes")]
  pub ciphertext: Vec<u8>,
  #[serde(with = "serde_bytes")]
  pub tag: Vec<u8>,
}

struct OneNonce(Option<ring::aead::Nonce>);

impl ring::aead::NonceSequence for OneNonce {
  fn advance(&mut self) -> Result<ring::aead::Nonce, ring::error::Unspecified> {
    self.0.take().ok_or(ring::error::Unspecified)
  }
}

fn get_aead_algorithm(name: &str) -> Result<&'static ring::aead::Algorithm, JsErrorBox> {
  match name.to_ascii_lowercase().replace('-', "").as_str() {
    "aes256gcm" => Ok(&ring::aead::AES_256_GCM),
    "aes128gcm" => Ok(&ring::aead::AES_128_GCM),
    "chacha20poly1305" => Ok(&ring::aead::CHACHA20_POLY1305),
    _ => Err(JsErrorBox::generic(format!("unsupported cipher algorithm '{name}'"))),
  }
}

#[op2]
#[serde]
pub fn op_crypto_cipher_encrypt(
  #[string] algorithm: String,
  #[buffer] key: &[u8],
  #[buffer] iv: &[u8],
  #[buffer] plaintext: &[u8],
  #[buffer] aad: &[u8],
) -> Result<CipherEncryptResult, JsErrorBox> {
  use ring::aead::BoundKey;
  let algo = get_aead_algorithm(&algorithm)?;
  if iv.len() != 12 {
    return Err(JsErrorBox::generic("IV length must be 12 bytes for GCM/ChaCha20"));
  }
  let unbound_key = ring::aead::UnboundKey::new(algo, key)
    .map_err(|_| JsErrorBox::generic("invalid key length"))?;
  let nonce = ring::aead::Nonce::try_assume_unique_for_key(iv)
    .map_err(|_| JsErrorBox::generic("invalid nonce"))?;
  let mut sealing_key = ring::aead::SealingKey::new(unbound_key, OneNonce(Some(nonce)));
  let mut in_out = plaintext.to_vec();
  sealing_key
    .seal_in_place_append_tag(ring::aead::Aad::from(aad), &mut in_out)
    .map_err(|_| JsErrorBox::generic("encryption failed"))?;
  let tag_len = algo.tag_len();
  let tag = in_out.split_off(in_out.len() - tag_len);
  Ok(CipherEncryptResult {
    ciphertext: in_out,
    tag,
  })
}

#[op2]
#[buffer]
pub fn op_crypto_cipher_decrypt(
  #[string] algorithm: String,
  #[buffer] key: &[u8],
  #[buffer] iv: &[u8],
  #[buffer] ciphertext: &[u8],
  #[buffer] tag: &[u8],
  #[buffer] aad: &[u8],
) -> Result<Vec<u8>, JsErrorBox> {
  use ring::aead::BoundKey;
  let algo = get_aead_algorithm(&algorithm)?;
  if iv.len() != 12 {
    return Err(JsErrorBox::generic("IV length must be 12 bytes for GCM/ChaCha20"));
  }
  let unbound_key = ring::aead::UnboundKey::new(algo, key)
    .map_err(|_| JsErrorBox::generic("invalid key length"))?;
  let nonce = ring::aead::Nonce::try_assume_unique_for_key(iv)
    .map_err(|_| JsErrorBox::generic("invalid nonce"))?;
  let mut opening_key = ring::aead::OpeningKey::new(unbound_key, OneNonce(Some(nonce)));
  let mut in_out = Vec::with_capacity(ciphertext.len() + tag.len());
  in_out.extend_from_slice(ciphertext);
  in_out.extend_from_slice(tag);
  let decrypted = opening_key
    .open_in_place(ring::aead::Aad::from(aad), &mut in_out)
    .map_err(|_| JsErrorBox::generic("authentication tag verification failed or ciphertext corrupted"))?;
  Ok(decrypted.to_vec())
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct DnsAddr {
  address: String,
  family: u8,
}

#[derive(serde::Serialize)]
pub struct MxRecord {
  pub exchange: String,
  pub priority: u16,
}

#[derive(serde::Serialize)]
pub struct SrvRecord {
  pub name: String,
  pub port: u16,
  pub priority: u16,
  pub weight: u16,
}

#[derive(serde::Serialize)]
pub struct LookupServiceResult {
  pub hostname: String,
  pub service: String,
}

fn get_nameservers() -> Vec<std::net::SocketAddr> {
  let mut servers = Vec::new();
  if let Ok(resolv) = std::fs::read_to_string("/etc/resolv.conf") {
    for line in resolv.lines() {
      let trimmed = line.trim();
      if let Some(rest) = trimmed.strip_prefix("nameserver") {
        let ip_str = rest.trim();
        if let Ok(ip) = ip_str.parse::<std::net::IpAddr>() {
          servers.push(std::net::SocketAddr::new(ip, 53));
        }
      }
    }
  }
  if servers.is_empty() {
    if let Ok(addr) = "1.1.1.1:53".parse() {
      servers.push(addr);
    }
    if let Ok(addr) = "8.8.8.8:53".parse() {
      servers.push(addr);
    }
  }
  servers
}

fn build_dns_query(host: &str, qtype: u16, tx_id: u16) -> Vec<u8> {
  let mut packet = Vec::with_capacity(64);
  packet.extend_from_slice(&tx_id.to_be_bytes());
  packet.extend_from_slice(&0x0100u16.to_be_bytes()); // Flags: RD=1
  packet.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT = 1
  packet.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT = 0
  packet.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT = 0
  packet.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT = 0

  for part in host.trim_matches('.').split('.') {
    let bytes = part.as_bytes();
    packet.push(bytes.len() as u8);
    packet.extend_from_slice(bytes);
  }
  packet.push(0);

  packet.extend_from_slice(&qtype.to_be_bytes());
  packet.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = 1 (IN)
  packet
}

fn parse_dns_name(buf: &[u8], mut offset: usize) -> Result<(String, usize), String> {
  let mut labels = Vec::new();
  let mut jumped = false;
  let mut next_offset = offset;
  let mut hops = 0;

  while offset < buf.len() && hops < 20 {
    let len = buf[offset] as usize;
    if len == 0 {
      if !jumped {
        next_offset = offset + 1;
      }
      break;
    }
    if (len & 0xC0) == 0xC0 {
      if offset + 1 >= buf.len() {
        return Err("truncated pointer".into());
      }
      let ptr = ((len & 0x3F) << 8) | (buf[offset + 1] as usize);
      if !jumped {
        next_offset = offset + 2;
        jumped = true;
      }
      offset = ptr;
      hops += 1;
      continue;
    }
    offset += 1;
    if offset + len > buf.len() {
      return Err("label out of bounds".into());
    }
    let label = std::str::from_utf8(&buf[offset..offset + len])
      .map_err(|_| "invalid utf8 in dns name")?;
    labels.push(label.to_string());
    offset += len;
    if !jumped {
      next_offset = offset;
    }
  }
  Ok((labels.join("."), next_offset))
}

fn format_ptr_query(host: &str) -> String {
  if let Ok(ip) = host.parse::<std::net::IpAddr>() {
    match ip {
      std::net::IpAddr::V4(v4) => {
        let octets = v4.octets();
        format!("{}.{}.{}.{}.in-addr.arpa", octets[3], octets[2], octets[1], octets[0])
      }
      std::net::IpAddr::V6(v6) => {
        let mut segments = Vec::new();
        for byte in v6.octets().iter().rev() {
          segments.push(format!("{:x}", byte & 0x0F));
          segments.push(format!("{:x}", (byte >> 4) & 0x0F));
        }
        format!("{}.ip6.arpa", segments.join("."))
      }
    }
  } else {
    host.to_string()
  }
}

fn port_to_service(port: u16) -> &'static str {
  match port {
    20 => "ftp-data",
    21 => "ftp",
    22 => "ssh",
    23 => "telnet",
    25 => "smtp",
    53 => "domain",
    80 => "http",
    110 => "pop3",
    119 => "nntp",
    123 => "ntp",
    143 => "imap",
    161 => "snmp",
    194 => "irc",
    443 => "https",
    465 => "smtps",
    587 => "submission",
    993 => "imaps",
    995 => "pop3s",
    1080 => "socks",
    3306 => "mysql",
    5432 => "postgresql",
    6379 => "redis",
    8080 => "http-alt",
    8443 => "https-alt",
    _ => "",
  }
}

async fn execute_dns_query(host: &str, qtype: u16) -> Result<Vec<u8>, String> {
  let mut tx_bytes = [0u8; 2];
  let _ = getrandom::fill(&mut tx_bytes);
  let tx_id = u16::from_be_bytes(tx_bytes);
  let query = build_dns_query(host, qtype, tx_id);

  let bind_addr = if host.contains(':') { "[::]:0" } else { "0.0.0.0:0" };
  let socket = match tokio::net::UdpSocket::bind(bind_addr).await {
    Ok(s) => s,
    Err(_) => tokio::net::UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?,
  };

  let nameservers = get_nameservers();
  let mut buf = vec![0u8; 4096];

  for ns in nameservers {
    if socket.send_to(&query, ns).await.is_err() {
      continue;
    }
    match tokio::time::timeout(
      std::time::Duration::from_millis(1500),
      socket.recv_from(&mut buf),
    )
    .await
    {
      Ok(Ok((len, _))) if len >= 12 => {
        let resp_id = u16::from_be_bytes([buf[0], buf[1]]);
        if resp_id == tx_id {
          buf.truncate(len);
          return Ok(buf);
        }
      }
      _ => continue,
    }
  }
  Err("DNS query timed out".into())
}

#[op2]
#[serde]
pub async fn op_dns_lookup(#[string] host: String) -> Result<Vec<DnsAddr>, JsErrorBox> {
  crate::permissions::check_net(&host)?;
  let looked = tokio::net::lookup_host((host.as_str(), 0))
    .await
    .map_err(|e| JsErrorBox::generic(format!("ENOTFOUND: {host}: {e}")))?;
  let mut out = Vec::new();
  let mut seen = std::collections::HashSet::new();
  for addr in looked {
    let ip = addr.ip();
    let text = ip.to_string();
    if seen.insert(text.clone()) {
      out.push(DnsAddr {
        address: text,
        family: if ip.is_ipv4() { 4 } else { 6 },
      });
    }
  }
  Ok(out)
}

#[op2]
#[serde]
pub async fn op_dns_resolve(
  #[string] host: String,
  #[string] rrtype: String,
) -> Result<serde_json::Value, JsErrorBox> {
  crate::permissions::check_net(&host)?;

  let rrtype_upper = rrtype.to_ascii_uppercase();
  let qtype = match rrtype_upper.as_str() {
    "A" => 1u16,
    "NS" => 2u16,
    "CNAME" => 5u16,
    "PTR" => 12u16,
    "MX" => 15u16,
    "TXT" => 16u16,
    "AAAA" => 28u16,
    "SRV" => 33u16,
    _ => return Err(JsErrorBox::type_error(format!("unsupported rrtype {rrtype}"))),
  };

  let query_host = if qtype == 12 {
    format_ptr_query(&host)
  } else {
    host.clone()
  };

  if host.eq_ignore_ascii_case("localhost") {
    match rrtype_upper.as_str() {
      "A" => return Ok(serde_json::json!(["127.0.0.1"])),
      "AAAA" => return Ok(serde_json::json!(["::1"])),
      "PTR" => return Ok(serde_json::json!(["localhost"])),
      _ => return Err(JsErrorBox::generic(format!("ENODATA: {host}"))),
    }
  }

  // Try raw DNS query first
  let resp = execute_dns_query(&query_host, qtype).await;

  if let Ok(buf) = resp
    && buf.len() >= 12
  {
    let flags = u16::from_be_bytes([buf[2], buf[3]]);
      let rcode = flags & 0x000F;
      if rcode == 3 {
        return Err(JsErrorBox::generic(format!("ENOTFOUND: {host}")));
      }
      let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
      let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;

      let mut offset = 12;
      for _ in 0..qdcount {
        if let Ok((_, next)) = parse_dns_name(&buf, offset) {
          offset = next + 4;
        } else {
          break;
        }
      }

      let mut a_records: Vec<String> = Vec::new();
      let mut aaaa_records: Vec<String> = Vec::new();
      let mut cname_records: Vec<String> = Vec::new();
      let mut ns_records: Vec<String> = Vec::new();
      let mut ptr_records: Vec<String> = Vec::new();
      let mut mx_records: Vec<MxRecord> = Vec::new();
      let mut txt_records: Vec<Vec<String>> = Vec::new();
      let mut srv_records: Vec<SrvRecord> = Vec::new();

      for _ in 0..ancount {
        if offset >= buf.len() {
          break;
        }
        let (_name, next) = match parse_dns_name(&buf, offset) {
          Ok(res) => res,
          Err(_) => break,
        };
        offset = next;
        if offset + 10 > buf.len() {
          break;
        }
        let rtype = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let rdlength = u16::from_be_bytes([buf[offset + 8], buf[offset + 9]]) as usize;
        offset += 10;
        if offset + rdlength > buf.len() {
          break;
        }
        let rdata = &buf[offset..offset + rdlength];

        match rtype {
          1 if rdlength == 4 => {
            let ip = std::net::Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]);
            a_records.push(ip.to_string());
          }
          28 if rdlength == 16 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(rdata);
            let ip = std::net::Ipv6Addr::from(octets);
            aaaa_records.push(ip.to_string());
          }
          5 => {
            if let Ok((cname, _)) = parse_dns_name(&buf, offset) {
              cname_records.push(cname);
            }
          }
          2 => {
            if let Ok((ns, _)) = parse_dns_name(&buf, offset) {
              ns_records.push(ns);
            }
          }
          12 => {
            if let Ok((ptr, _)) = parse_dns_name(&buf, offset) {
              ptr_records.push(ptr);
            }
          }
          15 if rdlength > 2 => {
            let priority = u16::from_be_bytes([rdata[0], rdata[1]]);
            if let Ok((exchange, _)) = parse_dns_name(&buf, offset + 2) {
              mx_records.push(MxRecord { exchange, priority });
            }
          }
          16 => {
            let mut chunks = Vec::new();
            let mut roff = 0;
            while roff < rdata.len() {
              let clen = rdata[roff] as usize;
              roff += 1;
              if roff + clen <= rdata.len() {
                if let Ok(s) = std::str::from_utf8(&rdata[roff..roff + clen]) {
                  chunks.push(s.to_string());
                }
                roff += clen;
              } else {
                break;
              }
            }
            if !chunks.is_empty() {
              txt_records.push(chunks);
            }
          }
          33 if rdlength > 6 => {
            let priority = u16::from_be_bytes([rdata[0], rdata[1]]);
            let weight = u16::from_be_bytes([rdata[2], rdata[3]]);
            let port = u16::from_be_bytes([rdata[4], rdata[5]]);
            if let Ok((target, _)) = parse_dns_name(&buf, offset + 6) {
              srv_records.push(SrvRecord {
                name: target,
                port,
                priority,
                weight,
              });
            }
          }
          _ => {}
        }
        offset += rdlength;
      }

      let res = match rrtype_upper.as_str() {
        "A" if !a_records.is_empty() => Some(serde_json::to_value(a_records).unwrap()),
        "AAAA" if !aaaa_records.is_empty() => Some(serde_json::to_value(aaaa_records).unwrap()),
        "CNAME" if !cname_records.is_empty() => Some(serde_json::to_value(cname_records).unwrap()),
        "NS" if !ns_records.is_empty() => Some(serde_json::to_value(ns_records).unwrap()),
        "PTR" if !ptr_records.is_empty() => Some(serde_json::to_value(ptr_records).unwrap()),
        "MX" if !mx_records.is_empty() => Some(serde_json::to_value(mx_records).unwrap()),
        "TXT" if !txt_records.is_empty() => Some(serde_json::to_value(txt_records).unwrap()),
        "SRV" if !srv_records.is_empty() => Some(serde_json::to_value(srv_records).unwrap()),
        _ => None,
      };
      if let Some(val) = res {
        return Ok(val);
      }
    }

  // Fallbacks for localhost, system lookup, or offline sandbox
  match rrtype_upper.as_str() {
    "A" => {
      if host == "localhost" {
        return Ok(serde_json::json!(["127.0.0.1"]));
      }
      if let Ok(addrs) = tokio::net::lookup_host((host.as_str(), 0)).await {
        let v4s: Vec<String> = addrs
          .filter_map(|a| if a.is_ipv4() { Some(a.ip().to_string()) } else { None })
          .collect();
        if !v4s.is_empty() {
          return Ok(serde_json::to_value(v4s).unwrap());
        }
      }
      Err(JsErrorBox::generic(format!("ENODATA: {host}")))
    }
    "AAAA" => {
      if host == "localhost" {
        return Ok(serde_json::json!(["::1"]));
      }
      if let Ok(addrs) = tokio::net::lookup_host((host.as_str(), 0)).await {
        let v6s: Vec<String> = addrs
          .filter_map(|a| if a.is_ipv6() { Some(a.ip().to_string()) } else { None })
          .collect();
        if !v6s.is_empty() {
          return Ok(serde_json::to_value(v6s).unwrap());
        }
      }
      Err(JsErrorBox::generic(format!("ENODATA: {host}")))
    }
    "PTR" => {
      if host == "127.0.0.1" || host == "::1" {
        return Ok(serde_json::json!(["localhost"]));
      }
      Err(JsErrorBox::generic(format!("ENODATA: {host}")))
    }
    _ => Err(JsErrorBox::generic(format!("ENODATA: {host}"))),
  }
}

#[op2]
#[serde]
pub async fn op_dns_lookup_service(
  #[string] address: String,
  port: u16,
) -> Result<LookupServiceResult, JsErrorBox> {
  crate::permissions::check_net(&format!("{address}:{port}"))?;

  let service = port_to_service(port);
  let service_str = if service.is_empty() {
    port.to_string()
  } else {
    service.to_string()
  };

  let hostname = if address == "127.0.0.1" || address == "::1" {
    "localhost".to_string()
  } else {
    // Attempt PTR resolution
    let ptr_query = format_ptr_query(&address);
    if let Ok(buf) = execute_dns_query(&ptr_query, 12).await {
      if buf.len() >= 12 {
        let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
        let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;
        let mut offset = 12;
        for _ in 0..qdcount {
          if let Ok((_, next)) = parse_dns_name(&buf, offset) {
            offset = next + 4;
          } else {
            break;
          }
        }
        let mut resolved_host = None;
        for _ in 0..ancount {
          if offset >= buf.len() { break; }
          let (_name, next) = match parse_dns_name(&buf, offset) {
            Ok(res) => res,
            Err(_) => break,
          };
          offset = next;
          if offset + 10 > buf.len() { break; }
          let rtype = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
          let rdlength = u16::from_be_bytes([buf[offset + 8], buf[offset + 9]]) as usize;
          offset += 10;
          if offset + rdlength > buf.len() { break; }
          if rtype == 12
            && let Ok((ptr, _)) = parse_dns_name(&buf, offset)
          {
            resolved_host = Some(ptr);
            break;
          }
          offset += rdlength;
        }
        resolved_host.unwrap_or_else(|| address.clone())
      } else {
        address.clone()
      }
    } else {
      address.clone()
    }
  };

  Ok(LookupServiceResult {
    hostname,
    service: service_str,
  })
}

// ---------------------------------------------------------------------------
// OS / tty / process ids
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct OsInfo {
  hostname: String,
  sysname: String,
  release: String,
  version: String,
  machine: String,
  uid: i64,
  gid: i64,
  tmpdir: String,
}

#[op2]
#[serde]
pub fn op_os_info() -> Result<OsInfo, JsErrorBox> {
  let names = crate::platform::os_names().map_err(|e| JsErrorBox::generic(format!("uname: {e}")))?;
  Ok(OsInfo {
    hostname: names.hostname,
    sysname: names.sysname,
    release: names.release,
    version: names.version,
    machine: names.machine,
    uid: names.uid,
    gid: names.gid,
    tmpdir: std::env::temp_dir().to_string_lossy().into_owned(),
  })
}


fn get_cgroup_memory() -> Option<(u64, u64)> {
  // Try cgroups v2
  if let Ok(limit_str) = std::fs::read_to_string("/sys/fs/cgroup/memory.max") {
    let limit_str = limit_str.trim();
    if limit_str != "max"
      && let Ok(limit) = limit_str.parse::<u64>()
    {
      let usage = std::fs::read_to_string("/sys/fs/cgroup/memory.current")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
      return Some((limit, usage));
    }
  }
  // Try cgroups v1
  if let Ok(limit_str) = std::fs::read_to_string("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    && let Ok(limit) = limit_str.trim().parse::<u64>()
    && limit < 0x7FFF_FFFF_0000_0000
  {
    let usage = std::fs::read_to_string("/sys/fs/cgroup/memory/memory.usage_in_bytes")
      .ok()
      .and_then(|s| s.trim().parse::<u64>().ok())
      .unwrap_or(0);
    return Some((limit, usage));
  }
  None
}

#[derive(serde::Serialize)]
struct MemInfo {
  total: u64,
  free: u64,
  rss: u64,
}

#[op2]
#[serde]
pub fn op_meminfo() -> MemInfo {
  struct Snap {
    at: std::time::Instant,
    total: u64,
    free: u64,
    rss: u64,
  }
  static CACHE: OnceLock<StdMutex<Option<Snap>>> = OnceLock::new();
  let cache = CACHE.get_or_init(|| StdMutex::new(None));
  let mut guard = cache.lock().unwrap();
  if let Some(snap) = guard.as_ref()
    && snap.at.elapsed() < std::time::Duration::from_millis(200)
  {
    return MemInfo {
      total: snap.total,
      free: snap.free,
      rss: snap.rss,
    };
  }
  let mut sys = sysinfo::System::new();
  sys.refresh_memory();
  let pid = sysinfo::Pid::from_u32(std::process::id());
  sys.refresh_processes_specifics(
    sysinfo::ProcessesToUpdate::Some(&[pid]),
    true,
    sysinfo::ProcessRefreshKind::nothing().with_memory(),
  );
  let rss = sys.process(pid).map(|proc| proc.memory()).unwrap_or(0);
  // sysinfo's available figure subtracts compressed pages and can land on 0
  // on macOS. Node's freemem is the free-page count; take whichever is set.
  let mut free = sys.free_memory().max(sys.available_memory());
  let mut total = sys.total_memory();
  if let Some((cg_limit, cg_usage)) = get_cgroup_memory()
    && cg_limit < total
  {
    total = cg_limit;
    free = cg_limit.saturating_sub(cg_usage);
  }
  let snap = Snap {
    at: std::time::Instant::now(),
    total,
    free,
    rss,
  };
  let info = MemInfo {
    total: snap.total,
    free: snap.free,
    rss: snap.rss,
  };
  *guard = Some(snap);
  info
}

#[derive(serde::Serialize)]
struct NicAddr {
  name: String,
  address: String,
  netmask: String,
  family: String,
  internal: bool,
}

#[op2]
#[serde]
pub fn op_network_interfaces() -> Vec<NicAddr> {
  let Ok(ifaces) = if_addrs::get_if_addrs() else {
    return Vec::new();
  };
  ifaces
    .into_iter()
    .map(|iface| {
      let internal = iface.is_loopback();
      let name = iface.name;
      let (address, netmask, family) = match iface.addr {
        if_addrs::IfAddr::V4(addr) => (addr.ip.to_string(), addr.netmask.to_string(), "IPv4"),
        if_addrs::IfAddr::V6(addr) => (addr.ip.to_string(), addr.netmask.to_string(), "IPv6"),
      };
      NicAddr {
        name,
        address,
        netmask,
        family: family.to_string(),
        internal,
      }
    })
    .collect()
}

#[op2(fast)]
pub fn op_isatty(fd: u32) -> bool {
  use std::io::IsTerminal;
  match fd {
    0 => std::io::stdin().is_terminal(),
    1 => std::io::stdout().is_terminal(),
    2 => std::io::stderr().is_terminal(),
    _ => false,
  }
}

#[op2(fast)]
pub fn op_pid() -> u32 {
  std::process::id()
}

#[op2(fast)]
pub fn op_ppid() -> u32 {
  crate::platform::ppid()
}

#[op2]
#[string]
pub fn op_exec_path() -> Result<String, JsErrorBox> {
  let exe = std::env::current_exe().map_err(|e| JsErrorBox::generic(e.to_string()))?;
  if let Some(parent) = exe.parent()
    && parent.ends_with("deps")
    && let Some(target_dir) = parent.parent()
  {
    let jse_bin = target_dir.join("jse");
    if jse_bin.exists() {
      return Ok(jse_bin.to_string_lossy().to_string());
    }
  }
  Ok(exe.to_string_lossy().to_string())
}

#[op2]
#[serde]
pub fn op_exec_argv() -> Vec<String> {
  vec![]
}

// ---------------------------------------------------------------------------
// IPC subsystem for node:cluster and child_process.fork()
// ---------------------------------------------------------------------------

pub struct IpcServer {
  conns: Arc<StdMutex<HashMap<u32, mpsc::UnboundedSender<String>>>>,
  events_rx: Arc<TokioMutex<mpsc::UnboundedReceiver<IpcServerEvent>>>,
  shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(serde::Serialize)]
pub struct IpcServerInfo {
  pub id: u32,
  pub port: u32,
}

#[derive(serde::Serialize)]
pub struct IpcServerEvent {
  pub kind: String, // "connect", "message", "disconnect"
  pub id: u32,
  pub data: Option<String>,
}

pub struct IpcClient {
  tx: mpsc::UnboundedSender<String>,
  rx: Arc<TokioMutex<mpsc::UnboundedReceiver<Option<String>>>>,
  shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct IpcTable {
  pub next_id: u32,
  pub servers: HashMap<u32, IpcServer>,
  pub next_client_id: u32,
  pub clients: HashMap<u32, IpcClient>,
}

fn ipc_table(state: &mut OpState) -> &mut IpcTable {
  if !state.has::<IpcTable>() {
    state.put(IpcTable {
      next_id: 1,
      servers: HashMap::new(),
      next_client_id: 1,
      clients: HashMap::new(),
    });
  }
  state.borrow_mut::<IpcTable>()
}

#[op2]
#[serde]
pub fn op_ipc_listen(state: &mut OpState) -> Result<IpcServerInfo, JsErrorBox> {
  let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
    .map_err(|e| JsErrorBox::generic(format!("ipc bind: {e}")))?;
  std_listener
    .set_nonblocking(true)
    .map_err(|e| JsErrorBox::generic(format!("ipc set_nonblocking: {e}")))?;
  let port = std_listener
    .local_addr()
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
    .port() as u32;
  let listener = tokio::net::TcpListener::from_std(std_listener)
    .map_err(|e| JsErrorBox::generic(format!("ipc from_std: {e}")))?;

  let conns = Arc::new(StdMutex::new(HashMap::new()));
  let (events_tx, events_rx) = mpsc::unbounded_channel();
  let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();

  let conns_clone = conns.clone();
  tokio::spawn(async move {
    let mut next_id: u32 = 1;
    loop {
      let stream = tokio::select! {
        biased;
        _ = &mut shutdown_rx => break,
        res = listener.accept() => {
          match res {
            Ok((s, _)) => s,
            Err(_) => break,
          }
        }
      };

      let id = next_id;
      next_id += 1;
      let (read_half, mut write_half) = stream.into_split();
      let (tx, mut rx) = mpsc::unbounded_channel::<String>();
      conns_clone.lock().unwrap().insert(id, tx);
      let _ = events_tx.send(IpcServerEvent {
        kind: "connect".to_string(),
        id,
        data: None,
      });

      // Writer task
      tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(msg) = rx.recv().await {
          if write_half.write_all(msg.as_bytes()).await.is_err() {
            break;
          }
          if write_half.write_all(b"\n").await.is_err() {
            break;
          }
        }
      });

      // Reader task
      let events_tx_reader = events_tx.clone();
      let conns_reader = conns_clone.clone();
      tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(read_half);
        let mut line = String::new();
        loop {
          line.clear();
          match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
              let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
              let _ = events_tx_reader.send(IpcServerEvent {
                kind: "message".to_string(),
                id,
                data: Some(trimmed),
              });
            }
            Err(_) => break,
          }
        }
        conns_reader.lock().unwrap().remove(&id);
        let _ = events_tx_reader.send(IpcServerEvent {
          kind: "disconnect".to_string(),
          id,
          data: None,
        });
      });
    }
  });

  let server = IpcServer {
    conns,
    events_rx: Arc::new(TokioMutex::new(events_rx)),
    shutdown: Some(shutdown_tx),
  };
  let table = ipc_table(state);
  let id = table.next_id;
  table.next_id += 1;
  table.servers.insert(id, server);
  Ok(IpcServerInfo { id, port })
}

#[op2]
#[serde]
pub async fn op_ipc_server_poll(
  state: Rc<RefCell<OpState>>,
  server_id: u32,
) -> Result<Option<IpcServerEvent>, JsErrorBox> {
  let rx = {
    let state_guard = state.borrow();
    let table = state_guard
      .try_borrow::<IpcTable>()
      .ok_or_else(|| JsErrorBox::generic("no ipc table"))?;
    let server = table
      .servers
      .get(&server_id)
      .ok_or_else(|| JsErrorBox::generic("ipc server not found"))?;
    server.events_rx.clone()
  };
  let mut guard = rx.lock().await;
  Ok(guard.recv().await)
}

#[op2(fast)]
pub fn op_ipc_server_send(
  state: &mut OpState,
  server_id: u32,
  conn_id: u32,
  #[string] msg: String,
) -> bool {
  let table = ipc_table(state);
  if let Some(server) = table.servers.get(&server_id)
    && let Some(tx) = server.conns.lock().unwrap().get(&conn_id)
  {
    return tx.send(msg).is_ok();
  }
  false
}

#[op2(fast)]
pub fn op_ipc_server_close(state: &mut OpState, server_id: u32) {
  let table = ipc_table(state);
  if let Some(mut server) = table.servers.remove(&server_id)
    && let Some(shutdown) = server.shutdown.take()
  {
    let _ = shutdown.send(());
  }
}

#[op2]
pub async fn op_ipc_client_connect(
  state: Rc<RefCell<OpState>>,
  port: u32,
) -> Result<u32, JsErrorBox> {
  let stream = tokio::net::TcpStream::connect(("127.0.0.1", port as u16))
    .await
    .map_err(|e| JsErrorBox::generic(format!("ipc connect: {e}")))?;
  let (read_half, mut write_half) = stream.into_split();
  let (tx, mut rx) = mpsc::unbounded_channel::<String>();
  let (msg_tx, msg_rx) = mpsc::unbounded_channel::<Option<String>>();
  let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();

  // Writer task
  tokio::spawn(async move {
    use tokio::io::AsyncWriteExt;
    loop {
      tokio::select! {
        biased;
        _ = &mut shutdown_rx => break,
        msg = rx.recv() => {
          match msg {
            Some(m) => {
              if write_half.write_all(m.as_bytes()).await.is_err() {
                break;
              }
              if write_half.write_all(b"\n").await.is_err() {
                break;
              }
            }
            None => break,
          }
        }
      }
    }
  });

  // Reader task
  tokio::spawn(async move {
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut line = String::new();
    loop {
      line.clear();
      match reader.read_line(&mut line).await {
        Ok(0) => {
          let _ = msg_tx.send(None);
          break;
        }
        Ok(_) => {
          let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
          if msg_tx.send(Some(trimmed)).is_err() {
            break;
          }
        }
        Err(_) => {
          let _ = msg_tx.send(None);
          break;
        }
      }
    }
  });

  let client = IpcClient {
    tx,
    rx: Arc::new(TokioMutex::new(msg_rx)),
    shutdown: Some(shutdown_tx),
  };

  let id = {
    let mut state_guard = state.borrow_mut();
    let table = ipc_table(&mut state_guard);
    let id = table.next_client_id;
    table.next_client_id += 1;
    table.clients.insert(id, client);
    id
  };
  Ok(id)
}

#[op2]
#[string]
pub async fn op_ipc_client_poll(
  state: Rc<RefCell<OpState>>,
  client_id: u32,
) -> Result<Option<String>, JsErrorBox> {
  let rx = {
    let state_guard = state.borrow();
    let table = state_guard
      .try_borrow::<IpcTable>()
      .ok_or_else(|| JsErrorBox::generic("no ipc table"))?;
    let client = table
      .clients
      .get(&client_id)
      .ok_or_else(|| JsErrorBox::generic("ipc client not found"))?;
    client.rx.clone()
  };
  let mut guard = rx.lock().await;
  Ok(guard.recv().await.flatten())
}

#[op2(fast)]
pub fn op_ipc_client_send(
  state: &mut OpState,
  client_id: u32,
  #[string] msg: String,
) -> bool {
  let table = ipc_table(state);
  if let Some(client) = table.clients.get(&client_id) {
    return client.tx.send(msg).is_ok();
  }
  false
}

#[op2(fast)]
pub fn op_ipc_client_close(state: &mut OpState, client_id: u32) {
  let table = ipc_table(state);
  if let Some(mut client) = table.clients.remove(&client_id)
    && let Some(shutdown) = client.shutdown.take()
  {
    let _ = shutdown.send(());
  }
}

// ---------------------------------------------------------------------------
// Logging ops
// ---------------------------------------------------------------------------

#[op2(fast)]
pub fn op_log(level: u8, #[string] target: String, #[string] message: String) {
  crate::logger::log(crate::logger::LogLevel::from_u8(level), &target, &message);
}

#[op2(fast)]
pub fn op_log_get_level() -> u8 {
  crate::logger::get_level() as u8
}

#[op2(fast)]
pub fn op_log_set_level(level: u8) {
  crate::logger::set_level(crate::logger::LogLevel::from_u8(level));
}

#[op2(fast)]
pub fn op_log_get_format() -> u8 {
  crate::logger::get_format() as u8
}

#[op2(fast)]
pub fn op_log_set_format(format: u8) {
  crate::logger::set_format(crate::logger::LogFormat::from_u8(format));
}

#[op2(fast)]
pub fn op_log_is_http_enabled() -> bool {
  crate::logger::is_http_log_enabled()
}

#[op2(fast)]
pub fn op_log_set_http_enabled(enabled: bool) {
  crate::logger::set_http_log_enabled(enabled);
}

