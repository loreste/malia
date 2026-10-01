# Malia supported behavior and verification

This matrix is an explicit subset, not Node conformance. Working baseline c5893393be21f42ac5c6a91aa2372f1926c3732a, macOS arm64; native reference Node 26.4.0. Cross-platform acceptance is pending. See remediation-ledger.json for evidence.

| Area | Supported or restricted behavior | Evidence and remaining work |
| --- | --- | --- |
| AsyncLocalStorage | V8 continuation context; independent instances, synchronous restoration, timers, immediate callbacks and native async operations | remediation_async.mjs; HTTP stress and retention soak still required |
| AsyncResource | Explicit resources and captured context; no native async_hooks lifecycle API | Differential fixture; native hook coverage not claimed |
| node:tls | rustls clients, actual negotiated metadata and DER fingerprint; unverified clients report unauthorized | TLS accept, socket upgrades, custom roots, protocol selection and mutual TLS explicitly rejected; real wire tests required |
| node:fs | Existing filesystem subset | File URL arguments are not currently supported consistently; use fileURLToPath |
| node:vm | Global eval and compileFunction only; contexts, timeout controls, cached data and unsupported options reject | remediation_contracts.mjs; no isolated-context or hostile-code sandbox claim |
| WorkerPool | One dispatcher, tagged jobs, cancellation via termination/replacement, bounded queue and output | Real worker regressions; legacy streaming reserves { __done: true } |
| Queue | Token-owned leases; file-backed SQLite is durable, :memory: is ephemeral; at-least-once delivery | Queue lease and migration tests; multiprocess failure tests pending |
| HTTP | Bounded buffered incoming bodies, admission and connection limits, bounded async response writes and deadlines | External HTTP wire tests; handler AbortSignal propagation, process-wide budgets and sustained RSS testing remain open |
| WebAssembly | Genuine Wasm runs in V8; JS source containers require Malia | No portable JavaScript-to-Wasm compiler |
| Native build | Entry-source embedding for host platform only | No complete dependency graph/assets packaging |
| TypeScript | Transpilation without type checking | Use a separate TypeScript checker |
| Native addons | No established .node/N-API/FFI support | Pure JavaScript package tests are not native-addon evidence |
| Frameworks | Express/CJS examples; Fastify routes and React/Preact/Vue/Svelte SSR, Angular signals/DI fixtures | Full framework CLI/toolchain support not established |
| Databases | Existing seven-driver live success suite | TLS, reconnect, cancellation, failure paths and topology failover remain unverified |
| Tracing | Bounded in-process span collection and OTLP JSON serialization | No network collector exporter; official schema conformance still requires validation |
| KV | Process-wide native memory shared across isolates | Neither distributed nor persistent; JS reads allocate on the V8 heap |

Permission flags are not an OS sandbox. Module graph loading is exempt; symlink check/use races remain a confinement limitation. Invalid discovered config fails before execution. Explicit CLI permission flags replace the config policy; absent CLI flags use the config policy. Default command-specific behavior without a policy remains unchanged.

Queue migration adds lease_token and a private schema version table transactionally. Update consumers to ack(id, token), nack(id, token, backoffMs), and renew(id, token, leaseMs). A lease must be unexpired to mutate a job. maxRetries is the maximum total claim count (including the first claim); exhausted expired leases move to dead-letter on pop. replay(id) resets dead-letter attempts. Payloads are limited to 1 MiB, topics to 1024 characters, and busy waits to 250 ms.

The [module and package inventory](compatibility-inventory.json) records all 54 built-in module source mappings, candidate fixture references and exact available lockfile versions. A static import reference is not a claim of API conformance. The Express example currently has no committed lockfile; its CI install remains an explicit reproducibility gap.

`node:v8` heap and heap-space statistics are actual isolate-local V8 values. Byte fields use bytes, native context counts use counts, and `does_zap_garbage` is numeric 0/1. They are not process RSS or sums across workers. `jse.metrics` request and active-connection counters are process-wide; connections are not in-flight requests. KV `memory_bytes` counts logical retained storage including expired entries awaiting bounded sweep, not allocator/hash-table overhead or total process RSS.

Automatic request-count-triggered GC and automatic Wasm-mode GC are disabled. `jse.optimizer.optimize()` requests V8 low-memory collection; it does not compile JavaScript into Wasm. `JSE_OPTIMIZE=1` or an explicit `optimizer.start()` opts in. Measure tradeoffs with the external harness before enabling it for a workload.

Use `node bench/http_external.mjs /absolute/path/to/target/release/malia 30 16 3` and the identical command with an absolute Node path for separate-process HTTP measurement. Results contain versions, hardware, warmup, repetition counts, errors, throughput, latency histograms and before/after memory/CPU snapshots. Snapshots are not peak-RSS or event-loop-delay measurements; closed-loop concurrency is not fixed offered-rate load. Performance acceptance and the 30-minute release soak remain blocked on workload budgets.
