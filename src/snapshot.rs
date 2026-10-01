// V8 startup snapshot produced by build.rs. It contains the jse extension's
// bootstrap JS (console/process/Buffer/timers/channels/Worker/…) with all
// ops registered, so runtime startup only deserializes the heap instead of
// parsing and executing the bootstrap.
//
// Snapshot-safety rules for src/js bootstrap code:
// - Never read per-runtime state (argv/env/OpState) at bootstrap top level;
//   defer to first use. See 03_process.js (lazy env/argv) and 06_worker.js
//   (__jseInitWorkerChild, invoked by the worker host after startup).
pub const STARTUP_SNAPSHOT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/jse_snapshot.bin"));
