# Changelog

All notable changes to Malia are documented here.

## [0.3.0] - 2026-11-25

### Added

#### Speed
- **Stream HWM bumped to 64KB** (from 16KB): matches Node v22, free throughput win for file I/O and HTTP streaming.
- **Faster npm install**: parallel metadata prefetch downloads all registry metadata concurrently before resolving, eliminating the HTTP waterfall for large dependency trees.

#### Security
- **`--deny-net` flag**: block specific hosts even under `--allow-all`. Port-level granularity. Protects against IMDS attacks (`--deny-net=169.254.169.254`).
- **`--sandbox` mode**: combines deny-all permissions + 256 MB heap limit + 30s CPU limit. For running untrusted code.
- **`--max-cpu-time`**: watchdog thread terminates the isolate after the specified seconds. Prevents infinite loops in plugins/user scripts.
- **`--max-old-space-size` wired to V8**: was parsed but never applied. Now correctly limits V8 heap.
- **SHA-512 lockfile integrity**: lockfile always includes SHA-512 integrity hashes (computed if registry doesn't provide them). Upgraded from SHA-1 only.

#### Built-in Clients
- **`malia.redis(url?)`**: built-in Redis client with RESP2 protocol, connection pooling, pipelines, 30+ commands (GET, SET, DEL, MGET, MSET, INCR, EXPIRE, TTL, lists, hashes, sets, pub/sub). Eliminates `ioredis` (13M weekly).
- **`malia.s3(options)`**: built-in S3 client with SigV4 signing. GET, PUT, DELETE, presigned URLs. Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces. Eliminates `@aws-sdk/client-s3`.

#### Developer Tools
- **`malia.$\`cmd\``**: shell scripting via tagged template literals. Interpolation with automatic escaping, `$.nothrow` for non-throwing variant. Replaces `zx`, `execa`, `shelljs`.
- **`malia.yaml` / `malia.toml`**: built-in YAML and TOML parse/stringify. Eliminates `js-yaml` (70M weekly).
- **`fs.glob()` / `fs.globSync()`**: native glob matching via Rust `glob` crate (Node v22 parity). Eliminates `fast-glob` (100M+ weekly).
- **`malia fmt`**: downloads and runs dprint on first use. `--check` for CI. Eliminates `prettier`.
- **`malia lint`**: downloads and runs oxlint on first use. `--fix` for auto-fix. 50-100x faster than eslint.
- **`malia bundle`**: basic ESM bundler. Resolves relative imports, strips import/export, concatenates into a single IIFE.
- **`malia verify`**: checks SHA-256 of the running binary against published release checksums.
- **`malia compile --target`**: cross-compilation by downloading the target platform's binary from GitHub releases. Supports linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64.

#### Node Compatibility
- **`require(esm)` support**: CJS files can now `require()` ESM modules (Node v23 parity). Lightweight ESM-to-CJS transform on SyntaxError fallback.

#### Test Runner
- **Glob-based test discovery**: automatically finds `**/*.test.ts`, `**/*.spec.ts`, `tests/**/*.ts`.
- **`--watch` flag**: re-runs tests when files change.
- **`t.snapshot(value)`**: snapshot testing with auto-create on first run. `UPDATE_SNAPSHOTS=1` to update.

## [0.2.2] - 2026-11-13

### Fixed
- **zlib streams crashed the process when destroyed during their final flush**: the flush closed the already-closed native stream and threw outside any handler. Next.js hit this when a browser navigated away while a compressed page was finishing. The stream is now closed exactly once.

## [0.2.1] - 2026-11-13

### Fixed
- **`res._implicitHeader()` hung the response** (since 0.1.7): it marked the response as started without sending the status and headers, so the next write was dropped and the request never completed. Next.js calls it before streaming every page, so Next.js apps timed out on every request. It now sends the status and headers, as in Node.

## [0.2.0] - 2026-11-13

### Added
- **N-API native addon support**: full Node-API v1-v9 function table (149 extern C functions). Loads `.node` files via `dlopen`, bridges to V8 through deno_core's PinScope. Covers value creation, property access, function calls/callbacks, error handling, reference management, buffer operations, async work, and thread-safe functions. Tested with a C addon exercising the core surface.
- **Rust-level HTTP response cache**: responses with `Cache-Control: public, max-age=N` are cached in the hyper thread. Cache hits skip the JS hop entirely (~0us vs ~100-200us). Opt-in via standard HTTP headers.
- **TLS server support**: `tls.createServer({cert, key})` works via `op_tls_listen` with rustls. Async TLS handshake per connection.
- **Local tarball install**: `malia install ./pkg.tgz` and `file:path` specifiers work. Nonexistent paths error instead of silent success.
- **`jse` binary retired**: only `malia` ships now. `jse.*` JS globals remain as aliases.

### Fixed
- Cluster duplicate `online` events (guard on worker state)
- Cache: oversized entries rejected instead of exceeding `maxSize`
- Cache: `staleWhileRevalidate` triggers background refresh
- HTTP bodiless methods (GET/HEAD/OPTIONS/DELETE) skip body collection

### Changed
- Performance claims in README based on independent benchmark results
- Framework compatibility documented with specific tested vs untested features
- `--wasm` compile described accurately as source packaging

## [0.1.9] - 2026-11-12

### Added
- **Built-in package manager**: 25 npm commands, lockfile generation, peer/optional/bundled deps, download cache, `.npmrc` auth
- **`npm` / `npx` / `node` shims**: created on install, no separate Node.js needed
- **Concurrency primitives**: `malia.parallel.map`, `.filter`, `.each`, `.reduce`, `.race`, `.any`, `.pool`, `.pipeline`
- **Async locks**: `malia.mutex()`, `malia.semaphore(n)`
- **Utilities**: `malia.retry`, `malia.timeout`, `malia.batch`, `malia.debounce`, `malia.throttle`
- **Cron scheduler**: `malia.cron("*/5 * * * *", fn)` with 5/6-field expressions, helpers, job control
- **Security middleware**: `jse.secure()` (HSTS, CSP, etc.), `jse.rateLimit()`, `jse.cors()`
- **Security CLI**: `malia scan`, `malia secrets`, `malia permissions`, `malia sbom`, `malia deps --licenses`
- **Developer tools**: `malia doctor`, `malia serve .`, `malia clean`, `malia upgrade`, `malia env`
- **Auto `.env` loading** at startup (replaces dotenv)
- **Deployment**: `malia deploy` generates Dockerfile, docker-compose.yml, systemd service
- **Profiling**: `malia profile <file>` V8 CPU profiling with top-functions report
- **Database migrations**: `malia migrate create/up/down/status` with SQLite-tracked state
- **Env encryption**: `malia env-encrypt encrypt/decrypt` AES-256-GCM for `.env` files
- **Pub/Sub**: `malia.pubsub()` in-process pub/sub with pattern matching, history, async iterators
- **Cache**: `malia.cache()` LRU with TTL, size limits, `getOrSet` cache-aside with dedup, `memoize`
- **Node.js APIs**: `EventEmitter.captureRejections`/`errorMonitor`/`setMaxListeners`/`addAbortListener`, `crypto.hkdf`/`hkdfSync`/`X509Certificate`, `util.parseArgs`/`styleText`/`MIMEType`, `Module._resolveFilename`/`_load`, `process.report`/`getBuiltinModule`/`abort`/`allowedNodeEnvironmentFlags`, `ChildProcess.ref`/`unref`, `test.mock`, `Buffer.allocUnsafeSlow`/`swap64`, `fs.chown`/`chownSync`

### Security
- `setTimeout("string")` blocked (eval-based code injection)
- Tarball extraction hardened: symlinks/hardlinks rejected, paths canonicalized
- HTTP request smuggling mitigated (conflicting CL+TE)
- Hot-reload restricted to project directory
- Lifecycle scripts disabled by default (`MALIA_SCRIPTS=1` to enable)

## [0.1.8] - 2026-11-11

### Added
- **AI toolkit** (`malia.ai`): auto-detects local LLMs (Ollama, vLLM, LM Studio), supports frontier models (OpenAI, Anthropic, Google, Mistral, Groq, xAI)
- **Hot module replacement**: `server.hot("./handler.mjs")` for zero-downtime code swaps
- **OpenTelemetry**: `autoInstrument()` wraps fetch, `instrumentedHandler()` wraps serve handlers
- **Body streaming**: request bodies > `maxBodyBytes` stream through channels
- **HTTP connection pooling**: `Agent({ keepAlive: true })` with socket reuse

### Fixed
- 80+ bug fixes across Buffer, HTTP, crypto, streams, EventEmitter, URL, fs, timers, net, zlib, fetch
- Response.clone() throws on consumed body per WHATWG spec
- Router crash on relative URLs
- Serve timeout configuration (serde aliases)
- Header overflow protection (16KB)
- CRLF validation in setHeader (security)

## [0.1.7] - 2026-10-27

### Fixed
- HTTP server: client disconnect mid-response no longer crashes
- Buffer: toString() negative start, unknown encoding, multi-byte write splitting
- process.hrtime() seconds 1000x too large
- process.stdin: emits Buffer instead of Uint8Array
- fs error objects missing .code property
- HTTP client: IncomingMessage async iterator, pipe() {end: false}
- net.Socket: Unix path normalization, _write after destroy crash
- serve: proper error status codes (413, 408, 502, 504, 503)

### Changed
- Linux builds target glibc 2.28+ (RHEL 8+, Debian 10+, Ubuntu 20.04+)
- .deb and .rpm packages for x64 and arm64

## [0.1.6] - 2026-10-19

### Added
- `mainModule`, `module.loaded`, `require.cache` support
- EPIPE handling on stdout/stderr

### Fixed
- EPIPE on stdout/stderr produces Node-compatible error

## [0.1.4] - 2026-10-15

### Fixed
- EPIPE error handling improvements

## [0.1.3] - 2026-10-14

### Fixed
- Stability improvements

## [0.1.2] - 2026-10-14

### Fixed
- Build and packaging fixes

## [0.1.1] - 2026-10-13

### Fixed
- Initial bug fixes after launch

## [0.1.0] - 2026-10-01

### Added
- Initial release
- V8 15.0 via deno_core 0.412
- TypeScript transpilation (SWC, cached)
- Node.js module compatibility (CommonJS + ESM)
- HTTP server (hyper 1.x on separate thread pool)
- Worker and WorkerPool with structured clone messaging
- Bounded channels with backpressure
- Permissions (deny-by-default)
- Built-in SQLite, KV store, task queue, router
- Structured logging, tracing, metrics
- WebSocket client and server
- WebAssembly (WASI Preview 1)
- V8 inspector (--inspect / --inspect-brk)
- Standalone executable compilation
