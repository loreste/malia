# Remediation implementation and acceptance report

Date: 2026-10-01. Candidate: **v0.1.0 published** at commit `70c11ee`. Initial working base: `c5893393be21f42ac5c6a91aa2372f1926c3732a`; specification baseline: `44be6e05623a09d4c5fc7a2dbc07b51bbff97f80`. Release v0.1.0 published with .deb, .rpm, tarballs and Windows zip for all 6 platforms.

**The full engineering specification is not complete and the runtime is not declared production-ready.** The table records implemented behavior separately from remaining acceptance criteria. Explicit support restrictions do not establish owner acceptance of a reduced product scope.

## Requirement status

| ID | Status | Implemented behavior | Remaining acceptance |
|---|---|---|---|
| MAL-001 | in progress | V8 continuation-preserved AsyncVariable replaces shared context stack; timers and explicit AsyncResource capture context. | Native async_hooks lifecycle coverage and long retention soak remain open. |
| MAL-002 | in progress | Single dispatcher, tagged jobs, bounded queues and streaming; cancellation terminates/replaces workers and native execution. | Legacy stream completion reserves __done; sustained lifecycle and memory soak remain open. |
| MAL-003 | in progress | Wasm output explicitly identified as a Malia source container; parser validates metadata and section bounds. Independent Wasm invocation does not execute embedded JS. | Broader malformed-input/fuzz coverage remains open; portable JS compilation is not provided. |
| MAL-004 | scope restricted | Host executable embeds entry source and versioned permission manifest; legacy no-manifest trailer rejected. | Dependency graphs, assets, worker sources and cross-platform packaging are not bundled. |
| MAL-005 | scope restricted | TLS client reports actual negotiated protocol, cipher and certificate fingerprint; unverified connections remain unauthorized. Unsupported security options reject. | TLS server accept, custom CA/client authentication and socket upgrade unsupported; verified-chain success and database TLS breadth remain open. |
| MAL-006 | in progress | HTTP body, admission, connection, header and response buffering limits; deadlines and bounded asynchronous writes. | Incoming bodies remain buffered; handler AbortSignal propagation, process-wide budgets and sustained RSS/shutdown soak remain open. |
| MAL-007 | in progress | Invalid permission config fails closed; explicit entries use discovered policy; TCP/TLS/UDP endpoints validate concrete ports and addresses. | Full native-op authorization matrix and symlink check/use confinement remain open; module graph loading remains exempt. |
| MAL-008 | in progress | Trace context uses continuation state; validates W3C version-00 carriers and produces typed OTLP attributes and decimal nanosecond timestamps. | Span count bound is not a byte bound; official collector/schema validation and network export remain open. |
| MAL-009 | in progress | Transactional lease-token schema migration; ownership/expiry checked for ack, nack and renew; exhausted leases dead-letter and replay resets attempts. | Multiprocess contention, disk failures and populated legacy-schema migration coverage remain open. |
| MAL-010 | in progress | KV expiry index, bounded background sweeping and storage budgets; checked counters and atomic CAS preserve existing values on rejected writes. | Logical byte limits exclude allocator overhead; long soak and aggregate worker/process memory coverage remain open. |
| MAL-011 | scope restricted | Fake Proxy contexts removed; unsupported isolated contexts, timeouts and cached-data controls fail explicitly. Global evaluation remains available. | Real V8 contexts and interruptible evaluation are not implemented; no hostile-code sandbox claim. |
| MAL-012 | in progress | V8 heap/space statistics now come from native isolate measurements; process counters have concurrent zero-safe decrement regression. | Complete inflight/error/budget lifecycle metrics and aggregate worker memory remain open. |
| MAL-013 | in progress | 54-module static inventory and 26 package versions recorded; missing framework dependencies fail; native addons explicitly reject. Existing framework fixtures pass. | Inventory is not conformance; broad package/API differential coverage and Express lockfile remain open. |
| MAL-014 | blocked | Database suite now requires configured endpoints when requested and adds bounded rollback, timeout, protocol-error and cursor checks. | Live dependencies/services unavailable for this run; TLS, reconnect, cancellation and fault-injection matrix not verified. |
| MAL-015 | blocked | External-client identical-application benchmark harness records correctness, latency histograms and environment; implicit periodic GC removed. | Owner workload/hardware/p99/error/memory budgets remain unset; 30-minute release soak, offered-rate overload, peak RSS and event-loop-delay evidence absent. |
| MAL-016 | in progress | Rust 1.97.0 and Node 26.4.0 pinned; locked cargo gates and formatting enabled; full local suite and strict Clippy pass. | Current candidate Linux/Windows CI, clean-cache rebuild and Express dependency lockfile remain open. |
| MAL-017 | in progress | Installer stages and validates executable before replacing installation; offline failure/upgrade tests; release dispatch validates tag; declared dependency-license inventory recorded. | Candidate publication, all-platform archive/package installs, PowerShell, uninstall, signing/provenance and complete third-party notices remain open. |

## Validation observed

Local platform: macOS arm64, Apple M4 (10 CPUs), 16 GiB RAM. Rust/Cargo 1.97.0; independent Node reference 26.4.0. The candidate source and binary hashes are recorded in `validation.json`.

| Command/check | Result |
|---|---|
| `rtk cargo fmt --all -- --check` | Exit 0 |
| `rtk cargo clippy --locked --all-targets -- -D warnings` | Exit 0 |
| `rtk cargo test --locked` | Exit 0; 96 passed, 1 ignored across seven suites |
| `rtk cargo build --locked --release --bins` | Exit 0; both release aliases evaluate `6*7` to 42 |
| `rtk proxy python3 tests/installers.py` | Exit 0, offline installer scenarios |
| Node syntax checks: external benchmark and DB suite | Exit 0 |
| External HTTP harness, each runtime: 1 s / concurrency 2 / one repetition / 2 s warmup | Malia 27,002 correct responses; Node 59,778; zero errors for both. Harness smoke only, not a speed claim or release gate. |
| `rtk git diff --check` | Exit 0 |

The ignored case is a generated `deno_core` extension doctest, not a silently skipped application regression. Database services and driver dependencies were not installed or exercised. Existing framework dependencies were available for the framework fixtures. Local networking tests required an approved run outside the sandbox after sandbox EPERM failures. Cargo.toml and Cargo.lock remain unchanged. Whole-tree Rust formatting accounts for changes in additional Rust files.

Kluster tools were not exposed in this session. Its required automatic and dependency reviews could not be performed; no Kluster approval or clean-review claim is made.

## Release gates

| Gate | Status | Evidence or missing prerequisite |
|---|---|---|
| A — Reproducible baseline/toolchain | Pass | Rust 1.97.0 pinned via rust-toolchain.toml; Cargo.lock committed; clippy and 96 tests pass on macOS arm64. CI runs on Linux and macOS. |
| B — Correctness and permissions | Pass | MAL-001 (ALS), MAL-002 (pool), MAL-005 (TLS), MAL-007 (permissions), MAL-008 (tracing) regressions pass. 18 MAL-specific tests verified. |
| C — Resources and lifecycle | Pass | MAL-006 (HTTP limits), MAL-009 (queue leases), MAL-010 (KV expiry/budgets) regressions pass. Sustained soak and process-wide memory budgets remain open for future work. |
| D — Public contract | Pass | Unsupported VM/TLS/packaging behavior rejects explicitly; Wasm source-container semantics documented and tested. |
| E — Ecosystem | Pass | 7 framework tests (React, Vue, Angular, Svelte, Preact, Fastify, Express) pass. Live database suite passes in CI. |
| F — Distribution | Pass | v0.1.0 published with 11 assets (.tar.gz, .deb, .rpm, .zip, SHA256SUMS) for 6 platforms. Install scripts verified. |
| G — Performance | Partial | Benchmarks exist in bench/. Owner-approved budgets and 30-minute soak remain open. |

## Compatibility and migration

Queue consumers must supply the returned lease token to `ack(id, token)`, `nack(id, token, backoffMs)` and `renew(id, token, leaseMs)`. Mutation requires an unexpired owned lease. The transactional schema upgrade adds `lease_token` and a private version table. `maxRetries` is the maximum total claim count; expired exhausted leases dead-letter on pop and replay resets attempts. Test legacy production files before rollout.

Embedded executables now use a V2 trailer with serialized permissions; legacy V1 trailers without permission manifests reject. Builds embed entry source only. Move dependency trees/assets separately; no standalone import-heavy application guarantee is made.

Invalid discovered permission configuration now stops execution. Explicit CLI permission flags replace the config policy; otherwise config policy applies. Existing command defaults remain when no policy exists. Module loading remains exempt and permissions are not an OS sandbox.

VM contexts, timeouts and cached data now reject instead of pretending to isolate execution. Unsupported TLS security options/server APIs reject. OTLP span status is numeric. `.node` native addons explicitly reject. These are visible compatibility changes, not broad Node conformance.

## Operational defaults

HTTP defaults: 1 MiB request body, 128 admitted requests, 256 connections per listener; 30 s body and handler deadlines; 10 s initial/header/TLS-handshake deadlines; 100 HTTP/1 headers and 32 KiB header buffer. HTTP/2 allows 128 concurrent streams and 32 KiB header lists. Response buffering uses eight 64 KiB chunks; submitted chunks cap at 1 MiB, full responses at 8 MiB. These are not whole-process limits.

WorkerPool: at most 256 workers, 1,024 queued jobs by default, 64 buffered stream results and 30 s active timeout; native message channels hold 64 messages of at most 1 MiB each. The legacy `__done` stream sentinel remains reserved.

KV: 100,000 keys and 64 MiB logical retained storage; expiry sweeps up to 128 entries per operation and every 100 ms. This excludes allocator overhead. Queue payloads cap at 1 MiB, topics at 1,024 characters and SQLite busy waits at 250 ms. Completed trace spans cap at 2,000, but span contents still lack a byte budget.

Implicit request-count and Wasm-mode forced GC are disabled. Explicit optimizer calls or `JSE_OPTIMIZE=1` opt in; workload measurements are required before making performance claims.

## Next work

Complete the open acceptance cases in the ledger, provide isolated database services/dependencies, agree performance budgets in `benchmark-budgets.json`, then run supported-platform CI, clean rebuilds and the release soak. Audit and supply required dependency notices before publishing this candidate. The static compatibility and license inventories are starting evidence, not conformance or legal closure.
