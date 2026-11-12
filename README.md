# Malia

JavaScript and TypeScript runtime built in Rust. Same V8 engine as Node,
runs npm packages, ships its own package manager. HTTP is handled by hyper
on a dedicated thread pool, which is where the speed comes from -- your JS
still runs on V8, same as Node.

**What's actually faster (independently verified):**

- **Startup: ~2.4x faster** -- V8 heap snapshot, no bootstrap overhead.
  Confirmed by independent testing (median 9.5ms vs 23ms).
- **Worker spawn: ~2.5x faster** -- isolate reuse, not fork. First message
  arrives in ~3.6ms vs ~9ms on Node.
- **Connection churn: on par** -- hyper handles new-connection-per-request
  as fast as Node's libuv.

**What depends on hardware:**

- **HTTP keep-alive throughput** -- our thread pool architecture benefits
  from multiple cores. On a 2-core machine, Node's single-threaded event
  loop can be faster for keep-alive workloads because there's no
  cross-thread channel hop. On machines with 4+ cores, the thread pool
  has room to spread. Benchmark on your target hardware.
- **Memory** -- with identical JS workloads the heap is the same (same V8).
  RSS is slightly lower (~5-10%) due to a leaner process. The larger
  savings come from using malia-specific features (KV store, off-heap
  caching) instead of JS objects.

**What's the same:** CPU-bound JavaScript runs at the same speed -- it's
the same V8 engine. Malia doesn't make your JS faster, it makes the
surrounding infrastructure (startup, HTTP, workers) faster.

**N-API native addons (partial):** `.node` files are loaded via `dlopen`
and the `napi_register_module_v1` symbol is verified. Addons that fail
to load throw `ERR_DLOPEN_FAILED` so try/catch fallback patterns (e.g.
Next.js SWC native to WASM) work. The N-API function table (the C
functions addons call to create JS values) is not yet wired up, so
addons that call `napi_create_string` etc. won't work yet. Packages
like `bcrypt` and `sharp` need the full function table -- see
[Limitations](#limitations).

**Things you don't need to install separately:**

- Package manager (`npm install`, `npx`, lockfiles, publish)
- `.env` loading (auto at startup)
- Cron (`malia.cron("*/5 * * * *", fn)`)
- Concurrency control (`malia.parallel.map`, mutex, semaphore)
- LRU cache with TTL (`malia.cache`)
- Pub/sub (`malia.pubsub`)
- Security headers, rate limiting, CORS (`jse.secure`, `jse.rateLimit`, `jse.cors`)
- Security scanning (`malia scan`, `malia secrets`, `malia sbom`)
- Deployment scaffolding (`malia deploy` -> Dockerfile, systemd)
- CPU profiling (`malia profile`)
- Database migrations (`malia migrate`)
- Encrypted env files (`malia env-encrypt`)
- SQLite, KV store, task queue, router, tracing, structured logging
- TypeScript (transpiled at load, cached on disk)

**Architectural differences from Node:**

- HTTP server runs on hyper (Rust) on its own thread pool, not on the JS event loop
- Workers get real OS threads with their own V8 isolates
- Permissions are deny-by-default (like Deno, unlike Node)
- Bounded channels (`chan()`) with backpressure for async coordination
- Hot reload swaps handlers on a live server without restarting

The `jse.*` globals are aliases of `malia.*` for backward compatibility.
New code should use `malia.*`.

Guides for common tasks are in [docs/HOWTO.md](docs/HOWTO.md).

## Installation

Prebuilt binaries for macOS, Linux, and Windows. No Rust or build
tools required.

**macOS / Linux (one-liner)**

```sh
curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh
```

Installs `malia`, `jse`, `npm`, `npx`, and `node` to `~/.malia/bin` and adds
it to `PATH`. The `npm`, `npx`, and `node` commands are built into malia --
no separate Node.js installation required.

**Debian / Ubuntu (.deb)**

```sh
VERSION=$(curl -fsSL https://api.github.com/repos/loreste/malia/releases/latest | grep tag_name | cut -d'"' -f4 | tr -d v)
curl -fsSLO "https://github.com/loreste/malia/releases/latest/download/malia_${VERSION}_amd64.deb"
sudo dpkg -i "malia_${VERSION}_amd64.deb"
```

**Fedora / RHEL / CentOS (.rpm)**

```sh
VERSION=$(curl -fsSL https://api.github.com/repos/loreste/malia/releases/latest | grep tag_name | cut -d'"' -f4 | tr -d v)
curl -fsSLO "https://github.com/loreste/malia/releases/latest/download/malia-${VERSION}-1.x86_64.rpm"
sudo rpm -i "malia-${VERSION}-1.x86_64.rpm"
```

Packages install `malia` and `jse` to `/usr/bin`.

**Windows**

```powershell
irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex
```

**Manual download**

Archives and `SHA256SUMS` are attached to each
[GitHub release](https://github.com/loreste/malia/releases); pushing a `v*`
tag builds them (`.github/workflows/release.yml`):

| Platform | Archive |
|---|---|
| macOS arm64 | `malia-darwin-arm64.tar.gz` |
| macOS x64 | `malia-darwin-x64.tar.gz` |
| Linux x64 (glibc) | `malia-linux-x64-gnu.tar.gz` |
| Linux x64 (musl) | `malia-linux-x64-musl.tar.gz` |
| Linux arm64 | `malia-linux-arm64-gnu.tar.gz` |
| Linux x64 (.deb) | `malia_<version>_amd64.deb` |
| Linux x64 (.rpm) | `malia-<version>-1.x86_64.rpm` |
| Linux arm64 (.deb) | `malia_<version>_arm64.deb` |
| Linux arm64 (.rpm) | `malia-<version>-1.aarch64.rpm` |
| Windows x64 | `malia-win32-x64.zip` |

Linux glibc builds (archives, .deb, .rpm) run on glibc 2.28 or newer: RHEL/Alma/Rocky 8+,
Debian 10+, Ubuntu 20.04+. The musl build has no glibc requirement.

Releases: set the version in `Cargo.toml`, run `scripts/version.py sync` (npm packages),
then push the matching `v<version>` tag; the release refuses mismatched versions.

**From source**

```sh
cargo build --release
```

Produces `target/release/malia` and `target/release/jse`. `build.rs`
compiles `src/ops.rs` a second time to produce the startup snapshot, so the
first build compiles `deno_core` and its dependencies twice.

## Usage

```sh
malia run examples/hello.ts                     # run a TypeScript file
malia run --allow-net examples/server.js        # HTTP server
malia eval --allow-all 'console.log(6*7)'       # evaluate a snippet as an ES module
malia                                           # REPL (supports top-level await)

malia compile examples/hello.ts -o dist/hello   # host-platform entry-source embedding
malia compile --wasm examples/hello.ts -o app.wasm
malia run app.wasm
```

### Commands

| Command | Description |
|---|---|
| `malia` | Run the entry point from the project config (see [Configuration](#configuration)); opens the REPL if none is found |
| `malia run <file\|dir>` | Run a `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`, `.jsx`, or `.wasm` file. `--watch` restarts on file changes; `--wasm` selects Wasm-related runtime options; JavaScript still runs in V8 |
| `malia eval <code>` | Evaluate a snippet as an ES module |
| `malia repl` | Start the REPL |
| `malia init [--toml]` | Create a project config file |
| `malia dev` | Run the entry point and restart on file changes |
| `malia start` | Run the entry point; forks cluster workers when `cluster` is configured |
| `malia test` | Run tests (`node:test`, TAP output) |
| `malia install` / `add` / `i` | Install packages from the npm registry (built-in or delegates to npm/yarn/pnpm) |
| `malia install -g <pkg>` | Install a package globally to `~/.malia/bin` |
| `malia uninstall` / `rm` | Remove packages from `node_modules` and `package.json` |
| `malia list` / `ls` | List installed packages |
| `malia outdated` | Show packages with newer versions available |
| `malia audit` | Check installed packages for known vulnerabilities |
| `malia link [dir]` | Symlink a local package into `node_modules` or globally |
| `malia x <bin>` | Run a binary from `node_modules/.bin`, falling back to npx |
| `malia npm <args>` | Pass arguments through to npm |
| `malia config [show\|get <key>]` | Print the resolved configuration |
| `malia compile <file>` | Embed source in the runtime binary. `--wasm` wraps source in a Wasm container (still needs malia to run — this is packaging, not JS-to-Wasm compilation) |
| `malia build` | Embed the configured entry source in the host runtime |
| `malia bench <file>` | Run a file and print its wall-clock time |
| `malia serve [dir]` | Instant static file server with directory listing, ETags, MIME types |
| `malia doctor` | Diagnose project health: deps, lockfile, config, security checks |
| `malia clean [--all]` | Remove `node_modules`, caches, temp files; `--all` clears global cache |
| `malia upgrade` | Check for and install the latest malia version |
| `malia env` | Show resolved environment variables from `.env` files and config |
| `malia scan [path]` | Scan source code for security vulnerabilities |
| `malia secrets [path]` | Find leaked API keys, tokens, and credentials |
| `malia permissions <file>` | Show what permissions a script needs before running it |
| `malia sbom` | Generate a CycloneDX SBOM for compliance audits |
| `malia deps [--tree] [--licenses]` | Dependency tree with sizes and license breakdown |
| `malia deploy [docker\|compose\|systemd\|all]` | Generate production deployment files |
| `malia profile <file>` | CPU profiling with V8 inspector, top-functions report |
| `malia migrate [create\|up\|down\|status]` | Database migration runner with SQLite-tracked state |
| `malia env-encrypt [encrypt\|decrypt]` | AES-256-GCM encryption for `.env` files |
| `malia <script>` | Run a script defined in the config file or `package.json` |

### Package management

Malia includes a built-in package manager. No separate npm or Node.js
installation is needed. When you install malia, `npm` and `npx` commands
are created automatically and route to the built-in installer.

```sh
# These all work out of the box, no Node.js required:
npm install express            # install a package
npm install -g http-server     # install globally
npm uninstall lodash           # remove a package
npm init -y                    # create package.json
npm ls                         # list installed packages
npm run dev                    # run a script
npm test                       # run tests
npx cowsay hello               # execute a package binary

# Or use the malia equivalents:
malia install express
malia install -g http-server
malia uninstall lodash
malia list
```

The built-in package manager supports the full npm workflow: lockfile
generation (`package-lock.json` v3), semver resolution, peer dependencies,
optional dependencies, bundled dependencies, download caching
(`~/.malia/cache`), and `.npmrc` auth for private registries. Lifecycle
scripts (`postinstall`) are disabled by default for security -- set
`MALIA_SCRIPTS=1` to enable.

If an external package manager (npm, yarn, pnpm) is detected via lockfile,
malia delegates to it. Otherwise the built-in installer handles everything.

All 25 npm commands are supported: `install`, `uninstall`, `update`, `list`,
`outdated`, `audit`, `init`, `link`, `pack`, `publish`, `prune`, `dedupe`,
`rebuild`, `cache`, `config`, `info`, `fund`, `whoami`, `prefix`, `root`,
`exec`, `run`, `test`, `start`, `version`.

```sh
NPM_REGISTRY=https://registry.internal.com malia install   # private registries
MALIA_INSTALL_SHIMS=1 # create npm/npx/node shims even if system versions exist
```

### Node-compatible flags

`-r/--require`, `--import`, `-e/--eval`, `-p/--print`, `-c/--check`,
`-i/--interactive`, `-v/--version`, `--no-warnings`, `--max-old-space-size`,
`--inspect[=host:port]`, `--inspect-brk[=host:port]`,
and `--enable-source-maps` are accepted. Flags in `NODE_OPTIONS` are read as
well. `process.version` is `v26.12.0`, and when invoked through a `node`
symlink, `--version` prints the same.

### Debugging

```sh
malia --inspect run app.js              # start inspector on 127.0.0.1:9229
malia --inspect-brk run app.js          # pause before first line
malia --inspect=0.0.0.0:9230 run app.js # custom host/port
```

Open `chrome://inspect` in Chrome or attach VS Code's debugger
(`"type": "node"` launch config). The runtime prints the WebSocket URL
on stderr. Breakpoints, stepping, console, heap snapshots, and CPU
profiling all work through V8's built-in inspector.

## Permissions

`malia run` denies all capabilities by default. The REPL runs without
restrictions. Grant access per category:

```sh
malia run --allow-read script.js                  # all filesystem reads
malia run --allow-read=/tmp,/data script.js       # reads under these paths only
malia run --allow-write=/tmp script.js            # filesystem writes
malia run --allow-net script.js                   # fetch, jse.serve, node:http
malia run --allow-net=api.example.com script.js   # these hosts only
malia run --allow-run=node,git script.js          # these executables only
malia run --allow-env script.js                   # environment variables
malia run --allow-all script.js                   # everything
```

A denied call throws `PermissionDenied: <kind> access to <what>, run again
with <flag>`. Without `--allow-env`, `process.env` is empty instead of
throwing. Module imports are not checked (same as Deno). Checks apply to
runtime fs (including SQLite databases), fetch (every redirect hop), serve,
WebSocket, child_process, and env operations. Workers inherit the process
permissions.

Path lists are compared after resolving `..` and symlinks, including
symlinks whose target does not exist yet. `--allow-run` entries are resolved
to executables through `PATH`, and a spawn is allowed only if the program it
would actually run (looked up in the child's `PATH` and `cwd`) is one of
them.

## Configuration

The runtime looks for, in order: `malia.json`, `malia.toml`,
`malia.config.json`, `jse.json`, `jse.toml`, `jse.config.json`, then falls
back to `package.json`. JSON config files accept comments and trailing
commas.

```jsonc
{
  "name": "my-app",
  "version": "1.0.0",
  "entry": "src/index.ts",
  // ${VAR:-default} is expanded
  "env": {
    "PORT": "3000",
    "API_URL": "http://localhost:${PORT:-3000}/v1"
  },
  // "all", "strict", or an object with read/write/net lists
  "permissions": "all",
  "paths": { "@/*": "./src/*" },
  // "cluster": "auto",
  "scripts": {
    "dev": "jse dev",
    "start": "jse start",
    "test": "jse test"
  },
  "production": { "port": 3000, "metrics": true, "logLevel": "info" }
}
```

Equivalent `jse.toml`:

```toml
name = "my-app"
version = "1.0.0"
entry = "src/index.ts"
permissions = "all"

[env]
PORT = "3000"

[paths]
"@/*" = "./src/*"

[scripts]
dev = "jse dev"
start = "jse start"
```

## Architecture

```
┌──────────────────────────── malia process ─────────────────────────────┐
│                                                                        │
│  CLI (clap)                                                            │
│    malia run <file> ─┐                                                 │
│    malia eval <code> ┼──► multi-thread tokio runtime (supervisor)      │
│    malia (REPL)     ─┘        │ spawn_blocking                         │
│                               ▼                                        │
│              main OS thread w/ current-thread tokio runtime            │
│                             │                                          │
│                    ┌────────▼─────────┐      ops (op2)                 │
│                    │ JsRuntime (V8    │ ──► op_sleep / op_read_file…   │
│                    │  isolate #0)     │ ──► op_chan_* (tokio mpsc)     │
│                    │  + startup       │ ──► op_worker_*                │
│                    │    snapshot      │ ──► op_crypto_* / op_url_*     │
│                    │  + module loader │ ──► op_fetch (reqwest+rustls)  │
│                    └────────┬─────────┘                                │
│                             │ new Worker(path) / WorkerPool            │
│        ┌────────────────────┼────────────────────┐                     │
│        ▼                    ▼                    ▼                     │
│  worker thread        worker thread        worker thread               │
│  current-thread rt    current-thread rt    current-thread rt           │
│  JsRuntime (V8 #1)    JsRuntime (V8 #2)    JsRuntime (V8 #3)  ...      │
│        └────────────────────┼────────────────────┘                     │
│        postMessage/onmessage as V8 structured-clone binaries           │
│                                                                        │
│  ModuleLoader: ESM │ TS transpile (deno_ast/SWC, disk-cached) │        │
│  CJS wrap │ npm resolution (node_modules walk-up, exports/main, JSON)  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Execution**: V8 15.0 (`v8` crate 150.4) from `deno_core` 0.412.
- **Startup snapshot**: the JS bootstrap in `src/js/` (console, process,
  Buffer, timers, channels, Worker, WorkerPool, URL, fetch, …) is serialized
  into a V8 heap snapshot by `build.rs` and deserialized at startup.
- **Event loop**: `deno_core`'s event loop polled on tokio. V8 isolates are
  `!Send`, so each isolate (main and each worker) runs on its own OS thread
  with its own current-thread tokio runtime.
- **Blocking work**: async filesystem calls, file streams, and zlib run on
  tokio's blocking thread pool. `*Sync` APIs run on the isolate thread.
- **Timers**: `setTimeout`/`setInterval`/`sleep` use a JS-side min-heap of
  deadline buckets (`src/js/02_timers.js`) with a single `op_sleep_until`
  armed for the earliest deadline.
- **HTTP server**: hyper 1.x accept and connection tasks run on a separate
  multi-thread tokio runtime. Requests are passed to the isolate in batches
  through channels.
- **V8 code cache**: compiled bytecode for user modules is stored on disk
  (`src/cache.rs`) and reused on later runs.
- **TypeScript**: transpile-only (no type checking). Output is cached in
  `$JSE_CACHE_DIR`, or `$TMPDIR/jse-tscache-v<version>` if unset.
- **npm / CommonJS**: Node-style resolution (`node_modules` walk-up,
  `package.json` `main`/`exports`/`imports`/`type`, `index.js`, extension
  search). CommonJS modules are wrapped as ESM with static named exports, so
  both `import { get } from "lodash"` and `import lodash from "lodash"` work.

## Language and module support

| Feature | Status |
|---|---|
| ECMAScript | Whatever V8 15.0 supports, including ES2024 and ES2025 features (`Promise.withResolvers`, `Object.groupBy`, `RegExp.escape`, `Promise.try`, `Float16Array`, Set methods, iterator helpers). See `tests/fixtures/es_features.js` |
| Import attributes | `with { type: "json" }`. `text` and `bytes` are not supported |
| TypeScript | `.ts`, `.mts`, `.cts`, `.tsx`, `.jsx` transpiled; `.cts` loads as CommonJS; `tsconfig.json` `paths` and `baseUrl`; ECMA decorators |
| ESM | Static and dynamic import, top-level await, `import.meta` |
| CommonJS | `.cjs`, and `.js` in packages without `"type": "module"`; `module`, `exports`, `require`, `__filename`, `__dirname` |
| npm | Bare specifiers; `exports` conditions `import`/`require`/`node`/`default` and subpath patterns; `imports` (`#…`); `NODE_PATH` |
| WebAssembly | `import m from "./m.wasm"`, `require("./m.wasm")`, `WebAssembly.compileStreaming`/`instantiateStreaming`, WASI Preview 1 (`node:wasi`) |

## Runtime APIs

| API | Description |
|---|---|
| `fetch`, `Request`, `Response`, `Headers` | reqwest + rustls. Decodes gzip, deflate, and Brotli responses; `redirect` may be `follow`, `manual`, or `error`. Response bodies stream (`response.body` is async-iterable and has `getReader()`). `clone()` on unconsumed responses (throws `TypeError` on consumed per WHATWG spec). Request bodies: string, `URLSearchParams`, `Blob`, `FormData`, `ArrayBuffer`/typed arrays, and streamed (chunked) `ReadableStream`/async iterables. Abort signals clean up the underlying connection |
| `jse.serve(options, handler)` | Deno-style HTTP server. Handler returns a `Response` or a promise of one. Supports keep-alive, whole and chunked bodies, TLS, request body streaming for large uploads, configurable timeouts/limits. `server.reload(fn)` hot-swaps the handler with zero downtime; `server.hot(path)` watches a file and reloads on change. Proper error codes: 408 timeout, 413 payload too large, 502 bad gateway, 503 service unavailable, 504 gateway timeout |
| `WebSocket`, `jse.upgradeWebSocket(req)` | WebSocket client and server upgrade. `binaryType` may be `nodebuffer`, `arraybuffer`, or `blob` |
| `chan(capacity?)` | Channels with `send`/`recv`/`close`/`for await`, backed by tokio mpsc. Bounded channels apply backpressure |
| `Worker`, `WorkerPool` | One OS thread and V8 isolate per worker. Messages use V8 structured clone. `new WorkerPool(path, { size })` defaults to `cpus - 1` (leaves headroom for the main thread). `pool.run(arg)`, `pool.map(items)`, `pool.stream(arg)` (async iterable), `pool.close()`. Supports `{ signal }` for cancellation and `{ timeoutMs }` for deadlines |
| `structuredClone` | V8 value serializer |
| `URL`, `URLSearchParams` | `URL` via the `url` crate; `URLSearchParams` in JS |
| `jse.Router` | Router with `:param` and wildcard routes; `router.static()` serves files with ETag and 304 handling |
| `jse.kv` | In-process key-value store held outside the V8 heap. Versioning, compare-and-swap, counters, TTL |
| `jse.sql` | Embedded SQLite via tagged templates; `jse.sql.open(path)` returns a `Database` |
| `jse.queue` | SQLite-backed task queue: `push`, `pop` with lease, `ack`, `nack`, dead-letter via `dead` |
| `jse.trace` | Spans, W3C `traceparent` inject/extract, OTLP JSON export. `autoInstrument()` wraps `fetch()` with automatic span creation; `instrumentedHandler(fn)` wraps serve handlers with inbound request tracing and trace-context propagation |
| `jse.log` | Structured logger (text or JSON). Configured with `JSE_LOG`, `JSE_LOG_FORMAT`, `JSE_HTTP_LOG` |
| `jse.onShutdown`, `jse.healthCheck`, `jse.metrics` | Shutdown hooks on SIGTERM/SIGINT, a health-check handler, Prometheus-format metrics |
| `jse.optimizer` | Sets V8 Wasm tiering flags and triggers V8 memory compaction during idle turns and between request batches |
| `malia.ai` | Built-in AI toolkit. Auto-detects local Ollama/vLLM/LM Studio. `malia.ai("prompt")` for one-shot chat, `ai.stream("prompt")` for streaming tokens, `ai.embed("text")` for vectors, `AI.similarity(a, b)` for cosine distance. Conversation memory, system prompts, configurable models. No npm packages needed |
| `malia.parallel` | Concurrent execution with controlled parallelism. `parallel.map(items, fn, {concurrency})`, `parallel.filter`, `parallel.each`, `parallel.reduce`, `parallel.pool`, `parallel.pipeline`, `parallel.race`, `parallel.any`. See [Concurrency](#concurrency-maliaparallel) |
| `malia.mutex`, `malia.semaphore` | Async mutex and counting semaphore for protecting shared state |
| `malia.cron` | Built-in cron scheduler. 5/6-field expressions, ranges, steps, day/month names. `cron.every("5m", fn)`, `cron.daily()`, `cron.weekly()`. See [Cron](#cron-scheduler-maliacron) |
| `malia.retry` | Retry with exponential backoff: `retry(fn, {attempts, delay, backoff})` |
| `malia.timeout` | Deadline enforcement: `timeout(promise, ms)` |
| `malia.batch` | Chunked processing: `batch(items, size, fn)` |
| `malia.debounce`, `malia.throttle` | Function rate limiting utilities |
| `jse.secure` | Security headers middleware: HSTS, noSniff, frameOptions, CSP, COOP, CORP, referrer policy |
| `jse.rateLimit` | Per-IP rate limiting with `Retry-After` and `X-RateLimit` headers |
| `jse.cors` | CORS middleware with preflight support, configurable origin/methods/credentials |
| `malia.pubsub` | In-process pub/sub: `subscribe(pattern, fn)`, `publish(topic, msg)`, pattern matching (`events:*`), message history for late joiners, `once()` promises, async iterators |
| `malia.cache` | LRU cache with TTL, size limits, `getOrSet(key, fn)` cache-aside with automatic dedup, `cache.memoize(fn)`, bulk ops, hit/miss stats, `onEvict` callbacks. Replaces `lru-cache` (100M/week) |

Web globals: `self`, `window`, `global`, `navigator`, `DOMException`,
`btoa`, `atob`, `crypto.getRandomValues`, `crypto.randomUUID`,
`crypto.subtle` (see below), `CryptoKey`, `EventTarget`, `Event`, `CustomEvent`,
`MessageEvent`, `CloseEvent`, `ErrorEvent`, `AbortController`,
`AbortSignal` (`abort`, `timeout`, `any`), `Blob`, `File`, `FormData`,
`MessageChannel`, `BroadcastChannel`, `TextEncoder`/`TextDecoder` (utf-8, utf-16le, latin1;
`fatal`, `ignoreBOM`, `stream`), and the WHATWG streams (`ReadableStream`,
`WritableStream`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream`,
`CompressionStream`, `DecompressionStream`).

`crypto.subtle` supports `digest`, `generateKey`, `importKey`/`exportKey`
(raw, pkcs8, spki, jwk), `sign`/`verify` (HMAC, RSASSA-PKCS1-v1_5, RSA-PSS,
ECDSA, Ed25519), `encrypt`/`decrypt` (AES-GCM, AES-CBC, AES-CTR, RSA-OAEP),
`deriveBits`/`deriveKey` (PBKDF2, HKDF), and `wrapKey`/`unwrapKey`.

`setTimeout`/`setInterval` return `Timeout` objects (`ref`, `unref`,
`hasRef`, `refresh`); `setImmediate` runs after I/O and before later timers.
`sleep(ms)` returns a promise; `sleep(ms, { signal })` can be cancelled
with an `AbortSignal`.

## AI Toolkit (`malia.ai`)

Built-in AI with zero configuration. Auto-detects local LLMs and cloud
providers. No npm packages, no API keys for local models.

```javascript
// One-liner — auto-detects Ollama, vLLM, LM Studio, or llama.cpp
const reply = await malia.ai("What is quantum computing?");

// Streaming
const ai = malia.ai({ model: "llama3", system: "Be concise" });
for await (const token of ai.stream("Explain gravity")) {
  process.stdout.write(token);
}

// Frontier models — auto-detects provider from model name + env var
const ai = malia.ai("gpt-4o");              // uses OPENAI_API_KEY
const ai = malia.ai("claude-sonnet-4-20250514");     // uses ANTHROPIC_API_KEY
const ai = malia.ai("gemini-2.0-flash");    // uses GOOGLE_API_KEY
const ai = malia.ai("grok-3");              // uses XAI_API_KEY
const ai = malia.ai("mistral-large-latest");// uses MISTRAL_API_KEY

// Embeddings + similarity
const vec = await ai.embed("search query");
const score = malia.ai.similarity(vecA, vecB);

// Conversation memory
const ai = malia.ai({ system: "You are a helpful assistant" });
await ai.chat("My name is Alice");
await ai.chat("What is my name?");  // remembers: "Alice"
ai.clear();  // reset conversation
```

Supported providers: OpenAI, Anthropic (native Messages API), Google
Gemini, Mistral, Groq, DeepSeek, Together, Fireworks, Perplexity, xAI,
plus any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, llama.cpp).

## Hot Module Replacement

Zero-downtime code swaps on a running server. The HTTP socket stays
open, keep-alive connections persist, in-flight requests complete with
the old handler. No restart, no port rebind, no dropped requests.

```javascript
// Watch a handler file — edits are picked up automatically
const server = jse.serve({ port: 3000 }, initialHandler);
await server.hot("./handler.mjs");  // watches file, reloads on change

// Or swap programmatically
server.reload(newHandler);  // instant, zero downtime
```

How it works: the hyper HTTP server runs on a separate thread pool. The
JS handler is a mutable reference — `reload()` atomically swaps it.
New requests immediately use the new handler; in-flight requests finish
with the handler that was active when they started.

## Concurrency (`malia.parallel`)

`Promise.all(urls.map(fetch))` fires every request at once. If you have
1000 URLs, that's 1000 simultaneous connections. `malia.parallel.map`
lets you set a concurrency limit.

```javascript
// Fetch 100 URLs, 10 at a time (not 100 at once)
const data = await malia.parallel.map(urls, url => fetch(url).then(r => r.json()), {
  concurrency: 10
});

// Concurrent filter
const live = await malia.parallel.filter(hosts, async h => {
  try { await fetch(h); return true; } catch { return false; }
}, { concurrency: 20 });

// Async mutex -- protect shared state
const lock = malia.mutex();
await lock.run(async () => { /* critical section */ });

// Semaphore -- limit concurrent access
const sem = malia.semaphore(5);
await sem.run(async () => { /* max 5 concurrent */ });

// Retry with exponential backoff
const result = await malia.retry(() => fetch(url), {
  attempts: 3, delay: 100, backoff: 2
});

// Deadline enforcement
await malia.timeout(fetch(url), 5000, "API call timed out");

// Reusable concurrent executor
const pool = malia.parallel.pool(url => fetch(url).then(r => r.json()), {
  concurrency: 5
});
const data = await pool.submit("https://api.example.com/data");
```

Also available: `malia.parallel.each`, `malia.parallel.reduce`,
`malia.parallel.race`, `malia.parallel.any`, `malia.parallel.pipeline`,
`malia.batch`, `malia.debounce`, `malia.throttle`.

## Cron Scheduler (`malia.cron`)

Built-in cron with no npm packages. Supports 5-field (minute) and 6-field
(second) expressions, ranges, steps, day/month names.

```javascript
malia.cron("*/5 * * * *", () => console.log("every 5 minutes"));
malia.cron("0 9 * * MON-FRI", () => sendDailyReport());
malia.cron("*/30 * * * * *", () => checkHealth());  // every 30 seconds

// Shorthand helpers
malia.cron.every("10s", fn);   // every 10 seconds
malia.cron.every("5m", fn);    // every 5 minutes
malia.cron.daily(9, 0, fn);    // daily at 9:00
malia.cron.weekly(1, 8, fn);   // Mondays at 8:00

// Job control
const job = malia.cron("0 * * * *", handler);
job.stop();                    // pause
job.start();                   // resume
job.trigger();                 // fire immediately
console.log(job.runCount);     // times executed
```

## Security

Malia defaults to denying filesystem, network, and subprocess access.
You grant permissions explicitly per run.

**Deny-by-default permissions** (see [Permissions](#permissions)): scripts
cannot read files, access the network, or spawn processes without explicit
flags.

**Built-in security middleware** (replaces `helmet` + `express-rate-limit` + `cors`):

```javascript
// Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, CSP, COOP, CORP
const server = jse.serve({ port: 3000 }, jse.secure(handler));

// Rate limiting: per-IP, with Retry-After and X-RateLimit headers
const server = jse.serve({ port: 3000 }, jse.rateLimit(handler, {
  window: 60000, max: 100
}));

// CORS: configurable origin, methods, credentials, preflight
const server = jse.serve({ port: 3000 }, jse.cors(handler, {
  origin: "https://app.example.com"
}));

// Compose them:
jse.serve({ port: 3000 }, jse.secure(jse.rateLimit(jse.cors(handler))));
```

**Security hardening** vs Node.js:

- `setTimeout("string")` blocked (eval-based code injection)
- Package `postinstall` scripts disabled by default (supply-chain defense)
- Tarball extraction rejects symlinks and path traversal
- HTTP request smuggling mitigated (conflicting CL+TE headers resolved per RFC 7230)
- Hot-reload restricted to project directory

**Security CLI tools** for security engineers:

```sh
malia scan .              # Static analysis: 30+ vuln patterns (XSS, injection, secrets, TLS bypass)
malia secrets .           # Detect leaked API keys: AWS, GitHub, Stripe, OpenAI, Slack, SSH, JWT
malia permissions app.js  # Show what permissions a script needs BEFORE running it
malia sbom                # Generate CycloneDX 1.5 SBOM for compliance
malia deps --licenses     # License audit across all dependencies
malia audit               # Check npm advisory database for known CVEs
```

## Developer & Sysadmin Tools

```sh
malia doctor              # Check project health: deps, lockfile, config, .gitignore, secrets
malia serve .             # Instant static file server: directory listing, ETags, MIME types
malia clean               # Remove node_modules, .cache, dist, build, lockfile
malia clean --all         # Also clear global download cache
malia upgrade             # Check for updates, show install command
malia env                 # Show resolved env vars (secrets auto-masked)
```

**Auto `.env` loading**: malia loads `.env`, `.env.local`, `.env.<NODE_ENV>`,
`.env.<NODE_ENV>.local` at startup. No `dotenv` package needed. Existing
environment variables take precedence.

## Deployment

Generate production-ready deployment files from your project config:

```sh
malia deploy              # generates Dockerfile, docker-compose.yml, systemd service
malia deploy docker       # just the Dockerfile
malia deploy systemd      # just the .service file
```

The generated Dockerfile uses a minimal Ubuntu base, installs malia, copies
your code, and runs it with `--allow-all`. The docker-compose.yml includes
health checks and restart policy. The systemd service file is ready for
`systemctl enable --now`.

## Profiling

```sh
malia profile app.js              # 10-second CPU profile (default)
malia profile app.js --duration 30  # 30-second profile
```

Outputs the top functions by CPU time and saves a `.cpuprofile` file you can
load in Chrome DevTools (Performance tab). Also reports RSS and heap memory.

## Database Migrations

```sh
malia migrate create add_users    # creates timestamped up/down SQL files
malia migrate up                  # apply pending migrations
malia migrate down                # roll back the last migration
malia migrate status              # show which migrations are applied
```

Migrations are tracked in a local SQLite database (`.malia-migrations.db`).
Each migration is a pair of `.up.sql` and `.down.sql` files in the
`migrations/` directory.

## Env Encryption

```sh
malia env-encrypt encrypt           # .env -> .env.encrypted (AES-256-GCM)
malia env-encrypt decrypt           # .env.encrypted -> .env
malia env-encrypt encrypt --key=... # use a specific key
```

Commit `.env.encrypted` safely to git. Set `MALIA_ENV_KEY` in your CI/CD
environment or pass `--key`. Without a key, one is generated and printed.

## Pub/Sub (`malia.pubsub`)

In-process publish/subscribe for real-time applications. No Redis, no
socket.io, no npm packages.

```javascript
const bus = malia.pubsub({ history: 50 });  // keep last 50 messages

// Subscribe with pattern matching
bus.subscribe("events:*", (msg, topic) => {
  console.log(topic, msg);
});

bus.publish("events:user.login", { userId: 123 });
bus.publish("events:order.created", { orderId: 456 });

// Late joiners get message history
bus.subscribe("events:*", (msg) => { /* receives replayed messages */ });

// Async: wait for a single message
const { message } = await bus.once("shutdown");

// Async iterator
for await (const { message, topic } of bus.listen("events:*")) {
  await processEvent(message);
}

// Cleanup
const unsub = bus.subscribe("topic", fn);
unsub();  // remove this subscription
bus.clear();  // remove all subscriptions and history
```

## Cache (`malia.cache`)

LRU cache with TTL, size-based eviction, and the cache-aside pattern that
every production app needs. Replaces `lru-cache` (100M weekly downloads).

```javascript
// Basic cache
const cache = malia.cache({ max: 1000, ttl: 60000 });
cache.set("user:123", userData);
const user = cache.get("user:123");  // hit

// Cache-aside: fetch on miss, serve from cache on hit
const user = await cache.getOrSet("user:123", async () => {
  return await db.query("SELECT * FROM users WHERE id = 123");
}, { ttl: 30000 });

// Image / Buffer caching with byte-size limits
const images = malia.cache({
  max: 500,
  maxSize: 50 * 1024 * 1024,  // 50 MB
  sizeOf: (buf) => buf.length,
});
const avatar = await images.getOrSet("avatar:" + id, async () => {
  return Buffer.from(await (await fetch(url)).arrayBuffer());
});

// Memoize any async function
const getUser = malia.cache.memoize(
  async (id) => await db.getUser(id),
  { max: 500, ttl: 60000 }
);
const user = await getUser(123);  // cached after first call

// Automatic dedup: 20 concurrent callers for the same key = 1 computation
const results = await Promise.all(
  userIds.map(id => cache.getOrSet("user:" + id, () => db.getUser(id)))
);
```

Features: LRU eviction, per-key TTL, `staleWhileRevalidate`, `onEvict`
callback, `purge()`, `stats()` (hits, misses, hitRate), bulk operations
(`setMany`, `getMany`, `deleteMany`), iteration, `forEach`.

## npm packages you can drop

These are built in. Download numbers are from npm to give a sense of how
common the need is.

| npm package | Weekly downloads | Malia built-in |
|---|---|---|
| `dotenv` | 160M | Auto `.env` loading at startup |
| `p-limit` / `p-map` | 200M+ | `malia.parallel.map(items, fn, {concurrency})` |
| `p-retry` | 30M | `malia.retry(fn, {attempts, backoff})` |
| `p-timeout` | 30M | `malia.timeout(promise, ms)` |
| `async-mutex` | 5M | `malia.mutex()` / `malia.semaphore(n)` |
| `lodash.debounce` | 15M | `malia.debounce(fn, ms)` |
| `lodash.throttle` | 10M | `malia.throttle(fn, ms)` |
| `node-cron` | 4M | `malia.cron("*/5 * * * *", fn)` |
| `helmet` | 6M | `jse.secure(handler)` |
| `express-rate-limit` | 3M | `jse.rateLimit(handler, {max})` |
| `cors` | 14M | `jse.cors(handler, {origin})` |
| `lru-cache` | 100M | `malia.cache({ max, ttl })` |
| `node-cache` | 5M | `malia.cache({ max, ttl })` |
| `http-server` / `serve` | 5M | `malia serve .` |
| `pm2` / `forever` | 5M | `malia deploy systemd` + cluster |
| `snyk` / `npm audit` | - | `malia scan` + `malia secrets` + `malia audit` |
| `dotenv-vault` | 1M | `malia env-encrypt` |
| `knex migrate` | 2M | `malia migrate` |

## Node builtins

| Module | Implemented |
|---|---|
| `assert`, `assert/strict` | `ok`, `equal`, `strictEqual`, `deepEqual`, `deepStrictEqual` (Map/Set/Date/RegExp/typed array aware), `match`, `doesNotMatch`, `ifError`, `throws`/`rejects` with class, RegExp, object, or function validation, `strict` |
| `async_hooks` | `AsyncLocalStorage` (context propagates across `await` via V8 continuation-preserved `AsyncVariable`), `AsyncResource` with `runInAsyncScope` and `bind` |
| `buffer` | `Buffer` backed by `Uint8Array`, allocations of 4 KB or less come from a shared 8 KB pool (as in Node). Encodings: utf8, base64, hex, latin1, utf16le, ascii |
| `child_process` | `spawn`, `exec`, `execFile`, their `*Sync` forms, `fork` with IPC |
| `cluster` | `isPrimary`, `isWorker`, `fork`, lifecycle events, IPC. Workers bind the same port with `SO_REUSEPORT` |
| `console` | `log`, `info`, `warn`, `error`, `debug`, `trace`, `assert`, `time`, `timeEnd`, `timeLog`, `count`, `countReset`, `table`, `dir`, `group`, `groupEnd`, `groupCollapsed`, `clear` |
| `crypto` | `createHash` and `hash` (md5, sha1, sha224, sha256, sha384, sha512, sha512-256; `copy()`), `createHmac`, `randomBytes`, `randomInt`, `randomUUID`, `timingSafeEqual`, `pbkdf2`, `scrypt`, `hkdf`, `hkdfSync`; ciphers `aes-{128,192,256}-{cbc,ctr}`, `aes-{128,256}-gcm`, `chacha20-poly1305`; `KeyObject`, `createPrivateKey`/`createPublicKey`/`createSecretKey` (PEM, DER, JWK; PKCS#1, PKCS#8, SEC1, SPKI), `generateKeyPair(Sync)` for RSA, EC (P-256/384/521), Ed25519; `sign`/`verify`, `createSign`/`createVerify` (RSA PKCS#1 v1.5 and PSS, ECDSA DER or IEEE P1363, Ed25519); `publicEncrypt`/`privateDecrypt` (OAEP, PKCS#1 v1.5); `createECDH` (P-256, P-384, P-521, X25519), `diffieHellman`; `X509Certificate`; `webcrypto` |
| `diagnostics_channel` | `channel`, `subscribe`, `unsubscribe`, `hasSubscribers`, `tracingChannel` (`traceSync`, `tracePromise`, `traceCallback`) |
| `dgram` | UDP sockets: `createSocket`, `bind`, `send`, `close`, message events, auto-bind on send |
| `dns`, `dns/promises` | `lookup`, `lookupService`, `resolve4`, `resolve6`, `resolveTxt`, `resolveSrv`, `resolveMx`, `resolveNs`, `resolveCname`, `resolvePtr`, `reverse` |
| `domain` | `create`, `Domain` |
| `events` | `EventEmitter`, `once`, `on` (async iterator with `AbortSignal`), `getEventListeners`, `removeAllListeners` (emits `removeListener`), `prependListener`, `prependOnceListener`, `defaultMaxListeners`, `captureRejections`, `errorMonitor`, `setMaxListeners` (static), `addAbortListener` |
| `fs`, `fs/promises` | Sync, callback, and promise APIs with Node's error shape (`code`, `errno`, `syscall`, `path`): read/write with `flag`, `mode`, and encodings, `stat` (`throwIfNoEntry`), `readdir` (`recursive`, `withFileTypes`), `mkdir`, `rm`, `cp`, `copyFile` (`COPYFILE_EXCL`), `rename`, `link`, `symlink`, `utimes`, `opendir`, file descriptors, `FileHandle`, streams, `watch` (native inotify/kqueue/FSEvents via notify, falls back to polling), `watchFile` |
| `http`, `https` | `createServer` (with options), `request`, `get`, `IncomingMessage` (async iterable body, `close` event), `ServerResponse` (`_implicitHeader`, `headersSent`, CRLF-validated `setHeader`), `Agent` (`keepAlive` connection pooling, `maxFreeSockets`), `globalAgent`, `STATUS_CODES`, `METHODS`, `validateHeaderName`/`validateHeaderValue`. The server shares the hyper engine with `jse.serve`; client responses are `Readable` streams; request bodies > `maxBodyBytes` stream through a channel |
| `http2` | Server and client; ALPN `h2` and cleartext `h2c` with prior knowledge |
| `inspector` | `Session` (connects to the running V8 inspector over WebSocket), `open`, `close`, `url`. See [Debugging](#debugging) |
| `module` | `createRequire`, `builtinModules`, `isBuiltin`, `Module`, `Module._resolveFilename`, `Module._load`, `Module._cache`, `Module._nodeModulePaths` |
| `net`, `tls` | TCP, Unix domain sockets and Windows named pipes; rustls TLS clients. TLS servers, socket upgrades and unimplemented security options reject explicitly; see the compatibility matrix. |
| `os` | `cpus` (real brand/frequency/times), `loadavg`, `uptime`, `totalmem`, `freemem`, `networkInterfaces` (MAC addresses), `userInfo`, `hostname`, `platform`, `arch`, `type`, `release`, `version`, `machine`, `availableParallelism`, `tmpdir`, `homedir`, `endianness`. Reports cgroup limits inside containers |
| `path` | Port of Node's implementation; `posix` and `win32`, with the platform's variant as the default |
| `perf_hooks` | `performance.mark`, `performance.measure`, `performance.getEntries`, `PerformanceObserver` (fires callbacks on entries), `monitorEventLoopDelay` |
| `process` | `argv`, `env` (mutations propagate to child processes), `cwd`, `chdir`, `nextTick`, `hrtime`, `hrtime.bigint`, `memoryUsage`, `cpuUsage`, `kill`, `exit`, `abort`, `mainModule`, `stdin` (readable stream), `stdout`/`stderr` (writable streams with EPIPE handling), `uncaughtException`/`unhandledRejection`/`SIGTERM`/`SIGINT` events, `emitWarning`, `umask`, `report`, `getBuiltinModule`, `allowedNodeEnvironmentFlags`, `features`, `config`, `release`. CJS modules have `module.id`, `module.filename`, `module.loaded`, and `require.cache` (delete forces reload) |
| `punycode`, `querystring`, `readline`, `string_decoder`, `timers`, `tty`, `constants` | Available |
| `sqlite` | `DatabaseSync`, `StatementSync` (Node 22 API) |
| `stream`, `stream/promises`, `stream/consumers`, `stream/web` | Node's stream implementation (readable-stream 4): `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `compose`, backpressure, `toWeb`/`fromWeb`; consumers; WHATWG streams |
| `test` | `test`, `describe`, `it`, `before`/`after`/`beforeEach`/`afterEach`, `mock.fn`/`mock.method`/`mock.reset`, TAP output |
| `url` | `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL` |
| `util`, `util/types` | `format`, `inspect`, `promisify`, `callbackify`, `inherits`, `deprecate`, `isDeepStrictEqual`, `parseArgs`, `styleText`, `MIMEType`, `debuglog`, type predicates |
| `v8` | `getHeapStatistics`, `serialize`, `deserialize`, `Serializer`, `Deserializer` |
| `vm` | `runInThisContext`, `createContext`/`runInContext`/`runInNewContext` and `Script` in real V8 contexts (sandbox properties seed the context's global; globals the code defines are written back). Timeouts and cached data reject explicitly. Like Node, not a security boundary |
| `wasi` | WASI Preview 1: args, env, clocks, random, stdio, exit |
| `worker_threads` | `Worker`, `isMainThread`, `threadId`, `workerData`, `parentPort`, `MessageChannel`, `BroadcastChannel` (across threads), `SHARE_ENV` |
| `ws` | `WebSocket` and `WebSocketServer` compatible with the `ws` package |
| `zlib` | gzip, deflate, raw deflate, Brotli, `unzip`; sync, callback, and stream forms; CRC-32 |

## Database drivers

Database clients are ordinary npm packages. `tests/db/drivers.mjs` runs each
one below against a live server; CI's `databases` job starts the servers as
service containers and requires all of them to pass.

| Database | Packages | Exercised |
|---|---|---|
| PostgreSQL 16 | `pg`, `postgres`, `knex`, `drizzle-orm` | SCRAM-SHA-256 auth, parameters, `jsonb`, `bytea`, schema builder, ORM queries |
| MySQL 8.4 | `mysql2` | `caching_sha2_password` auth, text and binary (prepared) protocol, `BLOB` |
| Redis 7 | `ioredis`, `redis` | Commands, pipelines, pub/sub, hashes |
| MongoDB 7 | `mongodb`, `mongoose` | SCRAM-SHA-256 auth, `insertMany`/`find` with BigInt, models |
| DynamoDB Local | `@aws-sdk/client-dynamodb` | SigV4 signing, create/put/get/delete |
| Elasticsearch 8 | `@elastic/elasticsearch` | undici transport, bulk indexing, search |
| Cassandra 5 | `cassandra-driver` | Keyspaces, prepared statements, UUIDs |
| SQLite | `node:sqlite`, `jse.sql` | Built in, no native addon required |

## Frameworks

We test against specific parts of these frameworks, not their entire
surface area. If you're running Express routing or React SSR, you're
probably fine. If you're deep into Next.js ISR or Angular Zone.js,
test your app first.

- **Express 5**: routing, query parsing, middleware, static files
- **Fastify 5**: route registration, request dispatch via `inject()`
- **React 19**: `renderToString` server-side rendering
- **Vue 3**: SSR via `createSSRApp` + `renderToString`
- **Svelte 5**: compiler + server-side `render()`
- **Angular**: Signals, DI, rxjs (not Zone.js or full SSR)
- **Preact**: `preact-render-to-string`
- **Next.js 16**: standalone `next build` output with App Router SSR

## Containers

- `os.totalmem()`/`os.freemem()` and the default worker pool size read cgroup
  v1/v2 limits (`memory.max`, `memory.limit_in_bytes`, `cpu.max`,
  `cpu.cfs_quota_us`).
- As PID 1, SIGTERM and SIGINT are delivered to `process.on(...)` handlers
  and `jse.onShutdown` hooks. Without a handler the process exits with 143
  (SIGTERM) or 130 (SIGINT).
- `jse.serve` and `node:http` bind to `0.0.0.0` by default. `PORT`, `HOST`,
  and `NODE_ENV` are read from the environment.

See the [Dockerfile](Dockerfile) in the repository root and
[docs/HOWTO.md](docs/HOWTO.md#12-container-deployment).

## Limitations

- **N-API native addons:** `.node` files are `dlopen`'d and the init
  symbol is verified, but the N-API function table (the ~40 C functions
  addons call to create JS values, get properties, etc.) is not yet
  connected. Addons that only check for loadability work (try/catch
  fallback patterns). Addons that call `napi_create_string_utf8` etc.
  need the function table, which requires bridging `extern "C"` to
  deno_core's V8 scope management. Packages like `bcrypt`, `sharp`,
  and `better-sqlite3` are blocked on this.
- `Blob` contents are held in memory (same as Node).
- Crypto: no encrypted (passphrase-protected) PEM import/export, RSA key
  generation only for 2048/3072/4096/8192 bits with exponent 65537, and
  RSA-PSS salt length must equal the digest length.
- Windows: `node:cluster` workers cannot share a port (it relies on
  `SO_REUSEPORT`), and `chmod` only toggles the read-only attribute.
- HTTP server request bodies under `maxBodyBytes` (default 10 MB) are
  collected in memory; larger bodies are streamed through a channel.
  The `node:http` client supports `http.Agent({ keepAlive: true })` for
  connection pooling.
- Small Buffers share an 8 KB slab, so `buf.buffer.byteLength` can be larger
  than `buf.length` (same as Node).
- Standalone executables are not type-checked; TypeScript is transpiled only.

## Development

```sh
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
```

Integration tests are in `tests/integration.rs`, with fixtures in
`tests/fixtures/`. `tests/cli.rs` runs the CLI commands and flags in scratch
directories. The database driver suite needs live servers:

```sh
npm ci --prefix tests/db
JSE_PG_URL=postgres://postgres:secret@127.0.0.1:5432/postgres \
  ./target/debug/jse run --allow-all tests/db/drivers.mjs   # set JSE_* per server
```

The variables for each server are listed at the top of `tests/db/drivers.mjs`.

Release builds use `opt-level = 3`, fat LTO, `codegen-units = 1`, and
stripped symbols. `panic = "unwind"` is kept because V8 and `deno_core` use
`catch_unwind` at the JS/Rust boundary. The code under `src/` contains no
`unsafe` blocks; `unsafe` exists only in dependencies (`v8`, `deno_core`,
`swc`).

### Project layout

```
build.rs          startup snapshot build (JsRuntimeForSnapshot over src/ops.rs)
src/main.rs       CLI and process-level tokio runtime
src/lib.rs        library root
src/runtime.rs    JsRuntime setup (snapshot, extensions), drivers, REPL
src/loader.rs     module resolution (ESM/TS/CJS/npm/JSON), CJS wrapping, V8 code cache
src/ts.rs         deno_ast (SWC) transpile and disk cache
src/cache.rs      on-disk cache helpers
src/config.rs     project config loading
src/ops.rs        ops: timers, fs, process, channels, workers, text, crypto, url, fetch, HTTP
src/ops_extra.rs  net, TLS client, zlib, dns, os, hmac, udp, fs.watch, child stdio (included from ops.rs)
src/pkg.rs        built-in npm-compatible package manager (install, publish, audit, SBOM)
src/crypto.rs     asymmetric keys, ECDH/X25519, signatures, RSA, AES-CBC/CTR
src/serve.rs      hyper server for jse.serve and node:http
src/inspector_server.rs  V8 inspector WebSocket server (--inspect / --inspect-brk)
src/logger.rs     structured logger and HTTP access log
src/panic.rs      panic hook and per-connection panic isolation
src/snapshot.rs   include_bytes! of the startup snapshot
src/worker.rs     worker thread host
src/js/           bootstrap globals, built into the startup snapshot
src/js/node/      node: builtin modules
src/js/internal/  CJS wrapper helpers
examples/         example programs
tests/            integration tests and fixtures
```

