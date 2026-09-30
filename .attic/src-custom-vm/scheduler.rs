//! Green-thread scheduler.
//!
//! Every spawned task gets its own `Vm` (its own frame stack) and is run as a
//! tokio task on the multi-thread runtime, so CPU-bound tasks are spread
//! across OS threads by the tokio work-stealing scheduler, while the VM's own
//! cooperative yield budget keeps one hot loop from starving its thread.
//!
//! Async natives (`sleep`, channel `send`/`recv`, `join`) suspend the current
//! task as a tokio future instead of blocking an OS thread, which is what
//! lets tens of thousands of sleeping tasks multiplex onto a handful of
//! threads.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use crate::builtins;
use crate::value::{Closure, Value};
use crate::vm::Vm;

/// State shared by every task VM: globals, the tokio handle, and an ops
/// counter used by `jse bench`.
pub struct RuntimeCtx {
    pub globals: Arc<RwLock<HashMap<String, Value>>>,
    pub handle: tokio::runtime::Handle,
    pub ops: Arc<AtomicU64>,
}

impl RuntimeCtx {
    /// Must be called from within a tokio runtime context.
    pub fn new() -> Arc<Self> {
        let ctx = Arc::new(RuntimeCtx {
            globals: Arc::new(RwLock::new(HashMap::new())),
            handle: tokio::runtime::Handle::current(),
            ops: Arc::new(AtomicU64::new(0)),
        });
        builtins::install(&ctx);
        ctx
    }

    pub fn ops_count(&self) -> u64 {
        self.ops.load(Ordering::Relaxed)
    }
}

/// Run a compiled main closure on a fresh task VM.
pub async fn run_main(ctx: Arc<RuntimeCtx>, main: Arc<Closure>) -> Result<Value, String> {
    let mut vm = Vm::new(ctx);
    vm.run(main, Value::Undefined, vec![]).await
}

/// Spawn a green thread: a fresh task VM running `f` on the tokio runtime.
pub fn spawn_task(
    ctx: &Arc<RuntimeCtx>,
    f: Arc<Closure>,
    args: Vec<Value>,
) -> tokio::task::JoinHandle<Result<Value, String>> {
    let ctx2 = ctx.clone();
    ctx.handle.spawn(async move {
        let mut vm = Vm::new(ctx2);
        vm.run(f, Value::Undefined, args).await
    })
}
