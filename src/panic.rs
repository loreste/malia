// Global panic hook and panic isolation for jse.
use crate::logger::{self, LogLevel};
use std::panic;

pub fn init() {
  panic::set_hook(Box::new(|info| {
    let location = info
      .location()
      .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
      .unwrap_or_else(|| "unknown location".to_string());

    let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
      (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
      s.clone()
    } else {
      "Box<dyn Any> (unknown panic payload)".to_string()
    };

    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("unnamed");

    logger::log(
      LogLevel::Error,
      "panic",
      &format!("Thread '{thread_name}' panicked at {location}: {payload}"),
    );

    // If RUST_BACKTRACE is set, log the backtrace as well
    if std::env::var("RUST_BACKTRACE").map(|v| v != "0").unwrap_or(false) {
      let backtrace = std::backtrace::Backtrace::capture();
      eprintln!("{backtrace}");
    }
  }));
}

/// Safely execute an operation with panic isolation.
pub fn catch_unwind_safe<F, R>(f: F) -> Result<R, String>
where
  F: FnOnce() -> R + panic::UnwindSafe,
{
  panic::catch_unwind(f).map_err(|payload| {
    if let Some(s) = payload.downcast_ref::<&str>() {
      (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
      s.clone()
    } else {
      "Box<dyn Any> (unknown panic payload)".to_string()
    }
  })
}
