// OS-specific pieces behind one interface, so ops stay platform-neutral.
// Unix uses std's unix extensions and nix; Windows maps each call to the
// closest equivalent (and to what Node reports there, e.g. uid -1).
use std::fs::{File, Metadata};
use std::io;
#[cfg(windows)]
use std::path::Path;

/// fs.Stats fields that std only exposes per platform.
pub struct StatFields {
  pub mtime_ms: f64,
  pub ctime_ms: f64,
  pub atime_ms: f64,
  pub ino: u64,
  pub mode: u32,
  pub uid: u32,
  pub gid: u32,
  pub nlink: u64,
  pub dev: u64,
  pub rdev: u64,
  pub blksize: u64,
  pub blocks: u64,
}

#[cfg(unix)]
pub fn stat_fields(meta: &Metadata) -> StatFields {
  use std::os::unix::fs::MetadataExt;
  let ms = |secs: i64, nsec: i64| secs as f64 * 1000.0 + nsec as f64 / 1_000_000.0;
  StatFields {
    mtime_ms: ms(meta.mtime(), meta.mtime_nsec()),
    ctime_ms: ms(meta.ctime(), meta.ctime_nsec()),
    atime_ms: ms(meta.atime(), meta.atime_nsec()),
    ino: meta.ino(),
    mode: meta.mode(),
    uid: meta.uid(),
    gid: meta.gid(),
    nlink: meta.nlink(),
    dev: meta.dev(),
    rdev: meta.rdev(),
    blksize: meta.blksize(),
    blocks: meta.blocks(),
  }
}

#[cfg(windows)]
pub fn stat_fields(meta: &Metadata) -> StatFields {
  let ms = |t: io::Result<std::time::SystemTime>| {
    t.ok()
      .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
      .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
  };
  // Like libuv: type bits plus rw (or read-only) permissions for everyone.
  let perms = if meta.permissions().readonly() { 0o444 } else { 0o666 };
  let mode = if meta.file_type().is_symlink() {
    0o120000 | perms
  } else if meta.is_dir() {
    0o040000 | perms | 0o111
  } else {
    0o100000 | perms
  };
  let mtime = ms(meta.modified());
  StatFields {
    mtime_ms: mtime,
    ctime_ms: mtime, // Windows has no inode change time.
    atime_ms: ms(meta.accessed()),
    ino: 0,
    mode,
    uid: 0,
    gid: 0,
    nlink: 1,
    dev: 0,
    rdev: 0,
    blksize: 4096,
    blocks: meta.len().div_ceil(512),
  }
}

pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
  #[cfg(unix)]
  return std::os::unix::fs::FileExt::read_at(file, buf, offset);
  #[cfg(windows)]
  return std::os::windows::fs::FileExt::seek_read(file, buf, offset);
}

pub fn write_at(file: &File, data: &[u8], offset: u64) -> io::Result<usize> {
  #[cfg(unix)]
  return std::os::unix::fs::FileExt::write_at(file, data, offset);
  #[cfg(windows)]
  return std::os::windows::fs::FileExt::seek_write(file, data, offset);
}

/// Forcefully terminate a process (SIGKILL / TerminateProcess).
pub fn kill(pid: i32) -> bool {
  #[cfg(unix)]
  return nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL).is_ok();
  #[cfg(windows)]
  return std::process::Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/T", "/F"])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .status()
    .is_ok_and(|s| s.success());
}

/// access(2) mode bits (identical on every platform Node supports).
pub const F_OK: u32 = 0;
pub const R_OK: u32 = 4;
pub const W_OK: u32 = 2;
pub const X_OK: u32 = 1;

/// Whether `mode` (R_OK/W_OK/X_OK bits) is denied for the current user.
#[cfg(unix)]
pub fn access_denied(meta: &Metadata, mode: u32) -> bool {
  use std::os::unix::fs::MetadataExt;
  let uid = nix::unistd::Uid::current().as_raw();
  let gid = nix::unistd::Gid::current().as_raw();
  let bits = meta.mode();
  let (r, w, x) = if uid == 0 {
    (true, true, bits & 0o111 != 0)
  } else if meta.uid() == uid {
    (bits & 0o400 != 0, bits & 0o200 != 0, bits & 0o100 != 0)
  } else if meta.gid() == gid {
    (bits & 0o040 != 0, bits & 0o020 != 0, bits & 0o010 != 0)
  } else {
    (bits & 0o004 != 0, bits & 0o002 != 0, bits & 0o001 != 0)
  };
  (mode & R_OK != 0 && !r) || (mode & W_OK != 0 && !w) || (mode & X_OK != 0 && !x)
}

/// On Windows only write access can be denied (the read-only attribute).
#[cfg(windows)]
pub fn access_denied(meta: &Metadata, mode: u32) -> bool {
  mode & W_OK != 0 && meta.permissions().readonly()
}

/// chmod; on Windows only the owner-write bit maps (to the read-only flag).
pub fn set_mode(path: &str, mode: u32) -> io::Result<()> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
  }
  #[cfg(windows)]
  {
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_readonly(mode & 0o200 == 0);
    std::fs::set_permissions(path, perms)
  }
}

pub fn symlink(target: &str, link: &str) -> io::Result<()> {
  #[cfg(unix)]
  return std::os::unix::fs::symlink(target, link);
  #[cfg(windows)]
  {
    // Windows needs to know the link kind; resolve the target relative to
    // the link's directory, as the OS will.
    let base = Path::new(link).parent().unwrap_or(Path::new("."));
    if base.join(target).is_dir() {
      std::os::windows::fs::symlink_dir(target, link)
    } else {
      std::os::windows::fs::symlink_file(target, link)
    }
  }
}

/// fs.constants open flags: [O_RDONLY, O_WRONLY, O_RDWR, O_APPEND, O_CREAT,
/// O_EXCL, O_TRUNC, O_SYNC] with the values Node reports on this platform.
pub fn open_flags() -> [i32; 8] {
  #[cfg(unix)]
  {
    use nix::libc;
    [
      libc::O_RDONLY,
      libc::O_WRONLY,
      libc::O_RDWR,
      libc::O_APPEND,
      libc::O_CREAT,
      libc::O_EXCL,
      libc::O_TRUNC,
      libc::O_SYNC,
    ]
  }
  #[cfg(windows)]
  {
    // MSVC CRT values (Node has no O_SYNC on Windows; 0 never matches).
    [0x0000, 0x0001, 0x0002, 0x0008, 0x0100, 0x0400, 0x0200, 0]
  }
}

pub struct OsNames {
  pub hostname: String,
  pub sysname: String,
  pub release: String,
  pub version: String,
  pub machine: String,
  /// -1 on Windows, as Node reports.
  pub uid: i64,
  pub gid: i64,
}

#[cfg(unix)]
pub fn os_names() -> io::Result<OsNames> {
  let uname = nix::sys::utsname::uname().map_err(io::Error::from)?;
  let text = |s: &std::ffi::OsStr| s.to_string_lossy().into_owned();
  Ok(OsNames {
    hostname: text(uname.nodename()),
    sysname: text(uname.sysname()),
    release: text(uname.release()),
    version: text(uname.version()),
    machine: text(uname.machine()),
    uid: nix::unistd::Uid::current().as_raw() as i64,
    gid: nix::unistd::Gid::current().as_raw() as i64,
  })
}

#[cfg(windows)]
pub fn os_names() -> io::Result<OsNames> {
  Ok(OsNames {
    hostname: sysinfo::System::host_name().unwrap_or_default(),
    sysname: "Windows_NT".into(),
    release: sysinfo::System::kernel_version().unwrap_or_default(),
    version: sysinfo::System::long_os_version().unwrap_or_default(),
    machine: match std::env::consts::ARCH {
      "aarch64" => "arm64".into(),
      arch => arch.into(),
    },
    uid: -1,
    gid: -1,
  })
}

pub fn ppid() -> u32 {
  #[cfg(unix)]
  return nix::unistd::getppid().as_raw() as u32;
  #[cfg(windows)]
  {
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).and_then(|p| p.parent()).map_or(0, |p| p.as_u32())
  }
}
