// OS-thread workers: each worker is a std::thread running its own tokio
// current-thread runtime and its own JsRuntime (separate V8 isolate).
// Messaging with the parent flows through tokio unbounded channels whose
// ends live in the worker's OpState and the process-global worker registry.
use crate::ops::WorkerHost;

pub fn spawn_worker_thread(specifier: String, host: WorkerHost) -> std::io::Result<()> {
  std::thread::Builder::new()
    .stack_size(2 * 1024 * 1024)
    .spawn(move || {
      if let Err(error) = run_worker(&specifier, host) {
        eprintln!("worker {specifier}: {error:#}");
      }
    })
    .map(|_| ())
}

fn run_worker(specifier: &str, host: WorkerHost) -> anyhow::Result<()> {
  let tokio_rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
  tokio_rt.block_on(run_worker_async(specifier, host))
}

async fn run_worker_async(specifier: &str, host: WorkerHost) -> anyhow::Result<()> {
  let cancellation = host.cancellation.clone();
  let mut rt = crate::runtime::create_runtime(Some(host));
  {
    let mut handle = cancellation.handle.lock().unwrap();
    if cancellation.cancelled.load(std::sync::atomic::Ordering::Acquire) {
      return Ok(());
    }
    *handle = Some(rt.v8_isolate().thread_safe_handle());
  }
  // Install worker-child globals (self/onmessage/postMessage/host loop)
  // before the worker's module is evaluated. Deferred out of the snapshotted
  // bootstrap because OpState (and thus op_in_worker) only exists per runtime.
  rt.execute_script("<worker-init>", "globalThis.__jseInitWorkerChild()")?;
  let cwd = std::env::current_dir()?;
  let specifier = crate::runtime::resolve_main_specifier(specifier, &cwd)?;
  let mod_id = rt.load_main_es_module(&specifier).await?;
  let evaluate = rt.mod_evaluate(mod_id);
  rt.run_event_loop(deno_core::PollEventLoopOptions::default()).await?;
  evaluate.await.map_err(|e| anyhow::anyhow!("{e}"))?;
  // Module evaluated; now pump parent->worker messages until the parent
  // closes the channel (terminate() / process shutdown).
  rt.execute_script(
    "<worker-host-loop>",
    "globalThis.__jseWorkerHostLoop && globalThis.__jseWorkerHostLoop()",
  )?;
  rt.run_event_loop(deno_core::PollEventLoopOptions::default()).await?;
  Ok(())
}
