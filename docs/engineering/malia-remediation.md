# Malia remediation specification

Owner supplied baseline: Malia Codex Remediation and Engineering Bible version 1.0, 2026-10-01. The ledger records implementation evidence and remaining requirements; this transcription preserves the full baseline.

Malia Codex Remediation and Engineering Bible

Version 1.0    1 October 2026

Repository    https://github.com/loreste/malia

Project owner    Lance Oreste

Purpose    Authoritative remediation specification and continuing engineering standard

We will make Malia dependable for defined JavaScript and TypeScript backend workloads before expanding its production claims. This manual converts the technical review into implementation requirements, reproducible checks, release gates, and a maintenance process for Codex and human maintainers.

The immediate objectives are isolated asynchronous context, reliable worker scheduling, accurate TLS behavior, fail-closed configuration, bounded resource use, and honest compilation semantics. Subsequent work covers portable packaging, lease-safe queues, compatibility depth, observability, and measured performance.

This manual is the project baseline for remediation. Requirements remain open until evidence proves they are satisfied. A passing build, an API name, a successful import, or a benchmark headline does not establish behavioral compatibility. Any supported subset must be stated explicitly.

Review baseline and evidence

The source checkout reviewed was 44be6e05623a09d4c5fc7a2dbc07b51bbff97f80. The review also inspected 06c56705465f2bae020ff17ed5f451be05f03821, which changes the atomic decrement used by production telemetry. Runtime files discussed here were unchanged by the packaging-only 44be6e0 commit relative to 819ac06.

Reproductions loaded the actual JavaScript modules under Node. The WorkerPool reproduction used simulated transport. Full Rust execution must be performed by the implementing agent; the review did not run a local Cargo build. These evidence limits must remain attached to the findings until runtime reproductions are added.

How to use this manual

Give this entire document to Codex with repository access. Start with the execution contract on the next page. Codex must establish the current baseline, reproduce relevant failures, implement cohesive fixes, run the required checks, and maintain the requirement ledger. This document authorizes planning and implementation specifications; repository changes, publishing, and deployment follow the owner's actual instructions for that session.

1 Codex execution contract

Copy this instruction into the implementation session

Implement the Malia Codex Remediation and Engineering Bible against the current loreste/malia repository. Read repository instructions first. Record the branch, full HEAD SHA, toolchain, supported Node reference versions, operating system, and available services. Reconcile every MAL requirement with the current code before modifying it. Preserve existing working behavior and avoid unrelated rewrites. Work in the dependency order specified here. Add meaningful failing regression tests before each correctness fix, then demonstrate that they pass after the change. Keep the ledger and documentation aligned with the implementation. Continue through all feasible work; report genuine blockers with exact evidence. Do not claim completion for skipped, mocked-only, unsupported, or unverified behavior. Do not merge, release, or deploy unless the owner's current instructions authorize it.

First actions

1. Read AGENTS.md and existing development, build, CI, release, and compatibility documentation. Inspect the working tree without discarding user changes. Use an isolated branch or worktree when appropriate.

2. Record git rev-parse HEAD and git status --short. Map this manual's paths to current files. Identify fixes landed after the baseline and evaluate their tests.

3. Establish build prerequisites for deno_core, V8, SWC, aws-lc, SQLite, and the target OS. Pin a supported Rust version and preserve Cargo.lock for reproducibility.

4. Run the baseline checks in section 21. Capture exit codes, failing test names, skipped suites, and service requirements. Do not install or execute the shell installer into the user's normal profile for testing; use a disposable destination.

5. Create the ledger and a compatibility matrix. Classify each requirement as open, reproduced, in progress, blocked, or verified. A historical fix can become verified only after current evidence satisfies its acceptance criteria.

Rules during implementation

Prefer small cohesive changes with stable public semantics. Do not relax assertions, swallow errors, fabricate data, or remove tests to achieve green CI. Resolve the underlying defect. Where a feature cannot be implemented safely, fail explicitly and document the supported subset; this is a scope restriction, not full implementation.

Use deterministic barriers for concurrency tests. Use hard test timeouts to detect hangs. Mocked unit tests complement real transport tests. Keep secrets out of fixtures and logs; use temporary credentials and local certificates. Preserve worker and process shutdown behavior. Re-run affected suites after meaningful changes, then complete the release gates once the final source state is ready.

2 Architecture and product contract

Supported direction

Malia is a backend-oriented JavaScript and TypeScript runtime built in Rust, executing JavaScript through V8 and deno_core. Its differentiating facilities are explicit worker parallelism, npm database interoperability, routing, embedded SQLite, queues, KV, and application observability. Target control APIs, webhooks, provisioning, automation, and background jobs first. Real-time IVA streaming requires the streaming, cancellation, latency, and overload gates in this manual.

Architecture invariants

Each V8 isolate is confined to its owning OS thread and current-thread Tokio runtime. JavaScript CPU work remains serial within an isolate. Parallel CPU execution requires additional isolates or native work. Tokio I/O concurrency must not be described as automatic parallel execution of ordinary JavaScript handlers.

Hyper network tasks run on a separate Tokio runtime and exchange messages with the isolate. Every cross-thread queue needs an ownership model, a capacity or budget, cancellation, and shutdown semantics. Synchronous filesystem, SQLite, and crypto calls can block the isolate; preserve compatibility but document cost and offer asynchronous paths where justified.

Bootstrap JavaScript is serialized into a startup snapshot. Changes to runtime ops, bootstrap ordering, or permissions must remain consistent between the build-time and runtime extensions. Cached compilation results must be keyed by every semantic input that affects output.

Public claims

TypeScript is transpile-only unless a separate type-check command is implemented and tested. Native standalone packaging is runtime embedding, not JavaScript ahead-of-time machine-code compilation. Existing Wasm modules execute through V8. A source-bearing Wasm container is not a portable JS-to-Wasm compiler. Supported Node modules must identify complete, partial, unsupported, and intentionally different behavior.

Reporting process.version as v26.0.0 is an ecosystem compatibility choice, not evidence of Node 26 conformance. Runtime identity and actual compatibility levels must remain discoverable and documented. Do not silently advertise support simply because package feature detection passes.

Preserve the demonstrated foundation

Maintain live database coverage for PostgreSQL, MySQL, Redis, MongoDB, DynamoDB Local, Elasticsearch, and Cassandra. Preserve SSR and package tests for React, Vue, Preact, Svelte, Angular signals and DI, Fastify injection, and Express. Add stronger acceptance tests without changing the meaning of these narrower existing tests.

3 Requirement register and priority order

Stable identifiers

P0 means a security or request-isolation release blocker. P1 means a correctness, resource-control, or advertised-behavior blocker for the affected feature. P2 means validation, operational depth, or maintenance work required for a dependable release. Priorities below are project requirements; they do not assert that every reviewed concern has been exploited.

MAL-001 P0 Asynchronous context isolation. Reproduced in actual JavaScript under Node.

MAL-002 P1 WorkerPool dispatch and stream lifecycle. Reproduced with simulated transport.

MAL-003 P1 WebAssembly application semantics. Confirmed by implementation inspection.

MAL-004 P1 Standalone packaging and permissions. Confirmed by implementation inspection.

MAL-005 P0 TLS API truthfulness and server behavior. Confirmed by implementation inspection; real wire tests required.

MAL-006 P1 HTTP streaming and resource limits. Confirmed unbounded channels and request buffering; load validation required.

MAL-007 P0 Permission configuration and enforcement. Unknown presets grant all in reviewed code.

MAL-008 P1 Tracing context and export correctness. Parent contamination reproduced under Node; schema validation required.

MAL-009 P1 Queue lease ownership and retries. Design gap established by code review; runtime reproduction required.

MAL-010 P1 KV expiry and memory accounting. Retained expired entries established by code review.

MAL-011 P1 VM compatibility and timeouts. Confirmed Proxy and eval implementation; differential validation required.

MAL-012 P2 V8 and production telemetry accuracy. Fixed estimates confirmed in V8 module.

MAL-013 P2 Node and framework compatibility program. Existing coverage verified; broader behaviors unverified.

MAL-014 P2 Database resilience and TLS coverage. Existing live success path verified; failure paths unverified.

MAL-015 P2 Benchmarks and optimizer policy. Methodology and GC behavior reviewed; performance benefit unproven.

MAL-016 P1 Toolchain and CI stability. Historical Clippy failure; corrective commit inspected, verification still required.

MAL-017 P2 Distribution and continuing governance. Packaging additions inspected; published delivery must be verified.

Dependency order

First reconcile MAL-016 so baseline checks can run reliably. Address MAL-007, MAL-005, and MAL-001 early. Implement MAL-008 after MAL-001. Complete MAL-002 and MAL-006 before stress claims. Resolve MAL-003 and MAL-004 before compilation or self-contained deployment claims. MAL-009, MAL-010, MAL-011, and MAL-012 follow as cohesive work. Expand MAL-013 and MAL-014 throughout; finalize MAL-015 and MAL-017 against the final implementation.

All requirements begin as unverified in a new implementation session. Earlier evidence remains historical evidence, never a substitute for testing the current checkout.

4 MAL 001 Asynchronous context isolation

Priority P0. Primary file src/js/node/async_hooks.js. Supporting areas runtime integration, timers, native async ops, and Node compatibility fixtures. Evidence: actual source loaded under Node returned request-B for both overlapping scopes, while native Node returned request-A and request-B. Code also exposed request-B outside run().

Required behavior

AsyncLocalStorage.run() restores the caller's synchronous context when the callback returns, even if that return value is a promise. Async descendants retain the originating store independently of concurrently active scopes. Promise continuations, timers, I/O callbacks, and error paths must not share mutable request state. Nested runs, exit(), disable(), bind(), snapshot(), and multiple storage instances have defined behavior matching the chosen Node reference.

Replace the global mutable stack plus Promise.then patch as the sole propagation mechanism. Investigate deno_core and V8 hooks supported by the pinned dependency versions. Implement context ownership at async resource boundaries. If a hook does not cover timers or native completions, bridge those boundaries explicitly. Do not retain a request store by holding the global scope open until its promise settles.

AsyncResource must have consistent lifecycle behavior for supported methods. Do not invent identifiers or imply full hook support when methods are placeholders. Prevent completed stores from being retained indefinitely.

Acceptance tests

Start A and B on one isolate, hold both on a shared barrier, and release them in either order. Each continuation must see its own store; outside both run calls the store must be undefined. Repeat with timer, filesystem, fetch, and explicit then boundaries. Assert nested restoration after success, rejection, and synchronous throw. Assert two ALS instances do not overwrite each other. Test disable and binding semantics against native Node.

Run a real HTTP server with many overlapping handlers. Assign unique request IDs and check them after multiple awaits. Assert zero cross-request contamination. Use deterministic barriers for regressions and a longer stress test for resource cleanup. Test the Malia runtime, not only the module under Node.

Closure evidence

Provide the previously failing reproduction, differential output, runtime integration tests, and memory-retention checks. MAL-008 depends on this contract. Do not close MAL-001 merely because simple sequential async tests pass.

5 MAL 002 Worker scheduling and lifecycle

Priority P1. Primary files src/js/08_pool.js, src/js/06_worker.js, src/js/node/worker_threads.js, src/worker.rs, and worker ops in src/ops.rs.

Evidence: with size one, run(first) followed by a queued stream(stream) enters ordinary dispatch on completion of first. The reproduced iterator fails with an undefined worker receive method. The stream path also returns a worker to the idle pool immediately on iterator return(), without draining or cancelling old replies.

Required behavior

Use one dispatcher that recognizes ordinary and streaming jobs. Give each job an ID; messages and completion signals must be tied to the active job. Define legal worker states and transitions: idle, busy, streaming, cancelling, failed, closing, and closed. A worker can execute one pool job at a time and can return to idle exactly once.

End-of-stream, break, exception, cancellation, worker failure, and pool close must settle every consumer. Do not reuse a worker until the previous task has completed, been cancelled and acknowledged, or the worker has been terminated and replaced. Discard or reject late replies for obsolete task IDs. A completion sentinel must not collide with ordinary application payloads.

Bound queued jobs and output buffering. Expose a documented rejection or wait policy when capacity is reached. Support cancellation for queued and running work. Clean up handlers and failed workers. Surface thread-spawn failures to callers; stderr output alone is insufficient. Define how startup failures and worker exceptions reject jobs.

Acceptance tests

Mix run and stream jobs with pool sizes one and several. Queue a stream behind a normal task and vice versa. Break after the first streamed reply, then submit another task and assert no stale reply arrives. Test a worker that sends nothing, sends duplicate completion, throws, exits, or fails to initialize. Use deadlines so hangs fail tests.

Test close while idle, queued, running, and streaming. Assert all promises and iterators settle once, no duplicate idle entry exists, queue limits hold, and native workers exit. Exercise simulated transport for deterministic scheduling and real V8 workers for end-to-end behavior. If worker_threads thread IDs remain fixed, assign actual unique IDs or document and reject unsupported semantics.

Closure evidence

Include state-transition tests, original regression, real-worker tests, queue-budget tests, and shutdown/resource evidence. Do not close based solely on immediate streaming when a worker happens to be idle.

6 MAL 003 WebAssembly application semantics

Priority P1. Primary files src/wasm_compiler.rs, src/loader.rs, src/optimizer.rs, src/js/13_wasm_optimizer.js, CLI and Wasm tests.

Evidence: compile_file_to_wasm embeds transpiled source in the jse_bundle custom section. Emitted main returns zero; compute adds two integers. The module loader detects the section and executes bundle.source as JavaScript. Existing arithmetic synthesis and execution of genuine Wasm modules are separate working capabilities.

Required behavior

Immediately make the public contract accurate. Identify the existing output as a Malia-specific source container, not a portable JavaScript application compiled to WebAssembly. Rename or clearly qualify commands, help text, APIs, output metadata, and examples. Preserve old flags only with an explicit deprecation path and accurate warnings. Replace misleading wasm_optimized metadata where it implies application compilation.

The current remediation scope does not require inventing a full JavaScript-to-Wasm compiler. Keep portable compilation as a separate design decision with a runtime model, module format, supported language subset, host ABI, and real execution plan. If portable compilation is implemented later, its gate is observable application behavior in an independent engine.

Validate headers, version, section bounds, LEB128 encodings, metadata version, and payload size before executing container content. Invalid input must return structured errors rather than panicking or falling through ambiguously. Preserve existing Wasm module imports and instantiate behavior.

Review compileStreaming and instantiateStreaming. The reviewed wrappers buffer arrayBuffer before compilation; document buffering accurately or implement true streaming with response and MIME validation appropriate to the supported Web API contract.

Acceptance tests

Compile an application with a visible side effect, inspect the custom section, and execute _start in an independent Wasm engine. For container mode, explicitly demonstrate that the side effect requires Malia and that the public contract says so. For any portable mode, the independent engine must produce the expected side effect. Test malformed sections, overlong or truncated lengths, oversized metadata, invalid JSON, and unknown bundle versions.

Test genuine Wasm exports and host imports independently from source-container loading. Existing tests that compile and then run only through Malia are insufficient to prove portable compilation.

Closure evidence

Close when the advertised contract is accurate, container behavior is validated, compatibility changes are documented, and tests distinguish source packaging from genuine Wasm execution. Portable compilation remains unsupported until independently demonstrated.

7 MAL 004 Standalone packaging and permissions

Priority P1. Primary file src/main.rs functions create_standalone_binary and check_standalone_binary. Supporting files module loader, config, worker resolution, assets, and CLI packaging tests.

Evidence: reviewed packaging appends only the transpiled entry source to the current runtime executable. Embedded execution calls run_code_blocking and sets allow_all. No complete dependency graph or assets are included by that code path.

Required behavior

Specify packaging as an embedded runtime executable. Collect the full reachable module graph, including local ESM, CommonJS, JSON, relevant npm modules, Wasm, worker entry points, and declared assets. Define static and dynamic import support. Unsupported dynamic paths must fail at build time or require explicit inclusion rules; never silently rely on the original source tree.

Preserve module identities and resolve relative imports against embedded locations rather than the launch cwd. Bundle source maps with correct origins. Workers must resolve embedded entries. Define how declared file assets are accessed and how writable state remains external. Cross-platform builds must declare host and target requirements; do not imply that copying the current executable produces another platform's binary.

Embed a validated permission manifest. Do not silently upgrade a restricted application to allow-all. An unrestricted build must be explicit and visible in metadata or build output. Validate footer lengths and all bundle offsets without integer overflow or unbounded allocation. Check executable signing requirements for target platforms; appending bytes can affect signing and must be tested.

Acceptance tests

Build a fixture importing local modules, npm code, JSON, a worker, a Wasm module, and an asset. Copy only the executable into an empty directory or clean container, remove the source tree and node_modules, launch from another cwd, and assert expected output. Test restricted filesystem and networking after packaging. Test a declared dynamic import and an undeclared path.

Test malformed or truncated trailers and large or invalid length fields. Verify exit codes, argv, startup, signals, source maps, and target OS behavior. A hello-world executable alone does not establish self-contained applications.

Closure evidence

Provide the clean-environment execution log, bundle manifest, permission tests, platform limitations, and documented asset and dynamic-import policies. If complete packaging is deferred, rename the existing feature as entry-source embedding and keep the full packaging requirement open.

8 MAL 005 TLS correctness and truthful APIs

Priority P0 for applications relying on node:tls. Primary files src/js/node/tls.js, src/js/node/net.js, src/ops_extra.rs, src/js/node/https.js, and TLS fixtures.

Evidence: getPeerCertificate returns invented subject, issuer, validity, and zero fingerprint. getCipher and getProtocol return fixed values. authorized is initialized true. tls.Server extends net.Server and only stores options; its inherited listen path uses plain network listening. The separate HTTPS server path must be assessed independently.

Required behavior

Implement a real TLS accept path for node:tls servers or reject creation/listening explicitly until supported. Deliver secureConnection only after a successful TLS handshake. Ordinary plaintext connections must not be accepted as secure. Return actual negotiated protocol, cipher, certificate fields, authorization state, and authorization errors. Unsupported certificate fields should be omitted or explicitly unsupported, never fabricated.

Audit the JavaScript and Rust op argument and return contracts together. Pass client connection identifiers and address information consistently. Respect supported options for SNI, CA roots, hostname verification, minimum and maximum protocol versions, ALPN, and client authentication. Implement options used by the supported database clients; reject unimplemented security-sensitive options.

Reject invalid chains and hostname mismatches by default. Any insecure option must be explicit, tested, and accurately reflected in authorized. Do not imply that custom CA, client certificates, or session reuse work if rustls configuration ignores them. Keep HTTPS and HTTP2 behavior consistent with their own documented contracts.

Acceptance tests

Use local test CAs and certificates to test valid chains, wrong names, expired certificates, untrusted issuers, and custom roots. Verify handshake failure and peer metadata. Connect a genuine TLS client to node:tls.createServer and exchange bytes; assert plaintext cannot complete secure negotiation. Test SNI, ALPN, TLS versions, and mutual TLS wherever supported.

Run PostgreSQL and another supported database through TLS, including an invalid-certificate case. Test peer fingerprint and cipher against the actual handshake. Verify failed connection state, socket cleanup, error events, and no false secureConnect event.

Closure evidence

Provide real wire tests, negative certificate tests, API differential checks, and a security-sensitive options matrix. Do not close with mocked TLSSocket objects or a successful HTTPS request alone.

9 MAL 006 HTTP streaming and resource limits

Priority P1. Primary files src/serve.rs, HTTP and serve ops, src/js/11_serve.js, src/js/node/http.js, fetch and stream modules.

Evidence: incoming body.collect reads all request bytes before handing them to JavaScript. Request handoff and streaming response channels are unbounded. These mechanisms can accumulate memory under large uploads, slow consumers, and handlers that fall behind.

Required behavior

Introduce configurable maximum request-body bytes, header limits, request admission limits, per-stream output budgets, and bounded handoff queues. Document defaults in one configuration source. Reject oversized bodies with 413 and saturated admission with a defined retryable response. Enforce streaming-byte limits even without Content-Length; advertised lengths are not sufficient.

Deliver streaming incoming bodies where the public API promises them. Backpressure must reach the network reader and the JavaScript producer. Bound each request and total process buffering. For outgoing streams, an async producer must wait for capacity rather than enqueue indefinitely. Native memory counts toward the resource budget alongside the V8 heap.

Propagate client disconnect and cancellation to handlers, body readers, and pending response state. Add deadlines for headers, request bodies, handler execution or response initiation, idle connections, and graceful drain. Avoid hanging pending maps after task failure. Preserve keep-alive and shutdown behavior.

The Node HTTP client currently buffers bodies and does not provide Agent connection pooling. Either implement the advertised options and keep-alive semantics or retain a clearly documented subset. Add proper writable backpressure for streaming uploads before claiming equivalence.

Acceptance tests

Use an external client to send chunked uploads without Content-Length, oversize bodies, slow uploads, aborted uploads, and malformed messages. Block handlers behind barriers while filling admission capacity. Read streaming responses slowly and disconnect midstream. Assert bounded RSS and queue occupancy, defined rejection behavior, and cleanup after cancellation.

Test pipeline and keep-alive behavior, real Express and Fastify listeners, TLS variants, and shutdown with active streams. Measure p99 latency and memory at normal load and overload. Limits must be configured and asserted, not inferred from successful small requests.

Closure evidence

Provide configured budgets, stress metrics, cancellation tests, and clean pending-state shutdown. MAL-015 depends on this work for trustworthy throughput and memory comparisons.

10 MAL 007 Permission validation and enforcement

Priority P0. Primary files src/config.rs, src/permissions.rs, filesystem/network/process/database ops, worker inheritance, and embedded execution.

Evidence: build_permissions matches known permissive and restrictive presets, but its fallback grants all permissions. A typo such as permissions set to strcit can therefore make the application permissive. Path and executable allowlist hardening already exists and must be preserved.

Required behavior

Reject unknown permission presets, malformed granular rules, unknown capability keys, invalid value types, and ambiguous empty entries with clear configuration errors. Unknown configuration must not broaden authority. Define explicit precedence between config and CLI grants; choose and document the intended merge or override rules. Surface the resolved permission policy in config output.

Audit every externally reachable native op for the relevant read, write, network, executable, or environment check. Include SQLite paths, queues, TLS, DNS, UDP, HTTP2, WebSockets, Unix sockets, subprocess cwd and PATH, and file watchers. Keep workers' inherited grants deterministic. Validate host and port allowlists at the actual connection boundary; ensure a host-only check does not undermine an advertised host-and-port restriction.

Document module-loading exemptions and their implications. Permission flags are not an OS sandbox. Preserve canonicalization of relative paths, symlinks, nonexistent tails, and executable paths. Assess symlink races between check and use; use handle-based confinement where needed or document unresolved limits. Standalone permission behavior is governed by MAL-004.

Acceptance tests

Reject strcit, arbitrary presets, unknown keys, and invalid rule types before running user code. Test absent config, strict config, explicit all, scoped grants, and CLI precedence. Create fixtures for symlink escape, traversal, dangling targets, executable PATH substitution, and child cwd changes.

Exercise allowed and denied operations through public APIs and reachable ops. Test host-and-port scopes for TCP, TLS, HTTP, HTTP2, UDP, and redirects. Verify workers cannot acquire extra capabilities. Confirm a module graph exemption cannot silently become a claim of fully isolated untrusted execution.

Closure evidence

Provide a permission coverage matrix, negative tests, resolved-policy snapshots, and current enforcement evidence. Existing adversarial tests remain mandatory; do not remove them when changing the model.

11 MAL 008 Tracing and async observability

Priority P1. Primary file src/js/18_trace.js. Dependencies MAL-001 and accurate telemetry in MAL-012.

Evidence: activeSpan is a single shared variable held during async callbacks. An unrelated span started while request A waited inherited A's parent and trace ID in the focused reproduction. Export format and validation require additional conformance checks.

Required behavior

Store active spans in the corrected asynchronous context mechanism. Parent selection must follow the execution context, not the most recently started asynchronous operation in the isolate. Restore context after synchronous callbacks and correctly scope asynchronous descendants. Define explicit parent override, root-span creation, and manual span lifecycle.

Validate traceparent version, field lengths, hexadecimal encoding, nonzero identifiers, and flags. Accept documented carrier types, including plain objects and Headers if advertised. Preserve upstream trace IDs and sampling flags according to the supported W3C contract. Invalid carriers must not silently manufacture misleading ancestry.

Make OTLP JSON output conform to the chosen official schema. Validate integer nanosecond timestamp representation without JavaScript precision loss; use decimal strings for 64-bit fields where required. Map numeric status codes and attribute value types correctly. Distinguish serialization from an actual exporter: a JSON object alone is not delivery to a collector.

If transport export is supported, define endpoint configuration, authentication, bounded batching, retry policy, drop accounting, and shutdown flush deadlines. Sampling and bounded buffering must not retain application data indefinitely. Tracing failures must not unexpectedly fail requests.

Acceptance tests

Overlap two HTTP requests with barriers, create parent and child spans after awaits, and assert each trace tree contains only its own descendants. Test nested scopes, errors, manual end, duplicate end, cancellation, and parent overrides. Test invalid traceparent values and Headers carriers.

Export to a local OpenTelemetry collector or validate against its official schema. Confirm timestamps survive round-trip parsing and attributes retain intended types. Test unavailable collectors, bounded buffer saturation, and graceful flush if transport exists. Publish a supported tracing subset.

Closure evidence

Provide the original contamination regression under Malia, corrected trace trees, exporter/schema tests, and explicit supported behavior. A span-count assertion is not a context-isolation test.

12 MAL 009 Durable queue lease ownership

Priority P1. Primary files src/js/19_queue.js and src/sql.rs. Supporting areas SQLite error and concurrency handling.

Evidence: pop increments attempts and advances locked_until inside BEGIN IMMEDIATE. ack deletes by job ID alone, and nack updates by job ID alone. A consumer holding an expired lease can acknowledge or modify a claim acquired later by another consumer. Automatic expired-lease retries also lack a clear terminal-attempt policy in pop.

Required behavior

Return a unique claim token or monotonically increasing lease generation with every pop. Store ownership and lease state atomically. ack, nack, renew, and any release operation must match job ID and token. Define whether acknowledgements after expiry are accepted; once a new claim exists, all older tokens must be rejected without changing that claim.

Apply retry limits to explicit nack, expiry, and crash recovery. Define whether maxRetries counts total attempts or retries after the first attempt. Make delayed scheduling separate from lease ownership where necessary. Terminal jobs enter a dead-letter state atomically. Define backoff, replay, and idempotency expectations. The queue provides at-least-once behavior unless a stronger guarantee is implemented; do not promise exactly-once delivery.

Use schema versioning and migrate existing queue files safely. Keep claims atomic across processes. Configure SQLite busy handling and bounded retries; do not block the isolate indefinitely. Validate topic, lease duration, retry values, and payload limits. Decide whether default memory mode is appropriate and explicitly distinguish durable file-backed queues from ephemeral queues.

Acceptance tests

Consumer A claims a job, its lease expires, and B reclaims it. A's ack and nack must not alter B's job. Test renew races, wrong tokens, duplicate acknowledgements, a consumer crash, delayed jobs, repeated expiration at the retry limit, and dead-letter replay.

Run competing real worker/process consumers against one database. Assert each lease generation has one owner and every transition is recoverable. Restart the runtime between claims. Test database-busy, disk-full, malformed payload, migration, and rollback paths with bounded failures.

Closure evidence

Provide ownership regression tests, schema migration evidence, concurrency and restart results, and documented delivery semantics. Existing push/pop success tests alone do not establish durable processing correctness.

13 MAL 010 KV expiry and memory budgets

Priority P1 for long-running cache workloads. Primary files src/kv.rs and src/js/14_kv.js.

Evidence: expired entries are hidden by get and keys but retained in the underlying HashMap. stats reports active memory while expired allocations remain resident. Native off-heap storage still consumes process memory and values copied back to JavaScript can allocate on the V8 heap.

Required behavior

Implement bounded reclamation of expired entries through opportunistic removal, a sweeper, or an expiry index. Reclamation must occur without requiring each expired key to be read. Define a maximum key count and byte budget, an eviction or rejection policy, and oversize-value behavior. Limit sweeper work per turn and avoid a long write lock during full-map scans.

Account separately for active bytes, retained expired bytes, and total allocated or estimated store bytes. Explain estimation limitations and include copied buffers where relevant. Do not claim zero GC or zero memory cost for JavaScript callers. Preserve compare-and-swap, counters, version monotonicity, and TTL behavior during removal.

Specify process scope: shared native memory across isolates in one process does not make the store distributed or persistent across cluster processes. Validate prefix enumeration, expired counters, and TTL conversion. Use a controllable clock for deterministic expiration tests instead of long sleeps.

Acceptance tests

Insert many unique keys with short TTLs, advance the clock, and verify allocations and stored entries are reclaimed without individual reads. Check stats before and after expiry and sweeping. Fill byte/key budgets and verify deterministic documented behavior. Test overwrite, delete, CAS races, counter TTLs, and concurrent readers during sweep.

Use a runtime soak test to verify RSS plateaus after warm-up for an agreed workload. Allow allocator retention when interpreting RSS but separately assert that logical native allocations and key counts do not grow without bound. Test isolation across processes and sharing across workers according to the actual contract.

Closure evidence

Provide expiration reclamation tests, budget behavior, corrected accounting, process-scope documentation, and sustained allocation measurements. A get returning undefined after TTL expiry does not prove memory reclamation.

14 MAL 011 VM contexts and execution controls

Priority P1 for advertised node:vm behavior. Primary file src/js/node/vm.js and any new native V8 context integration.

Evidence: createContext marks a plain object. runInContext constructs a Proxy that falls back to globalThis and runs eval through a Function. Options are ignored. This does not provide the separate V8 context semantics expected by many vm callers.

Required behavior

Define and publish the supported node:vm subset. For supported contexts, use actual V8 context facilities compatible with deno_core, or restrict the API and reject unsupported options. Context globals, declarations, and built-in identity must have predictable semantics. A context must not silently expose unrelated host globals through fallback.

Implement promised timeout and interruption behavior for infinite loops without breaking the owning isolate or leaving it permanently terminated. Assess microtask and asynchronous work separately from synchronous execution. Document limitations on import, code generation, cached data, and context options. Do not claim node:vm is a security sandbox; even native Node's API is not a boundary for hostile code.

Support Script and compileFunction semantics only where tested. Return actual cached data or explicitly mark it unavailable instead of returning an empty Buffer that implies successful caching. Unsupported options should produce structured errors rather than appear to work.

Acceptance tests

Run two contexts with independent global properties and lexical declarations. Check prototype and built-in relationships against the chosen Node reference. Evaluate code that mutates globals and verify only intended state changes. Test exceptions, return values, repeated Script execution, and supported compileFunction parameter behavior.

Execute a CPU infinite loop with a short timeout in a disposable test process, assert bounded termination, then verify subsequent execution remains possible where promised. Test async continuations, promise rejection behavior, invalid options, and module imports for the supported subset. Use an outer process deadline for every timeout test.

Closure evidence

Provide differential conformance results, context isolation tests, timeout/interruption evidence, and explicit unsupported behaviors. A Proxy that resolves variables from another object cannot be accepted as proof of V8 context isolation.

15 MAL 012 Accurate runtime telemetry

Priority P2. Primary files src/js/node/v8.js, src/production.rs, src/js/17_production.js, src/ops.rs, logger, and platform memory handling.

Evidence: the V8 shim includes fixed heap limits, heap-space sizes, handle sizes, and context counts. The optimizer already obtains some true V8 heap statistics. Production telemetry uses process-global request and connection counters; their meaning must be made explicit.

Required behavior

Expose actual V8 statistics through native ops where available. For values the engine cannot provide, omit them, return a documented unavailable representation, or reject the unsupported method; do not invent plausible values. Preserve units and numeric types expected by callers. Label isolate-local versus process-wide quantities.

Define request counts, active connections, inflight requests, rejected requests, queue occupancy, and error totals. A connection count is not an inflight-request count, especially with keep-alive and HTTP2. Update and decrement counters through error, cancellation, panic, disconnect, and shutdown paths. Distinguish worker aggregate memory, process RSS, V8 heap, and native allocations.

Keep container memory and CPU reporting consistent with cgroup v1/v2 limits, including unlimited sentinel values and fractional quotas. Define logging levels, JSON format, HTTP logging, and handling of failed output. Observability must not report a healthy state merely because a fabricated number lies below a threshold.

Acceptance tests

Allocate and release objects, query V8 stats, and compare supported fields with direct engine values. Verify heap limits respond to configured memory options. Test multiple isolates and process aggregate reporting. Do not demand immediate RSS reduction when the allocator retains pages; validate definitions and measured source.

Open keep-alive connections and send several requests, trigger rejected requests and handler exceptions, then disconnect and drain. Assert correct counter transitions and nonnegative counts. Test JSON and text logs, JSE_LOG precedence, closed output streams, and container limits in an actual constrained environment.

Closure evidence

Provide a metric dictionary including scope, source, units, and failure behavior; native-value tests; lifecycle counter tests; and container evidence. If fields are unsupported, update the compatibility matrix and consumers accordingly.

16 MAL 013 Compatibility program

Priority P2. Primary areas src/js/node, src/js web globals, src/loader.rs, tests/integration.rs, CLI tests, and framework fixtures.

Evidence: broad API surfaces and real package tests exist. Framework coverage is narrower than complete application-toolchain compatibility. No native addon ABI support was established by the review. process.version is an advertised compatibility identity, not a conformance certificate.

Required behavior

Create a versioned matrix listing each supported module/API, tested behaviors, partial behavior, unsupported options, package/version, test ID, platform, and verification SHA. Select exact Node reference versions and record actual versions in reports. Use official upstream documentation and upstream tests as primary sources. Keep dependencies pinned for repeatable package tests.

Add differential tests for module resolution, exports/imports conditions, CommonJS cycles, dynamic import, JSON, errors, Buffer views, streams, timers, nextTick, promise ordering, cancellation, filesystem errors, child processes, crypto, and Web APIs. The reviewed nextTick uses queueMicrotask; test event-order semantics rather than assuming Node equivalence.

Reject or clearly document unsupported native .node addons, N-API, and FFI. A package using pure JavaScript does not prove native addon support. Built-in replacements such as SQLite must identify their own API contract. Unknown modules and unsupported options must fail predictably.

Add real socket tests for Fastify and Express, including large/chunked bodies, middleware errors, and keep-alive. Preserve React/Vue/Preact SSR, Svelte compilation/server render, and Angular signals/DI tests. Describe those exactly. Validate full frameworks and their CLIs only when end-to-end projects are added.

Audit node:test behavior: suite hook scoping, test promises, nested tests, only, skip, todo, errors, concurrency options, and exit codes. A minimal TAP emitter must not imply the complete upstream test runner.

Acceptance and closure

Run the same fixture under Malia and each pinned Node reference and compare intended observable behavior. Normalize nondeterministic fields only with documented rules. Run on Linux, macOS, and Windows where claimed. Record platform-specific differences and package versions. Do not close discrepancies by changing expected output solely to match the implementation.

Close the program milestone when the matrix is accurate, critical backend semantics pass, framework scope is precise, and unsupported behavior fails explicitly. Ongoing compatibility remains a maintained release requirement.

17 MAL 014 Database resilience

Priority P2. Primary files tests/db/drivers.mjs, tests/db/package.json and lockfile, CI database services, socket/TLS/crypto compatibility modules.

Evidence: live database job in run 36863886274 passed. The suite exercises PostgreSQL authentication and types, ORMs, MySQL prepared and binary protocols, Redis pipelines/pubsub, MongoDB models and authentication, DynamoDB signing, Elasticsearch transport, and Cassandra prepared queries. These are valuable success-path tests, not comprehensive failure testing.

Required behavior

Preserve JSE_DB_REQUIRE_ALL behavior so missing required services or skipped drivers fail the dedicated job. Keep a per-driver package/version and exercised-feature record. Pin server images or versions appropriate for reproducibility and document upgrade policy.

Extend tests for TLS and custom CAs, pooled connections, transaction boundaries, rollback, cancellation, timeouts, large binary results, Unicode, numeric precision, streaming cursors, reconnects, abrupt socket closure, authentication rejection, server restart, and resource cleanup. Decide which capabilities each driver actually promises; do not demand nonexistent features from a package.

Separate driver initialization from readiness checks and fail with actionable messages. Isolate test data and credentials. Clean up even after failed assertions. Do not suppress driver errors or interpret a skipped server as a pass. Use controlled server restarts and fault injection in disposable CI services.

Acceptance tests

For PostgreSQL and MySQL, exercise multiple concurrent pooled operations, transactions, rollback, timeout, and reconnection after restart. For Redis, verify disconnect and resubscribe behavior and cancellation of blocked operations. For MongoDB, test cursor completion and cleanup. For DynamoDB, preserve signing and error handling. For Elasticsearch, test transport retries and large bodies. For Cassandra, test rejected and interrupted connections and prepared-query errors.

Run invalid-certificate and valid-custom-CA tests after MAL-005. Verify no leaked sockets, timers, or promises prevent exit. Record expected package retry behavior; runtime errors must be distinguishable from legitimate driver policy.

Closure evidence

Provide the live success suite plus resilience results, skip accounting, TLS evidence, and supported driver limitations. Do not claim automatic HA/failover support without topology-specific tests. Passing one query is sufficient evidence only for that tested query path.

18 MAL 015 Benchmarks and optimizer policy

Priority P2. Primary files bench/*.js, src/optimizer.rs, src/js/13_wasm_optimizer.js, cache/snapshot paths, and new benchmark tooling.

Evidence: HTTP benchmarks run server and load generator in the same process/runtime, mixing client and server costs. Short microbenchmarks lack sustained tail-latency and memory evidence. optimize calls V8 low_memory_notification, which requests reclamation; it is not a custom JS-to-Wasm optimizer.

Required behavior

Use an external fixed load generator for server comparisons. Separate startup, single-thread compute, crypto, filesystem, networking, worker messaging, worker compute, database requests, and real application scenarios. Compare identical application logic and protocol settings with pinned Malia/Node versions and reproducible hardware, CPU quotas, memory, OS, and build modes.

Record warm-up, independent repetitions, workload size, concurrency, offered load, errors, throughput, p50/p95/p99 latency, RSS, native memory, V8 heap, CPU, and event-loop delay. Exclude debug builds from headline release comparisons. Define measurement duration and statistical summary before running. Publish raw machine-readable results with environment metadata.

Benchmark caching both cold and warm. Verify output correctness so optimized-away loops do not become performance evidence. Benchmark SHA changes with algorithms, input sizes, call patterns, and dependency versions recorded. Do not generalize a hash microbenchmark to whole-runtime superiority.

Keep periodic forced GC optional unless measurements justify a default. Compare optimizer off/on with memory, latency, and CPU evidence. V8 Wasm tiering flags affect actual Wasm execution; they do not turn embedded JavaScript into Wasm. Document the policy and avoid unsupported speed or zero-GC claims.

Acceptance and budgets

Establish a checked-in budgets file before declaring a performance gate. Owner-approved budgets must define target hardware, normal and overload traffic, concurrency, maximum acceptable p99, error rate, memory ceiling, and allowed regressions. No fabricated universal target is supplied by this manual. Run a 30-minute minimum release-candidate soak and a longer scheduled soak where available, with explicit ownership and workload.

Close when results are reproducible, correctness is checked, memory is bounded, and optimizer policy follows measured tradeoffs. Keep claims limited to named workloads and environments.

19 MAL 016 Toolchain and CI stability

Priority P1 as a prerequisite to reliable validation. Primary files src/production.rs, Cargo.toml, Cargo.lock, build.rs, CI workflow, and a pinned toolchain configuration.

Historical evidence: run 36863886274 passed Windows and live database jobs. Linux and macOS failed Clippy at production.rs due to deprecated AtomicU64::fetch_update with -D warnings; their tests were skipped. Commit 06c56705465f2bae020ff17ed5f451be05f03821 replaces it with a compare_exchange_weak loop. Its CI was still running at review time. Recheck current status rather than reopening or closing automatically.

Required behavior

Pin a supported Rust toolchain for reproducible required checks. Optionally add a separate newer-toolchain canary. Preserve warnings-as-errors in the supported toolchain; fix deprecations without suppressing them globally. Verify the saturating decrement under concurrent operations and zero-count conditions.

Keep Cargo.lock committed and use --locked for reproducible builds and tests. Add cargo fmt --check where feasible and ensure CI covers Clippy, unit tests, CLI tests, integration fixtures, database tests, installer checks, and release packaging. Mirror build-time and runtime op dependencies deliberately because snapshot creation compiles op code separately.

Report skipped and ignored tests. Missing packages or services must not silently convert required suites into success. Use fixture installs from lockfiles where possible; keep separate intentional upgrade checks. Cache keys must not conceal dependency drift or stale snapshots. Verify runtime op signatures after native or bootstrap changes.

Acceptance tests

Run the full suite on pinned Linux, macOS, and Windows toolchains for claimed targets. Exercise atomic decrement at zero and under concurrent increments/decrements without underflow. Verify a clean rebuild after deleting build caches and a build with the lockfile unchanged. Validate snapshot startup for both binary aliases.

Inspect actual job logs and conclusions for the exact tested SHA. A green earlier commit does not establish the current tree. A Windows build passing without Unix Clippy does not establish all-platform validation.

Closure evidence

Provide toolchain versions, exact commands, exits, complete required job statuses, test/skip counts, lockfile state, and current SHA. Mark the historical deprecation as resolved only after its acceptance checks pass.

20 MAL 017 Distribution and governance

Priority P2. Primary files scripts/install.sh, scripts/install.ps1, .github/workflows/release.yml, nfpm.yaml, scripts/installer.iss, npm packages, README, and engineering documentation.

Evidence: installers gained SHA256SUMS verification and binary execution checks. Commit 44be6e0 added Debian/RPM and Windows installer packaging. The release-list query during the review returned no entries despite a successful earlier Release workflow; published assets and download URLs therefore require direct verification, not assumptions based on workflow names.

Required behavior

Build each promised archive/package for its actual architecture and execute a smoke test on an appropriate target. Verify checksums, installer behavior, runtime dependencies, supported libc/OS versions, and alias behavior. For packaging workflow_dispatch, derive a valid version/tag explicitly; a branch name must not accidentally become a package version or public release tag.

Test shell and PowerShell installers in disposable destinations. Test unavailable release, wrong checksum, partial download, missing archive entries, path with spaces, repeated install, upgrade, and uninstall behavior. Preserve current-shell instructions and directory creation. A checksum verifies file integrity against the release manifest; it is not independent publisher authentication. Record provenance or signing policy if implemented.

Validate actual release assets and README links before describing them as available. Do not advertise npm installation until the packages and platform dependencies are published and tested. Audit bundled third-party licenses and include required notices; the Cargo MIT declaration alone does not replace license files and dependency notices.

Continuing source of truth

When implementing, maintain docs/engineering/malia-remediation.md, remediation-ledger.json, compatibility-matrix.md, and benchmark-budgets.json, or equivalent existing paths. The reviewed Word manual is the baseline; the owner-approved versioned repository specification becomes the operational source as changes land. Keep stable MAL IDs in commits, tests, and release notes.

Change a requirement only with a recorded reason, scope effect, evidence, and owner decision where behavior or product commitments change. Verified issues can reopen after a regression. Future features need a contract, resource budget, failure model, regression tests, and truthful documentation before release.

Closure evidence

Provide published-asset verification, clean installation evidence, notices, accurate docs, and a maintained ledger. An artifact generated in CI is not automatically an available release.

21 Validation and release gates

Baseline commands

Use the repository's supported commands after checking current instructions. The reference command set is: git rev-parse HEAD; git status --short; rustc --version; cargo --version; cargo fmt --all -- --check; cargo clippy --locked --all-targets -- -D warnings; cargo test --locked; cargo build --locked --release --bins. Run independent commands separately and record exits. fmt or strict flags may reveal existing problems; fix or accurately classify them rather than hiding failures.

Install framework/example dependencies using existing lockfiles. For the database suite, use npm ci --prefix tests/db and the documented server variables. Require all drivers in the dedicated CI job. Invoke the built runtime with run --allow-all tests/db/drivers.mjs only inside the disposable test setup; these grants are for that fixture, not a production recommendation.

Required gates

Gate A Current baseline. Exact SHA, toolchain, platform, clean/dirty tree, known failures, and dependencies recorded.

Gate B Correctness and permissions. MAL-001, MAL-002, MAL-005, MAL-007 and affected MAL-008 regressions pass under Malia. Unsupported behavior fails explicitly. No fabricated security or context state.

Gate C Resources and lifecycle. MAL-006 budgets, MAL-009 leases, MAL-010 expiry, shutdown, cancellation, queue saturation, and leak tests pass. Native and V8 memory are both considered.

Gate D Public contract. MAL-003, MAL-004, MAL-011, MAL-012 and the compatibility matrix match behavior. No unsupported compilation, sandbox, TLS, or Node-conformance claims.

Gate E Ecosystem. Required live database and defined framework tests pass on supported targets. Failure and TLS paths are tested for claimed capabilities. Skips are visible and justified.

Gate F Distribution. Release artifacts install and run in clean environments. Checksums, aliases, dependencies, notices, and docs links are correct for the candidate.

Gate G Performance. External-load results, correctness checks, approved budgets, and release-candidate soak evidence exist. No unexplained material regression or unbounded growth.

Release decision

Do not label the entire runtime production-ready while any P0 is open. A P1 blocks the affected advertised feature; it may remain excluded only through a visible support restriction and owner decision. Production readiness applies to the tested workloads and platforms. Do not manufacture a passing status when infrastructure is unavailable: mark the gate blocked and preserve runnable tests plus the exact missing prerequisite.

22 Evidence ledger and completion reports

Required ledger fields

For every MAL ID record title, priority, status, evidence class, baseline SHA, current SHA, affected files, owner, dependencies, reproduction command, expected and actual behavior, test paths, commands and exits, platform/version coverage, documentation changes, commit/PR references, remaining limitations, and last verification date. Preserve original findings when a fix lands; append resolution evidence.

Status definitions

Open means the requirement is not yet satisfied. Reproduced means a failing check exists for current source. In progress means code or tests are being changed. Blocked means an explicit prerequisite is missing. Verified means the current SHA satisfies the acceptance tests and documentation contract. Scope restricted means the affected capability is explicitly unsupported; it is not full feature completion. Reopened means a formerly verified requirement regressed.

Never equate implemented with verified. A simulated transport test verifies scheduling logic only; a local module reproduction verifies that source in its stated host environment. Add Malia runtime evidence before full closure. Historical CI evidence must name its SHA and job.

Report after each cohesive change

State the affected MAL IDs, trigger and user-visible before/after behavior, root cause, final implementation, tests and observed results, platform coverage, documentation changes, and unresolved limits. Include the commit or PR identifier if created. Keep abandoned approaches only when they explain a material tradeoff.

If a test is skipped, record why and what remains unverified. If a requirement is contradicted by current code, show the source and a test establishing its actual behavior. If dependencies prevent full implementation, preserve the remaining work precisely enough for another session to continue.

Final completion report

List every requirement with its status and evidence. Confirm each release gate separately. Identify the exact reviewed SHA and candidate artifact version. Summarize behavior changes and migrations for queue files, packaged executables, permissions, API compatibility, and command names. List operational defaults and budgets. Separate ready workloads from unverified workloads.

Do not end after a plan when implementation is authorized. Do not declare every issue fixed because compilation succeeds. Do not rewrite the ledger to omit unresolved findings. Keep the next actionable step for every blocked or open item.

Maintenance cadence

Reconcile the ledger after each relevant change and before every release. Review compatibility claims when dependency or Node reference versions change. Re-run resource and performance gates after scheduler, streaming, crypto, allocator, cache, or optimizer changes. Recurring automation must be explicitly requested by the owner; this manual defines policy, not an automatic schedule.

23 Reproduction fixtures for Codex

Async context regression

Put this fixture into the real runtime test suite and run it under both Malia and pinned Node. Expected stores are A and B; immediately outside run the store is undefined. Use a supported assert module and an outer timeout. The review observed B and B from the original module loaded under Node.

import assert from 'node:assert/strict';

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

let release;

const gate = new Promise(r => { release = r; });

const a = als.run('A', async () => {

  await gate; return als.getStore();

});

const b = als.run('B', async () => {

  await gate; return als.getStore();

});

assert.equal(als.getStore(), undefined);

release();

assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);

Worker pool runtime regression

Use a size-one pool. The worker receives a tagged input. For ordinary work, send one tagged reply. For stream work, send two tagged replies and then the current completion sentinel. Start an ordinary job, use a barrier to keep it busy, then call next on the queued stream iterator. Release the ordinary job. The stream must yield only its two expected replies and finish without errors or hanging.

Repeat with a break after the first stream reply and immediately submit another task. It must not receive a leftover reply from the previous task. The review's simulated transport reproduced an undefined-worker error; add this real-worker fixture before closure.

Queue ownership regression

Use a file-backed queue. A claims a job with a controllable short lease. Advance time beyond expiry and let B reclaim. Use A's old token to ack, nack, and renew. All must fail without changing B's ownership or payload. B's valid token succeeds. Repeat with process restart and terminal retry limits.

Other mandatory reproductions

Create a strict permission typo fixture that fails before user code. Create a real TLS server fixture checked by an independent client. Compile an import-heavy application and launch only its executable in an empty directory. Run a source-container Wasm output in an independent engine to document its actual semantics. Overlap tracing scopes and assert separate roots and ancestry. Test these observable behaviors instead of mirroring private implementation details.

24 Source references and claim checklist

Reviewed source and CI

Repository https://github.com/loreste/malia

Baseline commit https://github.com/loreste/malia/commit/44be6e05623a09d4c5fc7a2dbc07b51bbff97f80

Runtime and installer update https://github.com/loreste/malia/commit/819ac06f2d5adf3f38641e2e7b1e39fee2292065

Atomic correction https://github.com/loreste/malia/commit/06c56705465f2bae020ff17ed5f451be05f03821

Completed CI with database success and Unix Clippy failure https://github.com/loreste/malia/actions/runs/36863886274

Earlier all-job CI success https://github.com/loreste/malia/actions/runs/36785146232

Read source paths in this manual against the baseline commit, then compare with current HEAD. Links and line numbers can change; stable MAL IDs and exact SHAs preserve the evidence trail.

Claim checklist before publishing

JavaScript support names the actual V8 version and tested language features. TypeScript support states whether it transpiles or type-checks. Node compatibility lists versions, behavior scope, and unsupported APIs. Worker concurrency distinguishes one-isolate execution from explicit parallel workers. Database support names tested driver and server versions and distinguishes success paths from resilience.

Wasm execution distinguishes genuine module execution, arithmetic synthesis, Malia source containers, and any future portable compiler. Native executable packaging distinguishes entry embedding from complete dependency bundling and states permission and platform limitations. TLS methods report real negotiated data and server security behavior. Streaming claims correspond to real backpressure and bounded buffering.

VM contexts never become a claim of safe hostile-code execution. Tracing claims distinguish context propagation, serialization, and collector transport. Metrics state their scope and measured source. KV claims state process scope, persistence, expiration, and memory behavior. Queue claims state delivery, lease, retry, and durability semantics. Performance claims identify workload, environment, methodology, and raw evidence.

Evidence handling

The source-level findings and focused reproductions in this baseline are actionable engineering inputs. Validate each against the current runtime before final closure. Additional acceptance requirements are remediation specifications, not assertions that their failure was already observed. Use official upstream documentation, specifications, and tests when implementing behavior; record versions and retrieval dates in the repository evidence.

Owner decisions to record

Record the supported Node reference versions, acceptable public API changes, permission precedence, queue retry semantics, HTTP resource defaults, target platforms, performance budgets, and whether portable JS-to-Wasm compilation belongs in a separate project. Make routine implementation choices within the authorized scope. Escalate only decisions that materially change the agreed product contract or require unavailable authorization.
