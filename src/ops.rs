// Rust ops exposed to JavaScript via deno_core's op2 machinery.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

use deno_core::OpState;
use deno_core::op2;
use deno_core::v8;
use deno_error::JsErrorBox;
use tokio::sync::Mutex as TokioMutex;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Process-wide argv (set once by the CLI before any runtime is created).
// ---------------------------------------------------------------------------

static ARGV: OnceLock<Vec<String>> = OnceLock::new();

pub fn set_argv(argv: Vec<String>) {
  let _ = ARGV.set(argv);
}

fn argv() -> Vec<String> {
  ARGV.get().cloned().unwrap_or_default()
}

static NO_WARNINGS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_no_warnings(val: bool) {
  NO_WARNINGS.store(val, Ordering::SeqCst);
}

pub fn get_no_warnings() -> bool {
  NO_WARNINGS.load(Ordering::SeqCst)
}


// ---------------------------------------------------------------------------
// Channels (green-thread messaging, backed by tokio mpsc).
// Messages are V8 structured-clone binaries produced by op_serialize on the
// JS side; an empty payload signals end-of-channel (the serializer never
// produces empty output).
// ---------------------------------------------------------------------------

type SharedRx = Arc<TokioMutex<mpsc::UnboundedReceiver<Vec<u8>>>>;

fn chan_msg_or_closed(msg: Option<Vec<u8>>) -> Vec<u8> {
  msg.unwrap_or_default()
}

#[derive(Clone)]
enum ChanSender {
  Unbounded(mpsc::UnboundedSender<Vec<u8>>),
  Bounded(mpsc::Sender<Vec<u8>>),
}

enum ChanReceiver {
  Unbounded(mpsc::UnboundedReceiver<Vec<u8>>),
  Bounded(mpsc::Receiver<Vec<u8>>),
}

impl ChanReceiver {
  async fn recv(&mut self) -> Option<Vec<u8>> {
    match self {
      ChanReceiver::Unbounded(rx) => rx.recv().await,
      ChanReceiver::Bounded(rx) => rx.recv().await,
    }
  }

  fn close(&mut self) {
    match self {
      ChanReceiver::Unbounded(rx) => rx.close(),
      ChanReceiver::Bounded(rx) => rx.close(),
    }
  }
}

type SharedChanRx = Arc<TokioMutex<ChanReceiver>>;

struct ChanEntry {
  tx: Option<ChanSender>,
  rx: SharedChanRx,
  capacity: u32,
}

#[derive(Default)]
struct ChanTable {
  next_id: u32,
  chans: HashMap<u32, ChanEntry>,
}

fn chan_table(state: &mut OpState) -> &mut ChanTable {
  if !state.has::<ChanTable>() {
    state.put(ChanTable::default());
  }
  state.borrow_mut::<ChanTable>()
}

// ---------------------------------------------------------------------------
// Workers. The registry is process-global so the parent isolate's ops can
// reach channels owned by worker threads and vice versa.
// ---------------------------------------------------------------------------

pub struct WorkerEntry {
  pub to_child: mpsc::UnboundedSender<Vec<u8>>,
  pub from_child: SharedRx,
}

static WORKERS: OnceLock<StdMutex<HashMap<u32, WorkerEntry>>> = OnceLock::new();
static NEXT_WORKER_ID: AtomicU32 = AtomicU32::new(1);

fn workers() -> &'static StdMutex<HashMap<u32, WorkerEntry>> {
  WORKERS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// State placed in a worker isolate's OpState so its ops can talk to the
/// parent.
pub struct WorkerHost {
  pub to_parent: mpsc::UnboundedSender<Vec<u8>>,
  pub from_parent: SharedRx,
}

/// Ids of workers spawned by one runtime, tracked in its OpState so
/// shutdown only tears down that runtime's own workers (other isolates in
/// the process are unaffected).
#[derive(Default)]
pub struct SpawnedWorkers(pub Vec<u32>);

/// Terminate the workers spawned by the runtime owning `state`: dropping
/// the registry entries closes the channels, so worker host loops observe
/// channel closure and exit. Called when the main module has finished.
pub fn shutdown_workers(state: &mut OpState) {
  let ids: Vec<u32> = if state.has::<SpawnedWorkers>() {
    std::mem::take(&mut state.borrow_mut::<SpawnedWorkers>().0)
  } else {
    Vec::new()
  };
  if ids.is_empty() {
    return;
  }
  let mut registry = workers().lock().unwrap();
  for id in ids {
    registry.remove(&id);
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

fn monotonic_start() -> &'static std::time::Instant {
  static START: OnceLock<std::time::Instant> = OnceLock::new();
  START.get_or_init(std::time::Instant::now)
}

#[op2(fast)]
pub fn op_now() -> f64 {
  monotonic_start().elapsed().as_secs_f64() * 1000.0
}

/// Per-runtime timer state backing the JS-side timer heap. A single
/// op_sleep_until is armed for the earliest deadline at any time; pushing an
/// earlier deadline or clearing the earliest timer pokes the Notify so the
/// pending op resolves early and the pump can re-arm.
struct TimerState {
  notify: Rc<tokio::sync::Notify>,
}

fn timer_notify(state: &mut OpState) -> Rc<tokio::sync::Notify> {
  if !state.has::<TimerState>() {
    state.put(TimerState {
      notify: Rc::new(tokio::sync::Notify::new()),
    });
  }
  state.borrow::<TimerState>().notify.clone()
}

/// Sleep until `deadline_ms` on the op_now() monotonic clock, or until the
/// timer heap is poked (earlier deadline pushed / earliest timer cleared).
/// A poke that races the arm is not lost: Notify stores one permit, so the
/// op resolves immediately on the next poll.
#[op2]
pub async fn op_sleep_until(state: Rc<RefCell<OpState>>, deadline_ms: f64) {
  let notify = {
    let mut state = state.borrow_mut();
    timer_notify(&mut state)
  };
  let now = monotonic_start().elapsed().as_secs_f64() * 1000.0;
  let remaining = deadline_ms - now;
  let notified = notify.notified();
  if remaining <= 0.0 {
    // Still consume a pending permit so a stale poke cannot cause a
    // spurious extra wakeup later.
    tokio::pin!(notified);
    let _ = notified.as_mut().enable();
    return;
  }
  tokio::select! {
    _ = tokio::time::sleep(std::time::Duration::from_secs_f64(remaining / 1000.0)) => {},
    _ = notified => {},
  }
}

/// Wake a pending op_sleep_until early (see above). Cheap no-op when the
/// pump is not currently sleeping.
#[op2(fast)]
pub fn op_timer_poke(state: &mut OpState) {
  timer_notify(state).notify_one();
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

#[op2]
#[string]
pub async fn op_read_text_file(#[string] path: String) -> Result<String, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  tokio::fs::read_to_string(&path)
    .await
    .map_err(|e| JsErrorBox::generic(format!("read {}: {e}", path)))
}

#[op2]
#[string]
pub fn op_read_text_file_sync(#[string] path: String) -> Result<String, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  std::fs::read_to_string(&path).map_err(|e| JsErrorBox::generic(format!("read {}: {e}", path)))
}

#[op2]
#[buffer]
pub async fn op_read_file_bytes(#[string] path: String) -> Result<Vec<u8>, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  tokio::fs::read(&path)
    .await
    .map_err(|e| JsErrorBox::generic(format!("read {}: {e}", path)))
}

#[op2]
#[buffer]
pub fn op_read_file_bytes_sync(#[string] path: String) -> Result<Vec<u8>, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  std::fs::read(&path).map_err(|e| JsErrorBox::generic(format!("read {}: {e}", path)))
}

#[op2]
pub async fn op_write_text_file(
  #[string] path: String,
  #[string] contents: String,
) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(&path)?;
  tokio::fs::write(&path, contents)
    .await
    .map_err(|e| JsErrorBox::generic(format!("write {}: {e}", path)))
}

#[op2(fast)]
pub fn op_write_text_file_sync(
  #[string] path: String,
  #[string] contents: String,
) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(&path)?;
  std::fs::write(&path, contents).map_err(|e| JsErrorBox::generic(format!("write {}: {e}", path)))
}

#[op2]
pub async fn op_write_file_bytes(
  #[string] path: String,
  #[buffer(copy)] data: Vec<u8>,
) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(&path)?;
  tokio::fs::write(&path, data)
    .await
    .map_err(|e| JsErrorBox::generic(format!("write {}: {e}", path)))
}

#[op2(fast)]
pub fn op_write_file_bytes_sync(
  #[string] path: String,
  #[buffer] data: &[u8],
) -> Result<(), JsErrorBox> {
  crate::permissions::check_write(&path)?;
  std::fs::write(&path, data).map_err(|e| JsErrorBox::generic(format!("write {}: {e}", path)))
}

#[op2(fast)]
pub fn op_exists_sync(#[string] path: String) -> Result<bool, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  Ok(std::path::Path::new(&path).exists())
}

#[op2(fast)]
pub fn op_is_dir_sync(#[string] path: String) -> Result<bool, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  Ok(std::path::Path::new(&path).is_dir())
}

#[derive(serde::Serialize)]
struct StatInfo {
  size: u64,
  mtime_ms: f64,
  ctime_ms: f64,
  atime_ms: f64,
  birthtime_ms: f64,
  ino: u64,
  mode: u32,
  uid: u32,
  gid: u32,
  nlink: u64,
  dev: u64,
  rdev: u64,
  blksize: u64,
  blocks: u64,
  is_dir: bool,
  is_file: bool,
  is_symlink: bool,
}

fn unix_ms(secs: i64, nsec: i64) -> f64 {
  secs as f64 * 1000.0 + nsec as f64 / 1_000_000.0
}

fn stat_info(path: &str, follow: bool) -> Result<StatInfo, JsErrorBox> {
  use std::os::unix::fs::MetadataExt;
  let meta = if follow {
    std::fs::metadata(path)
  } else {
    std::fs::symlink_metadata(path)
  }
  .map_err(|e| JsErrorBox::generic(format!("ENOENT: no such file or directory, stat '{path}': {e}")))?;
  let birthtime_ms = meta
    .created()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs_f64() * 1000.0)
    .unwrap_or(0.0);
  Ok(StatInfo {
    size: meta.len(),
    mtime_ms: unix_ms(meta.mtime(), meta.mtime_nsec()),
    ctime_ms: unix_ms(meta.ctime(), meta.ctime_nsec()),
    atime_ms: unix_ms(meta.atime(), meta.atime_nsec()),
    birthtime_ms,
    ino: meta.ino(),
    mode: meta.mode(),
    uid: meta.uid(),
    gid: meta.gid(),
    nlink: meta.nlink(),
    dev: meta.dev(),
    rdev: meta.rdev(),
    blksize: meta.blksize(),
    blocks: meta.blocks(),
    is_dir: meta.is_dir(),
    is_file: meta.is_file(),
    is_symlink: !follow && meta.file_type().is_symlink(),
  })
}

fn fstat_info(meta: &std::fs::Metadata) -> StatInfo {
  use std::os::unix::fs::MetadataExt;
  let birthtime_ms = meta
    .created()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs_f64() * 1000.0)
    .unwrap_or(0.0);
  StatInfo {
    size: meta.len(),
    mtime_ms: unix_ms(meta.mtime(), meta.mtime_nsec()),
    ctime_ms: unix_ms(meta.ctime(), meta.ctime_nsec()),
    atime_ms: unix_ms(meta.atime(), meta.atime_nsec()),
    birthtime_ms,
    ino: meta.ino(),
    mode: meta.mode(),
    uid: meta.uid(),
    gid: meta.gid(),
    nlink: meta.nlink(),
    dev: meta.dev(),
    rdev: meta.rdev(),
    blksize: meta.blksize(),
    blocks: meta.blocks(),
    is_dir: meta.is_dir(),
    is_file: meta.is_file(),
    is_symlink: meta.file_type().is_symlink(),
  }
}

#[derive(Default)]
pub struct FdTable {
  pub next_fd: u32,
  pub files: HashMap<u32, Arc<StdMutex<std::fs::File>>>,
}

fn fd_table(state: &mut OpState) -> &mut FdTable {
  if !state.has::<FdTable>() {
    state.put(FdTable {
      next_fd: 100,
      files: HashMap::new(),
    });
  }
  state.borrow_mut::<FdTable>()
}

#[op2(fast)]
pub fn op_fs_open(
  state: &mut OpState,
  #[string] path: String,
  #[string] flags: String,
  mode: u32,
) -> Result<u32, JsErrorBox> {
  if flags.contains('w') || flags.contains('a') || flags.contains('+') {
    crate::permissions::check_write(&path)?;
  }
  if flags.starts_with('r') || flags.contains('+') {
    crate::permissions::check_read(&path)?;
  }
  use std::fs::OpenOptions;
  let mut opts = OpenOptions::new();
  match flags.as_str() {
    "r" => {
      opts.read(true);
    }
    "r+" => {
      opts.read(true).write(true);
    }
    "w" => {
      opts.write(true).create(true).truncate(true);
    }
    "w+" => {
      opts.read(true).write(true).create(true).truncate(true);
    }
    "a" => {
      opts.write(true).create(true).append(true);
    }
    "a+" => {
      opts.read(true).write(true).create(true).append(true);
    }
    "wx" | "xw" => {
      opts.write(true).create_new(true);
    }
    "wx+" | "xw+" => {
      opts.read(true).write(true).create_new(true);
    }
    _ => {
      if flags.contains('+') {
        opts.read(true).write(true);
      } else if flags.starts_with('r') {
        opts.read(true);
      } else {
        opts.write(true);
      }
      if flags.contains('w') {
        opts.create(true).truncate(true);
      } else if flags.contains('a') {
        opts.create(true).append(true);
      }
    }
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    if mode > 0 {
      opts.mode(mode);
    }
  }
  let file = opts
    .open(&path)
    .map_err(|e| JsErrorBox::generic(format!("open '{path}': {e}")))?;
  let table = fd_table(state);
  let fd = table.next_fd;
  table.next_fd += 1;
  table.files.insert(fd, Arc::new(StdMutex::new(file)));
  Ok(fd)
}

#[op2(fast)]
pub fn op_fs_close(state: &mut OpState, fd: u32) -> Result<(), JsErrorBox> {
  let table = fd_table(state);
  if table.files.remove(&fd).is_some() {
    Ok(())
  } else {
    Err(JsErrorBox::generic(format!("EBADF: bad file descriptor {fd}")))
  }
}

#[op2]
#[serde]
pub fn op_fs_fstat(state: &mut OpState, fd: u32) -> Result<StatInfo, JsErrorBox> {
  let table = fd_table(state);
  let file = table
    .files
    .get(&fd)
    .cloned()
    .ok_or_else(|| JsErrorBox::generic(format!("EBADF: bad file descriptor {fd}")))?;
  let guard = file.lock().unwrap();
  let meta = guard
    .metadata()
    .map_err(|e| JsErrorBox::generic(format!("fstat {fd}: {e}")))?;
  Ok(fstat_info(&meta))
}

#[op2]
#[buffer]
pub fn op_fs_read(
  state: &mut OpState,
  fd: u32,
  len: u32,
  position: f64,
) -> Result<Vec<u8>, JsErrorBox> {
  let table = fd_table(state);
  let file = table
    .files
    .get(&fd)
    .cloned()
    .ok_or_else(|| JsErrorBox::generic(format!("EBADF: bad file descriptor {fd}")))?;
  let mut guard = file.lock().unwrap();
  let mut buf = vec![0u8; len as usize];
  let n = if position >= 0.0 {
    use std::os::unix::fs::FileExt;
    guard
      .read_at(&mut buf, position as u64)
      .map_err(|e| JsErrorBox::generic(format!("read {fd}: {e}")))?
  } else {
    use std::io::Read;
    guard
      .read(&mut buf)
      .map_err(|e| JsErrorBox::generic(format!("read {fd}: {e}")))?
  };
  buf.truncate(n);
  Ok(buf)
}

#[op2(fast)]
pub fn op_fs_write(
  state: &mut OpState,
  fd: u32,
  #[buffer] data: &[u8],
  position: f64,
) -> Result<u32, JsErrorBox> {
  let table = fd_table(state);
  let file = table
    .files
    .get(&fd)
    .cloned()
    .ok_or_else(|| JsErrorBox::generic(format!("EBADF: bad file descriptor {fd}")))?;
  let mut guard = file.lock().unwrap();
  let n = if position >= 0.0 {
    use std::os::unix::fs::FileExt;
    guard
      .write_at(data, position as u64)
      .map_err(|e| JsErrorBox::generic(format!("write {fd}: {e}")))?
  } else {
    use std::io::Write;
    guard
      .write(data)
      .map_err(|e| JsErrorBox::generic(format!("write {fd}: {e}")))?
  };
  Ok(n as u32)
}

#[op2(fast)]
pub fn op_fs_ftruncate(state: &mut OpState, fd: u32, len: f64) -> Result<(), JsErrorBox> {
  let table = fd_table(state);
  let file = table
    .files
    .get(&fd)
    .cloned()
    .ok_or_else(|| JsErrorBox::generic(format!("EBADF: bad file descriptor {fd}")))?;
  let guard = file.lock().unwrap();
  guard
    .set_len(len as u64)
    .map_err(|e| JsErrorBox::generic(format!("ftruncate {fd}: {e}")))
}

#[op2(fast)]
pub fn op_fs_fsync(state: &mut OpState, fd: u32) -> Result<(), JsErrorBox> {
  let table = fd_table(state);
  let file = table
    .files
    .get(&fd)
    .cloned()
    .ok_or_else(|| JsErrorBox::generic(format!("EBADF: bad file descriptor {fd}")))?;
  let guard = file.lock().unwrap();
  guard
    .sync_all()
    .map_err(|e| JsErrorBox::generic(format!("fsync {fd}: {e}")))
}

#[op2]
#[serde]
pub fn op_stat_sync(#[string] path: String) -> Result<StatInfo, JsErrorBox> {
  crate::permissions::check_read(&path)?;
  stat_info(&path, true)
}

#[op2]
#[serde]
pub async fn op_stat(#[string] path: String) -> Result<StatInfo, JsErrorBox> {
  off_thread(move || {
    crate::permissions::check_read(&path)?;
    stat_info(&path, true)
  })
  .await
}

// ---------------------------------------------------------------------------
// process
// ---------------------------------------------------------------------------

#[op2]
#[serde]
pub fn op_env() -> Result<Vec<(String, String)>, JsErrorBox> {
  crate::permissions::check_env()?;
  let mut vars: std::collections::HashMap<String, String> = std::env::vars().collect();
  if let Ok(extra) = crate::config::CONFIG_ENV.read() {
    for (k, v) in extra.iter() {
      vars.insert(k.clone(), v.clone());
    }
  }
  Ok(vars.into_iter().collect())
}

#[op2]
#[serde]
pub fn op_args() -> Vec<String> {
  argv()
}

#[op2]
#[string]
pub fn op_cwd() -> Result<String, JsErrorBox> {
  std::env::current_dir()
    .map(|p| p.to_string_lossy().into_owned())
    .map_err(JsErrorBox::from_err)
}

#[op2(fast)]
pub fn op_exit(code: i32) {
  std::process::exit(code);
}

#[op2]
#[string]
pub fn op_platform() -> String {
  std::env::consts::OS.to_string()
}

#[op2]
#[string]
pub fn op_arch() -> String {
  std::env::consts::ARCH.to_string()
}

fn get_cgroup_cpus() -> Option<u32> {
  // cgroups v2: /sys/fs/cgroup/cpu.max contains "$QUOTA $PERIOD"
  if let Ok(cpu_max) = std::fs::read_to_string("/sys/fs/cgroup/cpu.max") {
    let mut parts = cpu_max.split_whitespace();
    if let (Some(max_str), Some(period_str)) = (parts.next(), parts.next())
      && max_str != "max"
      && let (Ok(max_val), Ok(period_val)) = (max_str.parse::<f64>(), period_str.parse::<f64>())
      && period_val > 0.0
    {
      let cores = (max_val / period_val).ceil() as u32;
      return Some(cores.max(1));
    }
  }
  // cgroups v1: /sys/fs/cgroup/cpu/cpu.cfs_quota_us and cpu.cfs_period_us
  if let Ok(quota_str) = std::fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
    && let Ok(quota) = quota_str.trim().parse::<i64>()
    && quota > 0
    && let Ok(period_str) = std::fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    && let Ok(period) = period_str.trim().parse::<i64>()
    && period > 0
  {
    let cores = ((quota as f64) / (period as f64)).ceil() as u32;
    return Some(cores.max(1));
  }
  None
}

#[op2(fast)]
pub fn op_cpus() -> u32 {
  let host = std::thread::available_parallelism()
    .map(|n| n.get() as u32)
    .unwrap_or(1);
  if let Some(cgroup_cpus) = get_cgroup_cpus() {
    cgroup_cpus.min(host).max(1)
  } else {
    host
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

#[op2(fast)]
pub fn op_chan_new(state: &mut OpState, capacity: u32) -> u32 {
  let table = chan_table(state);
  let id = table.next_id;
  table.next_id += 1;
  let (tx, rx) = if capacity == 0 {
    let (t, r) = mpsc::unbounded_channel();
    (ChanSender::Unbounded(t), ChanReceiver::Unbounded(r))
  } else {
    let (t, r) = mpsc::channel(capacity as usize);
    (ChanSender::Bounded(t), ChanReceiver::Bounded(r))
  };
  table.chans.insert(
    id,
    ChanEntry {
      tx: Some(tx),
      rx: Arc::new(TokioMutex::new(rx)),
      capacity,
    },
  );
  id
}

#[op2(fast)]
pub fn op_chan_capacity(state: &mut OpState, id: u32) -> u32 {
  let table = chan_table(state);
  table.chans.get(&id).map(|e| e.capacity).unwrap_or(0)
}

#[op2]
pub async fn op_chan_send(
  state: Rc<RefCell<OpState>>,
  id: u32,
  #[buffer(copy)] msg: Vec<u8>,
) -> Result<bool, JsErrorBox> {
  let sender = {
    let mut state = state.borrow_mut();
    let table = chan_table(&mut state);
    match table.chans.get(&id) {
      Some(entry) => match &entry.tx {
        Some(ChanSender::Unbounded(tx)) => {
          return Ok(tx.send(msg).is_ok());
        }
        Some(ChanSender::Bounded(tx)) => tx.clone(),
        None => return Ok(false), // closed
      },
      None => return Err(JsErrorBox::generic(format!("no channel with id {id}"))),
    }
  };
  match sender.send(msg).await {
    Ok(()) => Ok(true),
    Err(_) => Ok(false),
  }
}

#[op2]
#[buffer]
pub async fn op_chan_recv(
  state: Rc<RefCell<OpState>>,
  id: u32,
) -> Result<Vec<u8>, JsErrorBox> {
  let rx = {
    let mut state = state.borrow_mut();
    let table = chan_table(&mut state);
    table.chans.get(&id).map(|e| e.rx.clone())
  };
  match rx {
    Some(rx) => {
      let msg = rx.lock().await.recv().await;
      if msg.is_none() {
        let mut state = state.borrow_mut();
        let table = chan_table(&mut state);
        table.chans.remove(&id);
      }
      Ok(chan_msg_or_closed(msg))
    }
    None => Ok(Vec::new()), // unknown/closed channel: done
  }
}

#[op2(fast)]
pub fn op_chan_close(state: &mut OpState, id: u32) {
  let table = chan_table(state);
  if let Some(entry) = table.chans.get_mut(&id) {
    entry.tx.take();
    let rx = entry.rx.clone();
    if let Ok(mut guard) = rx.try_lock() {
      guard.close();
    } else {
      tokio::spawn(async move {
        rx.lock().await.close();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Workers (parent side)
// ---------------------------------------------------------------------------

#[op2(fast)]
pub fn op_worker_spawn(
  state: &mut OpState,
  #[string] specifier: String,
) -> Result<u32, JsErrorBox> {
  let id = NEXT_WORKER_ID.fetch_add(1, Ordering::SeqCst);
  if !state.has::<SpawnedWorkers>() {
    state.put(SpawnedWorkers::default());
  }
  state.borrow_mut::<SpawnedWorkers>().0.push(id);
  let (to_child_tx, to_child_rx) = mpsc::unbounded_channel::<Vec<u8>>();
  let (from_child_tx, from_child_rx) = mpsc::unbounded_channel::<Vec<u8>>();
  workers().lock().unwrap().insert(
    id,
    WorkerEntry {
      to_child: to_child_tx,
      from_child: Arc::new(TokioMutex::new(from_child_rx)),
    },
  );
  crate::worker::spawn_worker_thread(
    specifier,
    WorkerHost {
      to_parent: from_child_tx,
      from_parent: Arc::new(TokioMutex::new(to_child_rx)),
    },
  );
  Ok(id)
}

#[op2(fast)]
pub fn op_worker_send(id: u32, #[buffer] msg: &[u8]) -> bool {
  let registry = workers().lock().unwrap();
  match registry.get(&id) {
    Some(entry) => entry.to_child.send(msg.to_vec()).is_ok(),
    None => false,
  }
}

#[op2]
#[buffer]
pub async fn op_worker_recv(id: u32) -> Vec<u8> {
  let rx = {
    let registry = workers().lock().unwrap();
    registry.get(&id).map(|e| e.from_child.clone())
  };
  match rx {
    Some(rx) => chan_msg_or_closed(rx.lock().await.recv().await),
    None => Vec::new(),
  }
}

#[op2(fast)]
pub fn op_worker_terminate(id: u32) {
  // Dropping the entry closes both channels: the worker's host loop sees
  // `None` and exits; pending parent-side receives resolve to null.
  workers().lock().unwrap().remove(&id);
}

// ---------------------------------------------------------------------------
// Workers (child side)
// ---------------------------------------------------------------------------

#[op2(fast)]
pub fn op_in_worker(state: &mut OpState) -> bool {
  state.has::<WorkerHost>()
}

#[op2(fast)]
pub fn op_host_send(state: &mut OpState, #[buffer] msg: &[u8]) -> bool {
  match state.try_borrow::<WorkerHost>() {
    Some(host) => host.to_parent.send(msg.to_vec()).is_ok(),
    None => false,
  }
}

#[op2]
#[buffer]
pub async fn op_host_recv(state: Rc<RefCell<OpState>>) -> Vec<u8> {
  let rx = {
    let state = state.borrow();
    state.try_borrow::<WorkerHost>().map(|h| h.from_parent.clone())
  };
  match rx {
    Some(rx) => chan_msg_or_closed(rx.lock().await.recv().await),
    None => Vec::new(),
  }
}

// ---------------------------------------------------------------------------
// Text encoding (backing TextEncoder/TextDecoder and Buffer string I/O).
// UTF-8 encode/decode in Rust is ~10-50x faster than the pure-JS fallback.
// ---------------------------------------------------------------------------

#[op2]
#[buffer]
pub fn op_text_encode(#[string] string: String) -> Vec<u8> {
  string.into_bytes()
}

/// UTF-8 decode with replacement characters (TextDecoder/Buffer.toString
/// semantics). Builds the V8 string in-place instead of marshaling a Rust
/// String across the op boundary: SIMD ASCII scan (~1ns/64B) then a direct
/// one-byte string create for the dominant ASCII case — the same fast path
/// deno_web's op_encoding_decode_utf8 uses.
#[op2]
pub fn op_text_decode<'a>(
  scope: &mut v8::PinScope<'a, '_>,
  #[anybuffer] bytes: &[u8],
) -> Result<v8::Local<'a, v8::String>, JsErrorBox> {
  if v8::simdutf::validate_ascii(bytes) {
    return v8::String::new_from_one_byte(scope, bytes, v8::NewStringType::Normal)
      .ok_or_else(|| JsErrorBox::range_error("string too long"));
  }
  // v8 replaces invalid sequences with U+FFFD (lossy decode).
  v8::String::new_from_utf8(scope, bytes, v8::NewStringType::Normal)
    .ok_or_else(|| JsErrorBox::range_error("string too long"))
}

// ---------------------------------------------------------------------------
// crypto (node:crypto backing)
// ---------------------------------------------------------------------------

enum Hasher {
  Sha256(sha2::Sha256),
  Sha512(sha2::Sha512),
  Sha1(sha1::Sha1),
  Md5(md5::Context),
}

impl Hasher {
  fn new(algo: &str) -> Result<Self, JsErrorBox> {
    use sha2::Digest;
    Ok(match algo.to_ascii_lowercase().as_str() {
      "sha256" => Self::Sha256(sha2::Sha256::new()),
      "sha512" => Self::Sha512(sha2::Sha512::new()),
      "sha1" => Self::Sha1(sha1::Sha1::new()),
      "md5" => Self::Md5(md5::Context::new()),
      _ => {
        return Err(JsErrorBox::generic(format!(
          "unsupported hash algorithm '{algo}' (supported: sha256, sha512, sha1, md5)"
        )));
      }
    })
  }

  fn update(&mut self, data: &[u8]) {
    use sha2::Digest;
    match self {
      Self::Sha256(h) => h.update(data),
      Self::Sha512(h) => h.update(data),
      Self::Sha1(h) => h.update(data),
      Self::Md5(h) => h.consume(data),
    }
  }

  fn finalize(self) -> Vec<u8> {
    use sha2::Digest;
    match self {
      Self::Sha256(h) => h.finalize().to_vec(),
      Self::Sha512(h) => h.finalize().to_vec(),
      Self::Sha1(h) => h.finalize().to_vec(),
      Self::Md5(h) => h.compute().to_vec(),
    }
  }
}

#[derive(Default)]
struct HashTable {
  next_id: u32,
  hashes: HashMap<u32, Hasher>,
}

fn hash_table(state: &mut OpState) -> &mut HashTable {
  if !state.has::<HashTable>() {
    state.put(HashTable::default());
  }
  state.borrow_mut::<HashTable>()
}

#[op2(fast)]
pub fn op_crypto_hash_new(state: &mut OpState, #[string] algo: String) -> Result<u32, JsErrorBox> {
  let hasher = Hasher::new(&algo)?;
  let table = hash_table(state);
  let id = table.next_id;
  table.next_id += 1;
  table.hashes.insert(id, hasher);
  Ok(id)
}

#[op2(fast)]
pub fn op_crypto_hash_update(
  state: &mut OpState,
  id: u32,
  #[buffer] data: &[u8],
) -> Result<(), JsErrorBox> {
  let table = hash_table(state);
  match table.hashes.get_mut(&id) {
    Some(hasher) => {
      hasher.update(data);
      Ok(())
    }
    None => Err(JsErrorBox::generic("hash already digested or unknown")),
  }
}

#[op2]
#[buffer]
pub fn op_crypto_hash_digest(state: &mut OpState, id: u32) -> Result<Vec<u8>, JsErrorBox> {
  let table = hash_table(state);
  match table.hashes.remove(&id) {
    Some(hasher) => Ok(hasher.finalize()),
    None => Err(JsErrorBox::generic("hash already digested or unknown")),
  }
}

#[op2]
#[buffer]
pub fn op_crypto_random_bytes(len: u32) -> Result<Vec<u8>, JsErrorBox> {
  let mut buf = vec![0u8; len as usize];
  getrandom::fill(&mut buf).map_err(|e| JsErrorBox::generic(format!("randomBytes: {e}")))?;
  Ok(buf)
}

/// Constant-time equality; returns false on length mismatch (the JS shim
/// enforces equal lengths like Node does).
#[op2(fast)]
pub fn op_crypto_timing_safe_equal(#[buffer] a: &[u8], #[buffer] b: &[u8]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  let mut diff = 0u8;
  for (x, y) in a.iter().zip(b.iter()) {
    diff |= x ^ y;
  }
  diff == 0
}

// ---------------------------------------------------------------------------
// URL parsing (backing the URL global) via the `url` crate.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct UrlParts {
  href: String,
  protocol: String,
  username: String,
  password: String,
  host: String,
  hostname: String,
  port: String,
  pathname: String,
  search: String,
  hash: String,
  origin: String,
}

fn url_to_parts(u: &url::Url) -> UrlParts {
  UrlParts {
    href: u.to_string(),
    protocol: format!("{}:", u.scheme()),
    username: u.username().to_string(),
    password: u.password().unwrap_or("").to_string(),
    host: u.host_str().map_or_else(String::new, |h| match u.port() {
      Some(port) => format!("{h}:{port}"),
      None => h.to_string(),
    }),
    hostname: u.host_str().unwrap_or("").to_string(),
    port: u.port().map_or_else(String::new, |p| p.to_string()),
    pathname: u.path().to_string(),
    search: u.query().map_or_else(String::new, |q| format!("?{q}")),
    hash: u.fragment().map_or_else(String::new, |f| format!("#{f}")),
    origin: u.origin().ascii_serialization(),
  }
}

#[op2]
#[serde]
pub fn op_url_parse(
  #[string] href: String,
  #[string] base: Option<String>,
) -> Result<UrlParts, JsErrorBox> {
  let parsed = match base {
    Some(base) if !base.is_empty() => {
      let base_url = url::Url::parse(&base)
        .map_err(|e| JsErrorBox::type_error(format!("Invalid base URL: {e}")))?;
      base_url
        .join(&href)
        .map_err(|e| JsErrorBox::type_error(format!("Invalid URL: {e}")))?
    }
    _ => url::Url::parse(&href).map_err(|e| JsErrorBox::type_error(format!("Invalid URL: {e}")))?,
  };
  Ok(url_to_parts(&parsed))
}

#[op2]
#[string]
pub fn op_url_set_part(
  #[string] href: String,
  #[string] part: String,
  #[string] value: String,
) -> Result<String, JsErrorBox> {
  let invalid = || JsErrorBox::type_error(format!("Invalid URL {part} '{value}'"));
  let mut u =
    url::Url::parse(&href).map_err(|e| JsErrorBox::type_error(format!("Invalid URL: {e}")))?;
  match part.as_str() {
    "protocol" => u.set_scheme(value.trim_end_matches(':')).map_err(|_| invalid())?,
    "username" => u.set_username(&value).map_err(|_| invalid())?,
    "password" => u
      .set_password(if value.is_empty() { None } else { Some(&value) })
      .map_err(|_| invalid())?,
    "host" => {
      // Node semantics: host sets hostname and (optionally) port together.
      let (host, port) = match value.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (value.as_str(), None),
      };
      u.set_host(Some(host)).map_err(|_| invalid())?;
      match port {
        Some(p) if !p.is_empty() => u
          .set_port(Some(p.parse::<u16>().map_err(|_| invalid())?))
          .map_err(|_| invalid())?,
        Some(_) => {
          u.set_port(None).map_err(|_| invalid())?;
        }
        None => {}
      }
    }
    "hostname" => u.set_host(Some(&value)).map_err(|_| invalid())?,
    "port" => {
      if value.is_empty() {
        u.set_port(None).map_err(|_| invalid())?;
      } else {
        u.set_port(Some(value.parse::<u16>().map_err(|_| invalid())?))
          .map_err(|_| invalid())?;
      }
    }
    "pathname" => u.set_path(value.trim_start_matches('/')),
    "search" => u.set_query(if value.is_empty() {
      None
    } else {
      Some(value.trim_start_matches('?'))
    }),
    "hash" => u.set_fragment(if value.is_empty() {
      None
    } else {
      Some(value.trim_start_matches('#'))
    }),
    _ => return Err(JsErrorBox::type_error(format!("unknown URL part '{part}'"))),
  }
  Ok(u.to_string())
}

// ---------------------------------------------------------------------------
// fetch (backing the fetch() global) over reqwest + rustls.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct FetchHead {
  id: u32,
  status: u16,
  status_text: String,
  headers: Vec<(String, String)>,
  url: String,
}

#[derive(Default)]
struct FetchTable {
  next_id: u32,
  responses: HashMap<u32, reqwest::Response>,
}

fn fetch_table(state: &mut OpState) -> &mut FetchTable {
  if !state.has::<FetchTable>() {
    state.put(FetchTable::default());
  }
  state.borrow_mut::<FetchTable>()
}

fn get_http_client(redirect: &str) -> &'static reqwest::Client {
  static FOLLOW_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
  static MANUAL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
  static ERROR_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

  match redirect {
    "manual" => MANUAL_CLIENT.get_or_init(|| {
      reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("manual reqwest client")
    }),
    "error" => ERROR_CLIENT.get_or_init(|| {
      reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
          attempt.error("redirect forbidden")
        }))
        .build()
        .expect("error reqwest client")
    }),
    _ => FOLLOW_CLIENT.get_or_init(|| {
      reqwest::Client::builder()
        // Like Policy::limited(20), but each hop must pass --allow-net too,
        // or an allowed host could redirect to a denied one.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
          if attempt.previous().len() >= 20 {
            attempt.error("too many redirects")
          } else if let Err(e) = crate::permissions::check_net(&url_host_for_perm(attempt.url().as_str())) {
            attempt.error(e)
          } else {
            attempt.follow()
          }
        }))
        .build()
        .expect("follow reqwest client")
    }),
  }
}

/// "host" or "host:port" for permission checks against a URL string.
fn url_host_for_perm(url_str: &str) -> String {
  url::Url::parse(url_str)
    .ok()
    .map(|u| match u.port() {
      Some(port) => format!("{}:{port}", u.host_str().unwrap_or_default()),
      None => u.host_str().unwrap_or_default().to_string(),
    })
    .unwrap_or_else(|| url_str.to_string())
}

/// Send the request and return the head; the body streams via op_fetch_read.
#[op2]
#[serde]
pub async fn op_fetch_start(
  state: Rc<RefCell<OpState>>,
  #[string] url: String,
  #[string] method: String,
  #[serde] headers: Vec<(String, String)>,
  #[serde] body: Option<serde_bytes::ByteBuf>,
  #[string] redirect: String,
) -> Result<FetchHead, JsErrorBox> {
  crate::permissions::check_net(&url_host_for_perm(&url))?;
  let method = reqwest::Method::from_bytes(method.as_bytes())
    .map_err(|e| JsErrorBox::type_error(format!("invalid HTTP method '{method}': {e}")))?;
  let client = get_http_client(&redirect);
  let mut request = client.request(method, &url);
  for (name, value) in headers {
    request = request.header(name, value);
  }
  if let Some(body) = body {
    request = request.body(body.into_vec());
  }
  let response = request
    .send()
    .await
    .map_err(|e| JsErrorBox::generic(format!("fetch {url}: {e}")))?;
  let status = response.status();
  let headers = response
    .headers()
    .iter()
    .map(|(name, value)| {
      (
        name.as_str().to_string(),
        value.to_str().unwrap_or("").to_string(),
      )
    })
    .collect();
  let url = response.url().to_string();
  let head = FetchHead {
    id: 0,
    status: status.as_u16(),
    status_text: status.canonical_reason().unwrap_or("").to_string(),
    headers,
    url,
  };
  let id = {
    let mut state = state.borrow_mut();
    let table = fetch_table(&mut state);
    let id = table.next_id;
    table.next_id += 1;
    table.responses.insert(id, response);
    id
  };
  Ok(FetchHead { id, ..head })
}

/// Read the next body chunk; empty buffer = end of body.
#[op2]
#[buffer]
pub async fn op_fetch_read(state: Rc<RefCell<OpState>>, id: u32) -> Result<Vec<u8>, JsErrorBox> {
  // Take the response out so the OpState RefCell is not held across the
  // await; it is put back afterwards. Concurrent reads on one id are
  // serialized by the JS side.
  let taken = {
    let mut state = state.borrow_mut();
    fetch_table(&mut state).responses.remove(&id)
  };
  let Some(mut response) = taken else {
    return Ok(Vec::new());
  };
  let chunk = response
    .chunk()
    .await
    .map_err(|e| JsErrorBox::generic(format!("fetch: reading body: {e}")))?;
  {
    let mut state = state.borrow_mut();
    fetch_table(&mut state).responses.insert(id, response);
  }
  Ok(chunk.map(|c| c.to_vec()).unwrap_or_default())
}

/// Abandon a streaming body without draining it.
#[op2(fast)]
pub fn op_fetch_close(state: &mut OpState, id: u32) {
  let table = fetch_table(state);
  table.responses.remove(&id);
}

// ---------------------------------------------------------------------------
// HTTP server (jse.serve / node:http backing)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ServeTable {
  next_id: u32,
  listeners: HashMap<u32, crate::serve::Listener>,
  /// req_id -> chunk sink for in-progress streaming responses.
  streams: HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>,
}

fn serve_table(state: &mut OpState) -> &mut ServeTable {
  if !state.has::<ServeTable>() {
    state.put(ServeTable::default());
  }
  state.borrow_mut::<ServeTable>()
}

/// Bind a listener and spawn its accept loop. Synchronous (std bind +
/// nonblocking handoff to tokio) so `jse.serve()` is a sync call. Returns
/// (listener_id, bound_port).
#[derive(serde::Deserialize)]
struct TlsOptions {
  cert: String,
  key: String,
}

pub fn bind_reuse_tcp(hostname: &str, port: u16) -> std::io::Result<std::net::TcpListener> {
  use socket2::{Domain, Protocol, Socket, Type};
  use std::net::ToSocketAddrs;

  let addrs = (hostname, port).to_socket_addrs()?;
  let mut last_err = None;
  for addr in addrs {
    let domain = Domain::for_address(addr);
    match Socket::new(domain, Type::STREAM, Some(Protocol::TCP)) {
      Ok(socket) => {
        let _ = socket.set_reuse_address(true);
        #[cfg(all(unix, not(target_os = "solaris")))]
        let _ = socket.set_reuse_port(true);
        let _ = socket.set_nonblocking(true);
        if let Err(e) = socket.bind(&addr.into()) {
          last_err = Some(e);
          continue;
        }
        if let Err(e) = socket.listen(1024) {
          last_err = Some(e);
          continue;
        }
        return Ok(socket.into());
      }
      Err(e) => {
        last_err = Some(e);
      }
    }
  }
  Err(last_err.unwrap_or_else(|| {
    std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "no addresses found")
  }))
}

#[op2]
#[serde]
pub fn op_serve_listen(
  state: &mut OpState,
  #[string] hostname: String,
  port: u32,
  #[serde] tls: Option<TlsOptions>,
) -> Result<(u32, u32), JsErrorBox> {
  crate::permissions::check_net(&format!("{hostname}:{port}"))?;
  let tls_config = tls
    .map(|opts| crate::serve::tls_config(&opts.cert, &opts.key))
    .transpose()
    .map_err(JsErrorBox::generic)?;
  let std_listener = bind_reuse_tcp(hostname.as_str(), port as u16)
    .map_err(|e| JsErrorBox::generic(format!("listen {hostname}:{port}: {e}")))?;
  let bound_port = std_listener
    .local_addr()
    .map(|a| a.port() as u32)
    .unwrap_or(port);
  let table = serve_table(state);
  let id = table.next_id;
  table.next_id += 1;
  table
    .listeners
    .insert(id, crate::serve::start_listener(std_listener, tls_config));
  Ok((id, bound_port))
}

/// Pull up to `max` pending requests as one packed binary blob (empty blob
/// = listener closed). Awaits at least one request, then drains whatever
/// else is queued without blocking: one op round-trip per batch.
#[op2]
#[buffer]
pub async fn op_serve_pull(
  state: Rc<RefCell<OpState>>,
  listener_id: u32,
  max: u32,
) -> Result<Vec<u8>, JsErrorBox> {
  let rx = {
    let state = state.borrow();
    state
      .try_borrow::<ServeTable>()
      .and_then(|table| table.listeners.get(&listener_id).map(|l| l.req_rx.clone()))
  };
  let Some(rx) = rx else {
    return Ok(Vec::new());
  };
  let requests = {
    let mut guard = rx.lock().await;
    let Some(first) = guard.recv().await else {
      return Ok(Vec::new());
    };
    let mut requests = vec![first];
    while requests.len() < max as usize {
      match guard.try_recv() {
        Ok(req) => requests.push(req),
        Err(_) => break,
      }
    }
    requests
  };
  Ok(crate::serve::pack_requests(&requests))
}

fn take_pending(
  table: &ServeTable,
  listener_id: u32,
  req_id: u32,
) -> Result<tokio::sync::oneshot::Sender<crate::serve::ServeResponse>, JsErrorBox> {
  table
    .listeners
    .get(&listener_id)
    .and_then(|l| l.pending.lock().unwrap().remove(&req_id))
    .ok_or_else(|| JsErrorBox::generic(format!("no pending request {req_id}")))
}

/// Respond to a request with a complete body.
#[op2(fast)]
pub fn op_serve_respond(
  state: &mut OpState,
  listener_id: u32,
  req_id: u32,
  status: u32,
  #[string] headers: String,
  #[buffer(copy)] body: Vec<u8>,
) -> Result<(), JsErrorBox> {
  let table = serve_table(state);
  let tx = take_pending(table, listener_id, req_id)?;
  let _ = tx.send(crate::serve::ServeResponse {
    status: status as u16,
    headers: crate::serve::split_headers(&headers),
    body: crate::serve::ServeBody::Full(body),
  });
  Ok(())
}

/// Start a streaming (chunked) response; subsequent chunks go through
/// op_serve_respond_chunk and the body ends with op_serve_respond_end.
#[op2(fast)]
pub fn op_serve_respond_start(
  state: &mut OpState,
  listener_id: u32,
  req_id: u32,
  status: u32,
  #[string] headers: String,
) -> Result<(), JsErrorBox> {
  let (chunk_tx, chunk_rx) = mpsc::unbounded_channel::<Vec<u8>>();
  let table = serve_table(state);
  let tx = take_pending(table, listener_id, req_id)?;
  table.streams.insert(req_id, chunk_tx);
  let _ = tx.send(crate::serve::ServeResponse {
    status: status as u16,
    headers: crate::serve::split_headers(&headers),
    body: crate::serve::ServeBody::Stream(chunk_rx),
  });
  Ok(())
}

#[op2(fast)]
pub fn op_serve_respond_chunk(
  state: &mut OpState,
  req_id: u32,
  #[buffer] chunk: &[u8],
) -> Result<(), JsErrorBox> {
  let table = serve_table(state);
  match table.streams.get(&req_id) {
    Some(tx) => {
      let _ = tx.send(chunk.to_vec());
      Ok(())
    }
    None => Err(JsErrorBox::generic(format!("no open stream for request {req_id}"))),
  }
}

#[op2(fast)]
pub fn op_serve_respond_end(state: &mut OpState, req_id: u32) {
  let table = serve_table(state);
  // Dropping the sender ends the body stream.
  table.streams.remove(&req_id);
}

/// Close a listener: stop accepting, fail pending requests.
#[op2(fast)]
pub fn op_serve_close(state: &mut OpState, listener_id: u32) {
  let table = serve_table(state);
  if let Some(listener) = table.listeners.remove(&listener_id) {
    listener.accept_task.abort();
    for task in listener.conn_tasks.lock().unwrap().drain(..) {
      task.abort();
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket (client & server)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct WsEvent {
  pub kind: u32, // 1 = text, 2 = binary, 3 = close, 4 = error
  #[serde(with = "serde_bytes")]
  pub data: Vec<u8>,
  pub code: u16,
  pub reason: String,
}

pub struct WsEntry {
  pub tx: mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
  pub rx: Arc<TokioMutex<mpsc::UnboundedReceiver<WsEvent>>>,
  pub abort_handle: tokio::task::AbortHandle,
}

impl Drop for WsEntry {
  fn drop(&mut self) {
    self.abort_handle.abort();
  }
}

#[derive(Default)]
struct WsTable {
  next_id: u32,
  sockets: HashMap<u32, WsEntry>,
}

fn ws_table(state: &mut OpState) -> &mut WsTable {
  if !state.has::<WsTable>() {
    state.put(WsTable::default());
  }
  state.borrow_mut::<WsTable>()
}

fn spawn_ws_pump<S>(
  ws_stream: tokio_tungstenite::WebSocketStream<S>,
) -> (
  mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
  Arc<TokioMutex<mpsc::UnboundedReceiver<WsEvent>>>,
  tokio::task::AbortHandle,
)
where
  S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
  use futures_util::{SinkExt, StreamExt};
  let (out_tx, mut out_rx) =
    mpsc::unbounded_channel::<tokio_tungstenite::tungstenite::Message>();
  let (in_tx, in_rx) = mpsc::unbounded_channel::<WsEvent>();
  let task = tokio::spawn(async move {
    let (mut sink, mut stream) = ws_stream.split();
    loop {
      tokio::select! {
        biased;
        msg = out_rx.recv() => {
          match msg {
            Some(msg) => {
              let is_close = matches!(msg, tokio_tungstenite::tungstenite::Message::Close(_));
              if sink.send(msg).await.is_err() {
                break;
              }
              if is_close {
                let _ = sink.flush().await;
              }
            }
            None => {
              let _ = sink.close().await;
              break;
            }
          }
        }
        incoming = stream.next() => {
          match incoming {
            Some(Ok(msg)) => {
              match msg {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                  let _ = in_tx.send(WsEvent {
                    kind: 1,
                    data: text.as_bytes().to_vec(),
                    code: 0,
                    reason: String::new(),
                  });
                }
                tokio_tungstenite::tungstenite::Message::Binary(bin) => {
                  let _ = in_tx.send(WsEvent {
                    kind: 2,
                    data: bin.to_vec(),
                    code: 0,
                    reason: String::new(),
                  });
                }
                tokio_tungstenite::tungstenite::Message::Close(frame) => {
                  let (code, reason) = match frame {
                    Some(ref f) => (u16::from(f.code), f.reason.to_string()),
                    None => (1005, String::new()),
                  };
                  let _ = in_tx.send(WsEvent {
                    kind: 3,
                    data: Vec::new(),
                    code,
                    reason,
                  });
                  let _ = sink.send(tokio_tungstenite::tungstenite::Message::Close(frame)).await;
                  let _ = sink.flush().await;
                  break;
                }
                tokio_tungstenite::tungstenite::Message::Ping(payload) => {
                  let _ = sink.send(tokio_tungstenite::tungstenite::Message::Pong(payload)).await;
                }
                tokio_tungstenite::tungstenite::Message::Pong(_) => {}
                tokio_tungstenite::tungstenite::Message::Frame(_) => {}
              }
            }
            Some(Err(err)) => {
              let _ = in_tx.send(WsEvent {
                kind: 4,
                data: Vec::new(),
                code: 0,
                reason: err.to_string(),
              });
              break;
            }
            None => {
              let _ = in_tx.send(WsEvent {
                kind: 3,
                data: Vec::new(),
                code: 1006,
                reason: "connection closed".to_string(),
              });
              break;
            }
          }
        }
      }
    }
  });
  (out_tx, Arc::new(TokioMutex::new(in_rx)), task.abort_handle())
}

#[op2]
pub async fn op_ws_connect(
  state: Rc<RefCell<OpState>>,
  #[string] url: String,
) -> Result<u32, JsErrorBox> {
  crate::permissions::check_net(&url_host_for_perm(&url))?;
  let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
    .await
    .map_err(|e| JsErrorBox::generic(format!("WebSocket connect failed: {e}")))?;
  let (tx, rx, abort_handle) = spawn_ws_pump(ws_stream);
  let mut state = state.borrow_mut();
  let table = ws_table(&mut state);
  let id = table.next_id;
  table.next_id += 1;
  table.sockets.insert(id, WsEntry { tx, rx, abort_handle });
  Ok(id)
}

#[op2]
pub async fn op_ws_upgrade(
  state: Rc<RefCell<OpState>>,
  listener_id: u32,
  req_id: u32,
) -> Result<u32, JsErrorBox> {
  let (on_upgrade, key, resp_tx) = {
    let mut state = state.borrow_mut();
    let table = serve_table(&mut state);
    let listener = table
      .listeners
      .get(&listener_id)
      .ok_or_else(|| JsErrorBox::generic(format!("no listener {listener_id}")))?;
    let (on_upgrade, key) = listener
      .upgrades
      .lock()
      .unwrap()
      .remove(&req_id)
      .ok_or_else(|| JsErrorBox::generic(format!("request {req_id} is not a websocket upgrade")))?;
    let resp_tx = listener
      .pending
      .lock()
      .unwrap()
      .remove(&req_id)
      .ok_or_else(|| JsErrorBox::generic(format!("no pending request {req_id}")))?;
    (on_upgrade, key, resp_tx)
  };

  let accept_key =
    tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
  let response = crate::serve::ServeResponse {
    status: 101,
    headers: vec![
      ("Upgrade".to_string(), "websocket".to_string()),
      ("Connection".to_string(), "Upgrade".to_string()),
      ("Sec-WebSocket-Accept".to_string(), accept_key),
    ],
    body: crate::serve::ServeBody::Full(Vec::new()),
  };
  resp_tx
    .send(response)
    .map_err(|_| JsErrorBox::generic("failed to send 101 response"))?;

  let upgraded = on_upgrade
    .await
    .map_err(|e| JsErrorBox::generic(format!("websocket upgrade failed: {e}")))?;
  let io = hyper_util::rt::TokioIo::new(upgraded);
  let ws_stream = tokio_tungstenite::WebSocketStream::from_raw_socket(
    io,
    tokio_tungstenite::tungstenite::protocol::Role::Server,
    None,
  )
  .await;

  let (tx, rx, abort_handle) = spawn_ws_pump(ws_stream);
  let mut state = state.borrow_mut();
  let table = ws_table(&mut state);
  let id = table.next_id;
  table.next_id += 1;
  table.sockets.insert(id, WsEntry { tx, rx, abort_handle });
  Ok(id)
}

#[op2(fast)]
pub fn op_ws_send(
  state: &mut OpState,
  ws_id: u32,
  #[buffer] data: &[u8],
  is_text: bool,
) -> Result<(), JsErrorBox> {
  let table = ws_table(state);
  let entry = table
    .sockets
    .get(&ws_id)
    .ok_or_else(|| JsErrorBox::generic(format!("invalid websocket id {ws_id}")))?;
  let msg = if is_text {
    let text = std::str::from_utf8(data)
      .map_err(|e| JsErrorBox::generic(format!("invalid utf8: {e}")))?;
    tokio_tungstenite::tungstenite::Message::text(text)
  } else {
    tokio_tungstenite::tungstenite::Message::binary(data.to_vec())
  };
  entry
    .tx
    .send(msg)
    .map_err(|_| JsErrorBox::generic("websocket send failed: socket closed"))?;
  Ok(())
}

#[op2]
#[serde]
pub async fn op_ws_poll(
  state: Rc<RefCell<OpState>>,
  ws_id: u32,
) -> Result<Option<WsEvent>, JsErrorBox> {
  let rx = {
    let mut state = state.borrow_mut();
    let table = ws_table(&mut state);
    table.sockets.get(&ws_id).map(|e| e.rx.clone())
  };
  let Some(rx) = rx else {
    return Ok(None);
  };
  let mut guard = rx.lock().await;
  let event = guard.recv().await;
  if event.is_none() {
    let mut state = state.borrow_mut();
    let table = ws_table(&mut state);
    table.sockets.remove(&ws_id);
  }
  Ok(event)
}

#[op2(fast)]
pub fn op_ws_close(
  state: &mut OpState,
  ws_id: u32,
  code: u32,
  #[string] reason: String,
) -> Result<(), JsErrorBox> {
  let table = ws_table(state);
  if let Some(entry) = table.sockets.get(&ws_id) {
    let frame = if code > 0 {
      Some(tokio_tungstenite::tungstenite::protocol::frame::CloseFrame {
        code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(
          code as u16,
        ),
        reason: reason.into(),
      })
    } else {
      None
    };
    let _ = entry
      .tx
      .send(tokio_tungstenite::tungstenite::Message::Close(frame));
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// child_process (node:child_process backing)
// ---------------------------------------------------------------------------

fn default_pipe() -> String {
  "pipe".to_string()
}

#[derive(serde::Deserialize)]
struct SpawnSpec {
  cmd: String,
  args: Vec<String>,
  cwd: Option<String>,
  /// Full environment (env_clear + these pairs); None = inherit.
  env: Option<Vec<(String, String)>>,
  #[serde(default = "default_pipe")]
  stdin: String,
  #[serde(default = "default_pipe")]
  stdout: String,
  #[serde(default = "default_pipe")]
  stderr: String,
}

#[derive(serde::Serialize)]
struct ChildResult {
  code: Option<i32>,
  stdout: serde_bytes::ByteBuf,
  stderr: serde_bytes::ByteBuf,
}

struct ChildProc {
  pid: i32,
  stdout_rx: Option<SharedRx>,
  stderr_rx: Option<SharedRx>,
  stdin: Option<tokio::process::ChildStdin>,
  exit_handle: Option<tokio::task::JoinHandle<Option<i32>>>,
}

#[derive(Default)]
struct ChildTable {
  next_id: u32,
  children: HashMap<u32, ChildProc>,
}

fn child_table(state: &mut OpState) -> &mut ChildTable {
  if !state.has::<ChildTable>() {
    state.put(ChildTable::default());
  }
  state.borrow_mut::<ChildTable>()
}

/// Permission-check the spawn and return the program to execute: the path
/// `check_run` resolved (under an allowlist) or the command as given.
fn checked_program(spec: &SpawnSpec) -> Result<std::ffi::OsString, JsErrorBox> {
  let child_path = spec
    .env
    .as_ref()
    .and_then(|env| env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone()))
    .or_else(|| std::env::var("PATH").ok());
  let resolved = crate::permissions::check_run(&spec.cmd, spec.cwd.as_deref(), child_path.as_deref())?;
  Ok(resolved.map_or_else(|| spec.cmd.clone().into(), std::path::PathBuf::into_os_string))
}

fn apply_spec(cmd: &mut tokio::process::Command, spec: &SpawnSpec) {
  cmd.args(&spec.args);
  if let Some(cwd) = &spec.cwd {
    cmd.current_dir(cwd);
  }
  if let Some(env) = &spec.env {
    cmd.env_clear();
    for (key, value) in env {
      cmd.env(key, value);
    }
    if !env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH"))
      && let Ok(path) = std::env::var("PATH")
    {
      cmd.env("PATH", path);
    }
  }
}

fn stdio_of(mode: &str) -> std::process::Stdio {
  match mode {
    "inherit" => std::process::Stdio::inherit(),
    "ignore" => std::process::Stdio::null(),
    _ => std::process::Stdio::piped(),
  }
}

fn spawn_pipe_reader(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static) -> SharedRx {
  let (tx, rx) = mpsc::unbounded_channel();
  tokio::spawn(async move {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
      match tokio::io::AsyncReadExt::read(&mut pipe, &mut buf).await {
        Ok(0) | Err(_) => break,
        Ok(n) => {
          if tx.send(buf[..n].to_vec()).is_err() {
            break;
          }
        }
      }
    }
  });
  Arc::new(TokioMutex::new(rx))
}

#[derive(serde::Serialize)]
struct SpawnedChild {
  id: u32,
  pid: i32,
}

/// Spawn a child. stdout/stderr are streamed; returns `{ id, pid }`.
#[op2]
#[serde]
pub fn op_child_spawn(state: &mut OpState, #[serde] spec: SpawnSpec) -> Result<SpawnedChild, JsErrorBox> {
  let mut cmd = tokio::process::Command::new(checked_program(&spec)?);
  cmd
    .stdin(stdio_of(&spec.stdin))
    .stdout(stdio_of(&spec.stdout))
    .stderr(stdio_of(&spec.stderr));
  apply_spec(&mut cmd, &spec);
  let mut child = cmd
    .spawn()
    .map_err(|e| JsErrorBox::generic(format!("spawn {}: {e}", spec.cmd)))?;
  let pid = child.id().map(|p| p as i32).unwrap_or(-1);
  let stdin = if spec.stdin == "pipe" { child.stdin.take() } else { None };
  let stdout_rx = child.stdout.take().map(spawn_pipe_reader);
  let stderr_rx = child.stderr.take().map(spawn_pipe_reader);
  let exit_handle = tokio::spawn(async move {
    match child.wait().await {
      Ok(status) => status.code(),
      Err(_) => None,
    }
  });
  let table = child_table(state);
  let id = table.next_id;
  table.next_id += 1;
  table.children.insert(
    id,
    ChildProc {
      pid,
      stdout_rx,
      stderr_rx,
      stdin,
      exit_handle: Some(exit_handle),
    },
  );
  Ok(SpawnedChild { id, pid })
}

/// Pull the next stdout (`which == 0`) or stderr chunk. Empty means EOF.
#[op2]
#[buffer]
pub async fn op_child_read(state: Rc<RefCell<OpState>>, id: u32, which: u32) -> Vec<u8> {
  let rx = {
    let mut st = state.borrow_mut();
    let Some(child) = child_table(&mut st).children.get(&id) else {
      return Vec::new();
    };
    match which {
      0 => child.stdout_rx.clone(),
      1 => child.stderr_rx.clone(),
      _ => None,
    }
  };
  let Some(rx) = rx else {
    return Vec::new();
  };
  rx.lock().await.recv().await.unwrap_or_default()
}

#[derive(serde::Serialize)]
struct ChildExit {
  code: Option<i32>,
}

#[op2]
#[serde]
pub async fn op_child_exit(state: Rc<RefCell<OpState>>, id: u32) -> Result<ChildExit, JsErrorBox> {
  let handle = {
    let mut st = state.borrow_mut();
    match child_table(&mut st).children.get_mut(&id) {
      Some(child) => child.exit_handle.take(),
      None => return Err(JsErrorBox::generic(format!("no child with id {id}"))),
    }
  };
  let code = match handle {
    Some(handle) => handle.await.unwrap_or(None),
    None => None,
  };
  Ok(ChildExit { code })
}

#[op2]
pub async fn op_child_stdin_write(
  state: Rc<RefCell<OpState>>,
  id: u32,
  #[buffer(copy)] data: Vec<u8>,
) -> Result<(), JsErrorBox> {
  let stdin = {
    let mut st = state.borrow_mut();
    child_table(&mut st).children.get_mut(&id).and_then(|child| child.stdin.take())
  };
  let Some(mut stdin) = stdin else {
    return Err(JsErrorBox::generic("stdin is closed"));
  };
  let result = tokio::io::AsyncWriteExt::write_all(&mut stdin, &data).await;
  {
    let mut st = state.borrow_mut();
    if let Some(child) = child_table(&mut st).children.get_mut(&id) {
      child.stdin = Some(stdin);
    }
  }
  result.map_err(|e| JsErrorBox::generic(format!("stdin write: {e}")))
}

#[op2(fast)]
pub fn op_child_stdin_close(state: &mut OpState, id: u32) {
  if let Some(child) = child_table(state).children.get_mut(&id) {
    child.stdin.take();
  }
}

#[op2(fast)]
pub fn op_child_kill(state: &mut OpState, id: u32) -> bool {
  let Some(child) = child_table(state).children.get(&id) else {
    return false;
  };
  if child.pid <= 0 {
    return false;
  }
  nix::sys::signal::kill(
    nix::unistd::Pid::from_raw(child.pid),
    nix::sys::signal::Signal::SIGKILL,
  )
  .is_ok()
}

fn read_pipe_to_end(pipe: Option<impl std::io::Read>) -> Vec<u8> {
  let mut buf = Vec::new();
  if let Some(mut pipe) = pipe {
    let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
  }
  buf
}

/// Synchronous spawn (spawnSync/execSync backing): block the isolate thread
/// until the child exits. Pipe mode captures output; ignore/inherit do not.
#[op2]
#[serde]
pub fn op_child_spawn_sync(#[serde] spec: SpawnSpec) -> Result<ChildResult, JsErrorBox> {
  let mut cmd = std::process::Command::new(checked_program(&spec)?);
  cmd.args(&spec.args);
  if let Some(cwd) = &spec.cwd {
    cmd.current_dir(cwd);
  }
  if let Some(env) = &spec.env {
    cmd.env_clear();
    for (key, value) in env {
      cmd.env(key, value);
    }
  }
  let stdin = if spec.stdin == "inherit" {
    std::process::Stdio::inherit()
  } else {
    std::process::Stdio::null()
  };
  let mut child = cmd
    .stdin(stdin)
    .stdout(stdio_of(&spec.stdout))
    .stderr(stdio_of(&spec.stderr))
    .spawn()
    .map_err(|e| JsErrorBox::generic(format!("spawn {}: {e}", spec.cmd)))?;
  let stdout_pipe = child.stdout.take();
  let stderr_pipe = child.stderr.take();
  let stdout_thread = std::thread::spawn(move || read_pipe_to_end(stdout_pipe));
  let stderr_thread = std::thread::spawn(move || read_pipe_to_end(stderr_pipe));
  let status = child
    .wait()
    .map_err(|e| JsErrorBox::generic(format!("wait: {e}")))?;
  Ok(ChildResult {
    code: status.code(),
    stdout: serde_bytes::ByteBuf::from(stdout_thread.join().unwrap_or_default()),
    stderr: serde_bytes::ByteBuf::from(stderr_thread.join().unwrap_or_default()),
  })
}

include!("ops_extra.rs");

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

deno_core::extension!(
  jse,
  ops = [
    op_sleep_until,
    op_timer_poke,
    op_now,
    op_text_encode,
    op_text_decode,
    op_read_text_file,
    op_read_text_file_sync,
    op_read_file_bytes,
    op_read_file_bytes_sync,
    op_write_text_file,
    op_write_text_file_sync,
    op_write_file_bytes,
    op_write_file_bytes_sync,
    op_exists_sync,
    op_is_dir_sync,
    op_stat_sync,
    op_stat,
    op_env,
    op_args,
    op_cwd,
    op_exit,
    op_platform,
    op_arch,
    op_cpus,
    op_chan_new,
    op_chan_capacity,
    op_chan_send,
    op_chan_recv,
    op_chan_close,
    op_worker_spawn,
    op_worker_send,
    op_worker_recv,
    op_worker_terminate,
    op_in_worker,
    op_host_send,
    op_host_recv,
    op_crypto_hash_new,
    op_crypto_hash_update,
    op_crypto_hash_digest,
    op_crypto_random_bytes,
    op_crypto_timing_safe_equal,
    op_url_parse,
    op_url_set_part,
    op_fetch_start,
    op_fetch_read,
    op_fetch_close,
    op_serve_listen,
    op_serve_pull,
    op_serve_respond,
    op_serve_respond_start,
    op_serve_respond_chunk,
    op_serve_respond_end,
    op_serve_close,
    op_ws_connect,
    op_ws_upgrade,
    op_ws_send,
    op_ws_poll,
    op_ws_close,
    op_child_spawn,
    op_child_read,
    op_child_exit,
    op_child_stdin_write,
    op_child_stdin_close,
    op_child_kill,
    op_child_spawn_sync,
    op_readdir_sync,
    op_readdir,
    op_mkdir_sync,
    op_mkdir,
    op_remove_sync,
    op_remove,
    op_rename_sync,
    op_rename,
    op_copy_file_sync,
    op_copy_file,
    op_append_bytes_sync,
    op_append_bytes,
    op_realpath_sync,
    op_realpath,
    op_access_sync,
    op_access,
    op_chmod_sync,
    op_chmod,
    op_truncate_sync,
    op_truncate,
    op_read_range,
    op_read_range_at,
    op_symlink_sync,
    op_symlink,
    op_readlink_sync,
    op_readlink,
    op_mkdtemp_sync,
    op_mkdtemp,
    op_chdir,
    op_fs_constants,
    op_fs_open,
    op_fs_close,
    op_fs_fstat,
    op_fs_read,
    op_fs_write,
    op_fs_ftruncate,
    op_fs_fsync,
    op_lstat_sync,
    op_lstat,
    op_net_listen,
    op_net_accept,
    op_net_connect,
    op_tls_connect,
    op_net_read,
    op_net_write,
    op_net_shutdown,
    op_net_close,
    op_net_close_server,
    op_zlib_new,
    op_zlib_write,
    op_zlib_write_off,
    op_zlib_oneshot,
    op_zlib_close,
    op_hmac_new,
    op_hmac_update,
    op_hmac_digest,
    op_crypto_pbkdf2,
    op_crypto_cipher_encrypt,
    op_crypto_cipher_decrypt,
    op_crypto_keypair_ed25519,
    op_crypto_sign_ed25519,
    op_crypto_verify_ed25519,
    op_dns_lookup,
    op_dns_resolve,
    op_dns_lookup_service,
    op_os_info,
    op_meminfo,
    op_network_interfaces,
    op_isatty,
    op_pid,
    op_ppid,
    op_exec_path,
    op_exec_argv,
    op_ipc_listen,
    op_ipc_server_poll,
    op_ipc_server_send,
    op_ipc_server_close,
    op_ipc_client_connect,
    op_ipc_client_poll,
    op_ipc_client_send,
    op_ipc_client_close,
    op_log,
    op_log_http,
    op_log_get_level,
    op_log_set_level,
    op_log_get_format,
    op_log_set_format,
    op_log_is_http_enabled,
    op_log_set_http_enabled,
    crate::optimizer::op_is_wasm_mode,
    crate::optimizer::op_set_wasm_mode,
    crate::optimizer::op_optimizer_heap_stats,
    crate::optimizer::op_optimizer_compact_memory,
    crate::optimizer::op_optimizer_stats,
    crate::optimizer::op_wasm_compile_app,
    crate::optimizer::op_wasm_synthesize_fn,
    crate::kv::op_kv_get,
    crate::kv::op_kv_set,
    crate::kv::op_kv_delete,
    crate::kv::op_kv_has,
    crate::kv::op_kv_clear,
    crate::kv::op_kv_keys,
    crate::kv::op_kv_incr,
    crate::kv::op_kv_cas,
    crate::kv::op_kv_stats,
    crate::router::op_router_match,
    crate::router::op_static_file,
    crate::sql::op_sql_open,
    crate::sql::op_sql_close,
    crate::sql::op_sql_exec,
    crate::sql::op_sql_last_insert_rowid,
    crate::sql::op_sql_query,
    crate::production::op_production_metrics,
    crate::production::op_production_record_request,
    crate::production::op_production_inc_conn,
    crate::production::op_production_dec_conn,
  ],
  js = [
    dir "src/js",
    "00_util.js",
    "01_console.js",
    "02_timers.js",
    "03_process.js",
    "04_buffer.js",
    "05_channels.js",
    "06_worker.js",
    "07_misc.js",
    "08_pool.js",
    "09_url.js",
    "10_fetch.js",
    "11_serve.js",
    "12_websocket.js",
    "13_wasm_optimizer.js",
    "14_kv.js",
    "15_router.js",
    "16_sql.js",
    "17_production.js",
    "18_trace.js",
    "19_queue.js",
    "20_malia.js",
  ],

  options = {
    worker_host: Option<WorkerHost>,
  },
  state = |state, options| {
    if let Some(host) = options.worker_host {
      state.put(host);
    }
  },
);
