# Changelog

All notable changes to Malia are documented here.

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
