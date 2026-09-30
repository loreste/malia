// Centralized structured logging for jse runtime, HTTP server, and JS applications.
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  None = 4,
}

impl LogLevel {
  pub fn from_u8(v: u8) -> Self {
    match v {
      0 => LogLevel::Debug,
      1 => LogLevel::Info,
      2 => LogLevel::Warn,
      3 => LogLevel::Error,
      _ => LogLevel::None,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      LogLevel::Debug => "DEBUG",
      LogLevel::Info => "INFO",
      LogLevel::Warn => "WARN",
      LogLevel::Error => "ERROR",
      LogLevel::None => "NONE",
    }
  }
}

#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum LogFormat {
  Text = 0,
  Json = 1,
}

impl LogFormat {
  pub fn from_u8(v: u8) -> Self {
    match v {
      1 => LogFormat::Json,
      _ => LogFormat::Text,
    }
  }
}

static CURRENT_LEVEL: AtomicU8 = AtomicU8::new(LogLevel::Info as u8);
static CURRENT_FORMAT: AtomicU8 = AtomicU8::new(LogFormat::Text as u8);
static HTTP_LOG_ENABLED: AtomicU8 = AtomicU8::new(0); // 0 = uninit, 1 = true, 2 = false
static INIT_ONCE: OnceLock<()> = OnceLock::new();

pub fn init() {
  INIT_ONCE.get_or_init(|| {
    // 1. Log Level from JSE_LOG
    if let Ok(val) = std::env::var("JSE_LOG") {
      let lvl = match val.to_ascii_lowercase().as_str() {
        "debug" | "trace" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" | "warning" => LogLevel::Warn,
        "error" => LogLevel::Error,
        "none" | "off" | "silent" => LogLevel::None,
        _ => LogLevel::Info,
      };
      CURRENT_LEVEL.store(lvl as u8, Ordering::Relaxed);
    }

    // 2. Log Format from JSE_LOG_FORMAT
    if let Ok(fmt) = std::env::var("JSE_LOG_FORMAT")
      && fmt.eq_ignore_ascii_case("json")
    {
      CURRENT_FORMAT.store(LogFormat::Json as u8, Ordering::Relaxed);
    }

    // 3. HTTP Log from JSE_HTTP_LOG
    if let Ok(http) = std::env::var("JSE_HTTP_LOG") {
      let enabled = matches!(
        http.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on" | "full" | "combined"
      );
      HTTP_LOG_ENABLED.store(if enabled { 1 } else { 2 }, Ordering::Relaxed);
    }
  });
}

pub fn get_level() -> LogLevel {
  init();
  LogLevel::from_u8(CURRENT_LEVEL.load(Ordering::Relaxed))
}

pub fn set_level(level: LogLevel) {
  init();
  CURRENT_LEVEL.store(level as u8, Ordering::Relaxed);
}

pub fn get_format() -> LogFormat {
  init();
  LogFormat::from_u8(CURRENT_FORMAT.load(Ordering::Relaxed))
}

pub fn set_format(format: LogFormat) {
  init();
  CURRENT_FORMAT.store(format as u8, Ordering::Relaxed);
}

pub fn is_http_log_enabled() -> bool {
  init();
  let val = HTTP_LOG_ENABLED.load(Ordering::Relaxed);
  if val == 1 {
    return true;
  }
  if val == 2 {
    return false;
  }
  // If not explicitly set via JSE_HTTP_LOG, enable automatically if JSE_LOG=debug
  get_level() <= LogLevel::Debug
}

pub fn set_http_log_enabled(enabled: bool) {
  init();
  HTTP_LOG_ENABLED.store(if enabled { 1 } else { 2 }, Ordering::Relaxed);
}

/// Howard Hinnant's algorithm for converting days since UNIX epoch to Gregorian (Y, M, D).
fn days_to_ymd(days: u64) -> (u32, u32, u32) {
  let z = days + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = if m <= 2 { y + 1 } else { y };
  (y as u32, m as u32, d as u32)
}

fn format_iso_timestamp(now: SystemTime) -> String {
  let dur = now.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
  let secs = dur.as_secs();
  let millis = dur.subsec_millis();
  let s = secs % 60;
  let m = (secs / 60) % 60;
  let h = (secs / 3600) % 24;
  let days = secs / 86400;
  let (year, month, day) = days_to_ymd(days);
  format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn escape_json(s: &str) -> String {
  let mut out = String::with_capacity(s.len() + 16);
  for c in s.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      '\x08' => out.push_str("\\b"),
      '\x0C' => out.push_str("\\f"),
      c if c.is_control() => {
        out.push_str(&format!("\\u{:04x}", c as u32));
      }
      c => out.push(c),
    }
  }
  out
}

pub fn log(level: LogLevel, target: &str, message: &str) {
  if level < get_level() {
    return;
  }
  let now = SystemTime::now();
  let ts = format_iso_timestamp(now);

  match get_format() {
    LogFormat::Json => {
      let lvl_str = level.as_str();
      let esc_target = escape_json(target);
      let esc_msg = escape_json(message);
      eprintln!(
        r#"{{"time":"{ts}","level":"{lvl_str}","target":"{esc_target}","message":"{esc_msg}"}}"#
      );
    }
    LogFormat::Text => {
      let (badge, color_code) = match level {
        LogLevel::Debug => ("[DEBUG]", "\x1b[35m"), // Magenta
        LogLevel::Info => ("[INFO] ", "\x1b[32m"), // Green
        LogLevel::Warn => ("[WARN] ", "\x1b[33m"), // Yellow
        LogLevel::Error => ("[ERROR]", "\x1b[31m"), // Red
        LogLevel::None => ("[LOG]  ", "\x1b[0m"),
      };
      // Format: timestamp badge [target] message
      eprintln!(
        "{ts} {color_code}{badge}\x1b[0m \x1b[36m[{target}]\x1b[0m {message}"
      );
    }
  }
}

pub fn log_http(method: &str, url: &str, status: u16, duration_ms: f64, remote: &str, bytes: usize) {
  if !is_http_log_enabled() {
    return;
  }
  let now = SystemTime::now();
  let ts = format_iso_timestamp(now);

  match get_format() {
    LogFormat::Json => {
      let esc_method = escape_json(method);
      let esc_url = escape_json(url);
      let esc_remote = escape_json(remote);
      eprintln!(
        r#"{{"time":"{ts}","level":"INFO","target":"http","method":"{esc_method}","url":"{esc_url}","status":{status},"duration_ms":{duration_ms:.2},"remote":"{esc_remote}","bytes":{bytes}}}"#
      );
    }
    LogFormat::Text => {
      let status_color = if status >= 500 {
        "\x1b[31m" // Red
      } else if status >= 400 {
        "\x1b[33m" // Yellow
      } else if status >= 300 {
        "\x1b[36m" // Cyan
      } else {
        "\x1b[32m" // Green
      };
      eprintln!(
        "{ts} \x1b[32m[INFO] \x1b[0m \x1b[36m[http]\x1b[0m {method} {url} {status_color}{status}\x1b[0m {duration_ms:.2}ms - {remote} ({bytes}B)"
      );
    }
  }
}
