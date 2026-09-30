# Malia — JavaScript/TypeScript and WebAssembly runtime

A runtime built in Rust: V8 (via `deno_core`) for execution, tokio for the
event loop and concurrency, `deno_ast` (SWC) for TypeScript transpilation,
and a Node-compatible module resolver for npm packages.

Both `malia` and `jse` commands are fully supported.

> 📖 **Looking for practical guides and recipes?** Check out the [Comprehensive HOWTO Guide](docs/HOWTO.md) for step-by-step instructions on compiling standalone binaries, connecting to databases, configuring OpenTelemetry tracing, using embedded SQLite/task queues, and container deployments.

## Installation

Prebuilt native binaries are available for macOS, Linux, and Windows. You do not need Rust or a C++ compiler to install or use Malia.

### 1. Shell Script (macOS & Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh
```

Or run the bundled installer script:
```sh
./scripts/install.sh
```

This installs `malia` and creates a `jse` alias in `~/.malia/bin`.

### 2. PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex
```

Installs `malia.exe` and `jse.exe` to `%LOCALAPPDATA%\malia\bin` and adds them to your PATH.

### 3. NPM / NPX (Zero-Rust)

```sh
# Run directly with npx (malia or jse)
npx malia app.ts
npx jse app.ts

# Or install globally via npm
npm install -g malia
```

### 4. Prebuilt Binary Downloads

Standalone tarballs and zip archives for every release are published on [GitHub Releases](https://github.com/loreste/malia/releases):
- **macOS (Apple Silicon)**: `malia-darwin-arm64.tar.gz`
- **macOS (Intel)**: `malia-darwin-x64.tar.gz`
- **Linux (x64 glibc)**: `malia-linux-x64-gnu.tar.gz`
- **Linux (x64 musl / Alpine)**: `malia-linux-x64-musl.tar.gz`
- **Linux (ARM64)**: `malia-linux-arm64-gnu.tar.gz`
- **Windows (x64)**: `malia-win32-x64.zip`

Extract and place `malia` (and `jse`) anywhere on your `$PATH`.

### 5. Building from Source (Optional)

If you prefer building from source:
```sh
cargo build --release
```
Both `target/release/malia` and `target/release/jse` binaries are produced.

## Architecture

```
┌──────────────────────────── malia process ─────────────────────────────┐
│                                                                        │
│  CLI (clap)                                                            │
│    malia run <file> ─┐                                                 │
│    malia eval <code> ┼──► multi-thread tokio runtime (supervisor)      │
│    malia (REPL)     ─┘        │ spawn_blocking                         │
│   (or jse alias)              ▼                                        │
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

- **Execution**: V8 150.4 (from `deno_core` 0.412) — modern ECMAScript,
  including ES2024/2025+ features (see feature matrix).
- **Startup snapshot**: the whole JS bootstrap (console/process/Buffer/
  timers/channels/Worker/WorkerPool/URL/fetch) is baked into a V8 heap
  snapshot by `build.rs` (`JsRuntimeForSnapshot`) and deserialized at
  startup instead of being parsed and executed on launch.
- **Event loop**: `deno_core`'s event loop polled on tokio. The process-level
  runtime is multi-threaded; V8 isolates are `!Send`, so each isolate (main +
  every worker) runs on a dedicated OS thread with its own current-thread
  tokio runtime — this is also what gives workers true parallelism.
- **Concurrency**: async filesystem calls, file streams, and zlib run on
  tokio's blocking pool (hundreds of threads, against Node's default libuv
  pool of 4). Timers and sockets keep polling while that work runs. Sync
  `*Sync` APIs stay on the isolate, matching Node. CPU parallelism is one
  V8 isolate per OS thread: `Worker`, `worker_threads`, and `WorkerPool`
  sized to `os.availableParallelism()`.
- **Timers**: `sleep`/`setTimeout`/`setInterval` are a JS-side min-heap of
  deadline buckets (`src/js/02_timers.js`) with a single armed
  `op_sleep_until` for the earliest deadline — re-armed via a `Notify` poke
  when the earliest deadline changes. 10k concurrent same-deadline sleeps
  cost ~1 op round-trip instead of 10k tokio timers.
- **HTTP server**: hyper 1.x accept/connection tasks run on a dedicated
  multi-thread tokio runtime (parse/write in parallel); requests cross to
  the isolate via channels in batches (one op round-trip per batch), and
  sync handlers complete a whole request without a single promise
  allocation on the hot path.
- **V8 code cache**: user modules carry a `SourceCodeCacheInfo` whose hash
  keys a disk cache (`src/cache.rs`); `code_cache_ready` persists V8-produced
  bytecode, so repeated runs of large scripts skip compilation (a 1.6 MB
  module goes from ~42 ms to ~12 ms wall).
- **TypeScript**: `.ts`/`.mts`/`.cts` transpiled to JS by SWC via `deno_ast`
  (transpile-only, no typechecking, like `deno run --no-check`). Results are
  cached on disk (`$JSE_CACHE_DIR` or `$TMPDIR/jse-tscache-v<version>`), so
  only the first run of a file pays for SWC.
- **npm/CJS**: Node-style resolution (`node_modules` walk-up, `package.json`
  `main`/`exports`/`imports`/`type`, `index.js` fallback, extension search).
  CommonJS modules are wrapped into ESM at load time with static named-export
  destructuring, so `import { get } from "lodash"` and `import lodash from "lodash"`
  both work cleanly.
- **WebSockets & Web Standards**: Standards-compliant `WebSocket` client on `globalThis`,
  `EventTarget`, `Event`, `MessageEvent`, `CloseEvent`, and `ErrorEvent`. Server
  upgrades via `malia.upgradeWebSocket(req)` (or `jse.upgradeWebSocket(req)`).
- **File System & Watching**: Complete file-descriptor level APIs (`fs.openSync`, `fs.fstatSync`,
  `fs.readSync`, `fs.writeSync`, `fs.ftruncateSync`, `fs.fsyncSync`), `fs.promises.open` ->
  `FileHandle`, `fs.watchFile`, `fs.unwatchFile`, and `fs.watch` event emitter.
- **Channels & Concurrency**: Bounded channels with true backpressure (`chan(capacity)`),
  `MessageChannel`, `MessagePort`, `BroadcastChannel`, and `SHARE_ENV` built on tokio MPSC
  and V8 structured clone.
- **WebAssembly & WASI**: Direct zero-config `.wasm` ESM imports (`import math from "./math.wasm"`),
  CommonJS `require("./math.wasm")`, standards-compliant streaming compilation/instantiation
  (`WebAssembly.compileStreaming`, `WebAssembly.instantiateStreaming`) over native `fetch`/`Response`,
  and full WASI Preview 1 implementation (`node:wasi` & bare `wasi`) supporting arguments, environment,
  clocks, random entropy, stdio file descriptors, and exit traps.
- **JS Framework & Full-Stack SSR**: Compatibility for modern frameworks (Angular, Vue, React,
  Svelte, Vite, Next.js, Nuxt). Browser and SSR globals (`self`, `window`, `global`,
  `navigator`, `DOMException`, `btoa`, `atob`), Web Crypto API (`crypto.getRandomValues`,
  `crypto.randomUUID`), React Scheduler concurrent-mode `MessageChannel`/`MessagePort`,
  asynchronous context retention across `await` boundaries in `AsyncLocalStorage` (`node:async_hooks`),
  and comprehensive `createRequire` with CJS, JSON, Wasm, and builtins resolution (`node:module`).

## Quickstart

```sh
# Commands work with `malia` or `jse` interchangeably:
malia run examples/hello.ts          # TypeScript directly
malia run --wasm examples/hello.ts   # Run via WebAssembly
malia compile examples/hello.ts -o dist/hello # Compile into standalone native executable
./dist/hello                         # Run standalone binary
malia compile --wasm examples/hello.ts -o app.wasm # Compile app to standalone .wasm binary
malia run app.wasm                   # Run compiled WebAssembly application directly
malia run examples/concurrency.js    # 10k concurrent sleep tasks + channels
malia run examples/workers.js        # parallel fib on 4 OS-thread workers
malia run examples/pool.js           # WorkerPool: 8 fib jobs on 4 workers
malia run examples/pingpong.js       # channel ping-pong

malia run --allow-net examples/server.js        # malia.serve HTTP server
malia run --allow-net examples/node_http.js     # node:http createServer
malia run --allow-run examples/child_process.js # spawn/execFile/spawnSync
malia run --allow-read examples/permissions.js  # permission model demo
malia eval --allow-all 'console.log(6*7)'       # snippet as an ES module

cd examples/cjs_demo && npm install && cd ../..
malia run --allow-env examples/cjs_demo/main.js  # lodash + minimist + chalk from npm

malia                                # REPL (top-level await supported)
```

## Build & safety

The release profile is tuned for speed: `opt-level = 3`, fat LTO,
`codegen-units = 1`, stripped symbols (`panic = "unwind"` is kept on purpose —
V8/deno_core rely on `catch_unwind` at the JS↔Rust boundary). Result: a
single ~53 MB static binary (V8 + SWC + rustls; ~0.8 MB of that is the
startup snapshot). Note: `build.rs` compiles `src/ops.rs` a second time to
produce the snapshot, so a cold build builds deno_core & co. twice; cargo
caches it afterwards.

Safety posture of the host runtime:

- **No `unsafe` in our code** — memory safety is enforced by the Rust
  compiler; the only `unsafe` in the tree lives inside the audited
  `v8`/`deno_core`/`swc` crates.
- `cargo clippy --all-targets -- -D warnings` is clean.
- `cargo audit` reports **0 vulnerabilities** across ~350 dependencies
  (two "unmaintained" advisories, `paste` and `smartstring`, are transitive
  deps of v8/swc — not exploitable, tracked upstream).
- **Permission model**: `jse run` denies all capabilities by default; grant
  per category with flags (see "Permissions" below). The REPL runs with full
  permissions. As with Node, do not run code you distrust without reviewing
  what it can reach — the flags are the boundary.

## Permissions

`jse run` denies all capabilities by default (the REPL runs
unrestricted). Grant per category:

```sh
jse run --allow-read script.js                  # any fs read
jse run --allow-read=/tmp,/data script.js       # reads under these paths only
jse run --allow-write=/tmp script.js            # fs writes
jse run --allow-net script.js                   # fetch + jse.serve + node:http
jse run --allow-net=api.example.com script.js   # these hosts only
jse run --allow-run=node,git script.js          # these binaries only
jse run --allow-env script.js                   # environment variables
jse run --allow-all script.js                   # everything
```

A denied call throws `PermissionDenied: <kind> access to <what>, run again
with <flag>`. Module-graph loading (imports) is exempt, like Deno; the
checks cover runtime fs/fetch/serve/child_process/env ops. Workers inherit
the process permissions.

## Feature matrix

| Feature | Status |
|---|---|
| ECMAScript | 100% via V8 150.4: ES2024 (`Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`), ES2025+ (`RegExp.escape`, `Promise.try`, `Float16Array`, `Set.prototype.union`, Iterator helpers) — see `tests/fixtures/es_features.js` |
| Import attributes | `with { type: "json" }` supported (`text`/`bytes` are not) |
| TypeScript | `.ts`/`.mts` (+`.tsx`/`.jsx`) transpile-only; `.cts` treated as ESM; disk-cached transpiles |
| ESM | Full: static/dynamic import, top-level await, `import.meta` |
| CommonJS | `.cjs` + `.js` in `type: "commonjs"` (or no) packages; `module`/`exports`/`require`/`__filename`/`__dirname`, with static named-export destructuring into ESM (`import { foo } from "./mod.cjs"`) |
| npm | Bare specifiers via `node_modules` walk-up; `main`, `exports` (conditions `import`/`require`/`node`/`default`, subpath patterns), `imports` (`#…`), `index.js`, extension/TS-shadowing fallback |
| Async | `sleep(ms)`, `setTimeout`/`setInterval`, promise-based ops on tokio |
| Channels | `chan(capacity?)` / `send` / `recv` / `close` / `for await`, backed by tokio mpsc; **V8 structured-clone messages** with true async backpressure for bounded channels (`capacity > 0`) |
| Workers | `new Worker(path)` — real OS threads, own V8 isolate each; `postMessage`/`onmessage`/`receive()`/`terminate()`; **structured-clone messages** (Map/Set/typed arrays/Date round-trip) |
| WorkerPool | `new WorkerPool(path, { size })`, `pool.run(arg)` → Promise (idle-first dispatch), `pool.map(items)`, `pool.close()` |
| structuredClone | Native V8 value serializer (`op_serialize`/`op_deserialize`) |
| fetch | `fetch()` + `Request`/`Response`/`Headers` over reqwest/rustls: streaming body (`response.body` async-iterable + `getReader()`), `text()`/`json()`/`arrayBuffer()`/`bytes()` drain the same stream |
| HTTP server | `jse.serve({ port, hostname? }, handler)` (Deno-style) and `node:http` / `node:https` `createServer` over one hyper 1.x engine on a dedicated multi-thread runtime; keep-alive, whole + chunked-streaming response bodies, TLS via rustls |
| Permissions | `--allow-read[=paths]`, `--allow-write[=paths]`, `--allow-net[=hosts]`, `--allow-run[=bins]`, `--allow-env`, `--allow-all`; default deny; workers inherit |
| URL | WHATWG `URL` (via the `url` crate through ops) + pure-JS `URLSearchParams`, with live `url.searchParams` sync |
| CLI | `jse run`, `jse eval <code>`, rustyline REPL (default) |

## Node.js Drop-in Compatibility & Builtins

`jse` runs Node.js applications, npm libraries, frameworks (Express, Fastify, Next.js API routes, NestJS), and CLI workflows:

- **Directory & Package Resolution**: Run `jse .`, `jse <dir>`, or `jse run <dir>` — `jse` automatically parses `package.json` (`main` and `module` fields with exports condition mapping) or resolves standard entry fallbacks (`index.js`, `index.mjs`, `index.ts`, `app.js`, `server.js`, `main.js`).
- **Node CLI Emulation & Flags**:
  - `-r`, `--require <module>`: Preloads CommonJS/ESM modules before execution (supports multiple chained preloads).
  - `--import <module>`: Node 20+ ES module preloading.
  - `-e`, `--eval <code>`: Evaluates JavaScript code directly.
  - `-p`, `--print <code>`: Evaluates code and prints the result.
  - `-c`, `--check`: Validates syntax without executing.
  - `-i`, `--interactive`: Launches interactive REPL.
  - `-v`, `--version`: Prints engine version (outputs `v20.18.0` when invoked via `node` symlink for 100% tooling compatibility).
  - `--no-warnings`, `--max-old-space-size`, `--enable-source-maps`: Standard Node configuration flags.
  - `NODE_OPTIONS`: Automatically reads and injects flags and preloads from the `NODE_OPTIONS` environment variable.
- **Node.js Global Environment**: `global`, `GLOBAL`, `root`, `process` (with `process.version = "v20.18.0"`, `process.versions.node`, `process.release.name = "node"`, `process.title`), `Buffer`, `ReadableStream`, `WritableStream`, `TransformStream`.

### Node Builtin Module Coverage

| Module / Subpath | Support Highlights |
|---|---|
| `console` | `log`, `info`, `warn`, `error`, `debug`, `trace`, `assert`, `time`, `timeEnd`, `dir` |
| `process` | EventEmitter (`on`/`emit`, `exit`, `beforeExit`, `uncaughtException`, `unhandledRejection`), `argv`, `env`, `cwd`, `chdir`, `nextTick`, `hrtime`, `uptime`, `memoryUsage`, `pid`, `ppid`, `release`, `version`, `versions` |
| `Buffer` | Uint8Array-backed, pooled 8 KB allocation: `from`, `alloc`, `allocUnsafe`, `concat`, `isBuffer`, `byteLength`, `toString` (utf8/base64/hex/latin1/utf16le/ascii), `slice`/`subarray` live Buffer views |
| `fs`, `fs/promises` | Sync, callback, and promise APIs: `readFile`, `writeFile`, `stat`, `lstat`, `readdir`, `mkdir`, `rm`, `unlink`, `rename`, `copyFile`, `realpath`, `access`, `chmod`, `watch`, `watchFile`, `createReadStream`, `createWriteStream`, `open`, `close`, `read`, `write`, `constants` |
| `path`, `path/posix`, `path/win32` | Complete path resolution, joining, normalization, relatives, `posix` and `win32` platform-specific implementations |
| `events` | `EventEmitter` with function constructor inheritance, `on`, `once`, `off`, `emit`, `listenerCount`, `getEventListeners`, `on` async iterator, `defaultMaxListeners` |
| `stream`, `stream/promises`, `stream/consumers`, `stream/web` | `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `consumers` (`buffer`, `text`, `json`, `arrayBuffer`, `blob`), and WHATWG `ReadableStream`, `WritableStream`, `TransformStream` |
| `crypto` | Hardware AEAD ciphers (`aes-256-gcm`, `aes-128-gcm`, `chacha20-poly1305` with AAD & 128-bit auth tags), `Cipheriv`, `Decipheriv`, `createCipheriv`, `createDecipheriv`, `getCiphers`; `Ed25519` keypair generation, `sign`, `verify`; `pbkdf2` & `pbkdf2Sync` for SCRAM-SHA-256/1; `createHash`, `createHmac` (sha256/sha512/sha1/md5), `randomBytes`, `randomUUID`, `timingSafeEqual`, `getHashes`, subtle crypto |
| `util`, `util/types` | `format`, `inspect`, `promisify`, `callbackify`, `inherits`, `deprecate`, `isDeepStrictEqual`, and 36 `util/types` type predicates (`isPromise`, `isDate`, `isRegExp`, `isArrayBufferView`, `isUint8Array`, `isMap`, `isSet`, `isNativeError`, etc.) |
| `os` | `platform`, `arch`, `endianness`, `homedir`, `tmpdir`, `hostname`, `type`, `release`, `version`, `machine`, `totalmem`, `freemem`, `userInfo`, `networkInterfaces`, `cpus`, `availableParallelism`, `uptime`, `loadavg`, `constants`, `getPriority`, `setPriority` |
| `url` | WHATWG `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL` |
| `http`, `https` | `createServer`, `Server`, `IncomingMessage`, `ServerResponse`, `request`, `get` with keep-alive, streaming chunks, and TLS via rustls |
| `http2` | Complete HTTP/2 server and client with multiplexing and streaming |
| `net` | TCP and POSIX Unix Domain Sockets (`net.connect({ path })`, `server.listen(path)`), `Socket`, `Server`, `connect`, `createServer`, `isIP`, `isIPv4`, `isIPv6`, `SocketAddress`, `BlockList` |
| `zlib` | Gzip, gunzip, deflate, inflate, raw variants, and Brotli (`brotliCompress`, `brotliDecompress`, sync, async, and streaming) |
| `dns`, `dns/promises` | `lookup`, `resolve4`, `resolve6`, `resolveTxt`, `resolveSrv`, `resolveMx`, `reverse` |
| `cluster` | Primary/worker fork lifecycle, SO_REUSEPORT port sharing, IPC messaging ping-pong |
| `child_process` | `spawn`, `execFile`, `exec`, `spawnSync`, `execFileSync`, `execSync`, `fork` with IPC socket communications and live stdio |
| `worker_threads` | `isMainThread`, `threadId`, `workerData`, `parentPort`, `Worker`, `MessageChannel`, `MessagePort`, `BroadcastChannel`, `SHARE_ENV` |
| `module` | `createRequire` (supporting CJS, JSON, Wasm, builtins with caching), `Module`, `builtinModules`, `isBuiltin`, `_nodeModulePaths`, `syncBuiltinESMExports` |
| `v8` | `getHeapStatistics`, `serialize`, `deserialize`, `Serializer`, `Deserializer` |
| `vm` | `createContext`, `isContext`, `runInContext`, `runInNewContext`, `runInThisContext`, `Script` |
| `diagnostics_channel` | `channel`, `subscribe`, `unsubscribe`, `hasSubscribers`, `tracingChannel` |
| `domain` | `Domain`, `create`, error routing |
| `punycode` | `toASCII`, `toUnicode`, `encode`, `decode`, `ucs2` |
| `inspector` | `Session`, `open`, `close`, `url` |
| `test` | Built-in test runner with `test`, `describe`, `it`, hooks (`before`, `after`, `beforeEach`, `afterEach`), and TAP output |
| `assert` | Complete assert suite: `ok`, `equal`, `strictEqual`, `deepEqual`, `deepStrictEqual`, `match`, `doesNotMatch`, `ifError`, `rejects`, `doesNotReject`, `throws` |
| `ws` | Native RFC 6455 WebSockets client and server compatibility |
| `wasi` | WASI host implementation (WASI Preview 1) for WebAssembly sandboxing |
| `sqlite` | Official Node 22+ built-in (`node:sqlite`): `DatabaseSync` and `StatementSync` backed by high-performance embedded SQLite |

## Database Ecosystem Compatibility

`jse` supports standard database drivers and client libraries for SQL, NoSQL, and embedded databases:

- **PostgreSQL (`pg`, `postgres`, `drizzle-orm`, `@prisma/client`, `typeorm`, `knex`, `slonik`)**:
  - Full duplex TCP socket streaming over `node:net` and TLS over `node:tls`.
  - Complete support for SCRAM-SHA-256 and legacy MD5 authentication via `node:crypto`.
  - Binary and text row parsing supported via `Buffer`.
- **MySQL & MariaDB (`mysql2`, `typeorm`, `prisma`, `knex`)**:
  - Pure-JS wire protocol handling for handshakes, binary and text statements, and connection pools.
  - Native support for `caching_sha2_password` (SHA-256 XOR scramble) and `mysql_native_password`.
- **Redis & Key-Value Stores (`ioredis`, `redis`)**:
  - RESP2 and RESP3 protocol execution over TCP/TLS sockets.
  - Non-blocking command pipelining, transactions, and real-time Pub/Sub streams.
  - In-process off-heap caching alternative via `jse.kv` with atomic CAS and TTL.
- **MongoDB & Document Stores (`mongodb`, `mongoose`)**:
  - Cloud database cluster discovery via DNS SRV and TXT lookups (`dns.resolveSrv`, `dns.resolveTxt` for `mongodb+srv://`).
  - BSON binary wire serialization and SCRAM-SHA-1 / SCRAM-SHA-256 authentication.
- **SQLite (`node:sqlite`, `jse.sql`, `@libsql/client`)**:
  - **Embedded SQLite**: Built-in Node 22+ `node:sqlite` (`DatabaseSync` / `StatementSync`) requires no external dependencies or native builds.
  - Tagged template literal SQL queries via `jse.sql` and `jse.Database`.
- **Serverless & Edge Databases (Supabase, Neon, PlanetScale, Cloudflare D1/Hyperdrive)**:
  - Streaming HTTP/1.1 and HTTP/2 connections via global `fetch()`.
  - Real-time event streaming and multiplexing over native `WebSocket`.

## Compatibility Notes

- **Node APIs**: Existing pure-JS/TS Node apps, Express servers, and npm scripts run directly.
- **CJS & ESM Interop**: CommonJS `require()` and ESM `import` work together, including automatic named-export extraction from CJS modules.
- **Framework Compatibility**: Tested with Express, Fastify, React/Vue SSR runtimes, Lodash, Chalk, and Minimist.
- **Worker/Channel Messages**: V8 structured clone: maps, sets, typed arrays, errors, and dates round-trip cleanly across worker threads and green channels.
- **Timers & Event Loop**: Sub-millisecond timers, microtask queues, and process.nextTick priority ordering.


- `fetch` has no redirect/auth/proxy options exposed and no gzip decoding;
  request bodies are whole (no streaming upload).
- Server: HTTP/1.1, HTTP/2 (`node:http2`), and HTTPS (rustls). Request bodies are read
  into memory; `node:http` delivers the request body to listeners. The `node:http` client sends buffered bodies with
  `Content-Length` and `Connection: close`.
- `child_process` stdio `pipe` is a live stream. `inherit` and `ignore` work.
  Subprocess IPC is supported via `child_process.fork()` and `process.send()`.
- WorkerPool contract: a pool worker script must answer exactly one
  `postMessage` per received message.
- Timers have 1 ms resolution and may fire up to ~1 ms early (deadline
  quantization compensates tokio's round-up wake granularity); a sleeping
  `sleep()` promise cannot be cancelled.
- Small Buffers (<= 4 KB) are carved from a shared 8 KB pool, exactly like
  Node: `buf.buffer.byteLength` may exceed `buf.length` and unrelated small
  buffers can share one slab.

## Tests

```sh
cargo test
```

43 integration tests (`tests/integration.rs`) plus unit and doctests cover:
- **ES2024/2025+ Standards**: `Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, `RegExp.escape`, `Promise.try`, `Float16Array`, `Set.prototype.union`, Iterator helpers.
- **Security & Operations**: AEAD ciphers (AES-256-GCM, AES-128-GCM, ChaCha20-Poly1305) with tamper rejection; Ed25519 keypairs, signing, and signature verification; POSIX Unix Domain Sockets echo & lifecycle; `jse.trace` OpenTelemetry OTLP export and W3C `traceparent` propagation; `jse.queue` persistent task queue with atomic leases and dead-letter queue.
- **Single-Binary Standalone Compilation**: Ahead-of-time TypeScript transpilation and standalone executable compilation (`jse compile`).
- **Database Ecosystem**: Wire-protocol compatibility for MongoDB (SCRAM-SHA-256/1, SRV), Redis (RESP binary), PostgreSQL, MySQL, Cassandra, DynamoDB, and embedded SQLite (`node:sqlite`, `jse.sql`).
- **Container Support**: Container cgroup memory and CPU detection, and signal handling.
- **WebAssembly & Optimizer**: Streaming Wasm compilation, memory compaction, and WASI Preview 1 host calls.
- **Clustering & Concurrency**: Multi-core `node:cluster` with `SO_REUSEPORT` port-sharing, IPC ping-pong, bounded channels, and worker thread pools.
- **Node Drop-In Compatibility**: Comprehensive builtin module coverage, CJS/ESM interop, Buffer pooling, and npm packages (`lodash`, `minimist`, `chalk`, `express`).

## Project layout

```
build.rs        startup snapshot build (JsRuntimeForSnapshot over src/ops.rs)
src/main.rs     CLI (run/eval/repl/etc.), process-level tokio supervisor
src/lib.rs      library root
src/runtime.rs  JsRuntime bootstrap (snapshot + lazy extension init), drivers, REPL
src/loader.rs   module resolution: ESM/TS/CJS/npm/JSON + CJS wrapping + builtins
                + V8 code cache wiring
src/ts.rs       deno_ast (SWC) transpile wrapper + disk cache
src/cache.rs    shared on-disk cache helpers (TS transpile, V8 code cache)
src/ops.rs      op2 ops: sleep_until/timer poke, fs, process, channels, workers,
                text encode/decode, crypto, url, fetch, HTTP server
src/ops_extra.rs  net, TLS client, zlib, dns, os, hmac, child stdio (included
                from ops.rs)
src/logger.rs   structured logger (JSON & text badges, HTTP access logs)
src/panic.rs    global structured panic hook and connection-level panic isolation
src/serve.rs    hyper accept loop with panic isolation and access logging for node:http / jse.serve
src/snapshot.rs include_bytes! of the built startup snapshot
src/worker.rs   worker thread host
src/js/         bootstrap globals (console/process/Buffer/timers/chan/Worker/
                WorkerPool/URL/fetch/jse.log/…) — baked into the startup snapshot
src/js/node/    node: builtin shims (served by the loader)
src/js/internal/CJS wrapper helpers
examples/       hello.ts, cjs_demo, concurrency.js, workers.js, pool.js, pingpong.js
tests/          integration tests + fixtures
```

## Features & Capabilities

- **Core Runtime**: Rust with `forbid(unsafe_code)`, V8 embedded via `deno_core` with a startup snapshot (~998 KB).
- **Concurrency & Parallelism**: Bounded CSP channels (`chan(capacity)`), standard worker threads (`Worker`, `WorkerPool`, `SHARE_ENV`, `MessageChannel`), and process clustering.
- **Clustering (`node:cluster`)**: Supports `isPrimary`, `isWorker`, `fork()`, worker lifecycle events, and two-way IPC messaging. Sockets leverage OS-level `SO_REUSEPORT` & `SO_REUSEADDR` allowing workers to bind directly to the same port.
- **Panic Isolation & Error Handling**: A structured panic hook in `src/panic.rs` captures thread and location information. Connection handlers and request streams are isolated via `catch_unwind_safe` so a panic in one connection does not affect others.
- **Server Resilience (`jse.serve`, `node:http`, `node:http2`)**: Synchronous throws and rejected promises inside HTTP request listeners are caught, logged at `ERROR` level, and return HTTP 500 without terminating the server loop.
- **Structured Logging**: Structured logger in `src/logger.rs` supporting UTC timestamp formatting, level filtering (`DEBUG`, `INFO`, `WARN`, `ERROR`), and two format modes: text with ANSI color badges or single-line JSON. Configurable via `JSE_LOG`, `JSE_LOG_FORMAT`, and `JSE_HTTP_LOG`.
- **Logging API (`jse.log`)**: Built-in `globalThis.jse.log` API (`debug()`, `info()`, `warn()`, `error()`, `level()`, `format()`, `http()`, `configure()`).
- **HTTP Access Logging**: Records HTTP method, request path, status code, latency, client IP/port, and response byte length.
- **Process Failure Recovery**: Standard `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` hooks; timer exception isolation prevents errors in timer callbacks from crashing the V8 event loop.
- **Compression (`node:zlib`)**: Gzip, Deflate, DeflateRaw, Brotli (`brotliCompress`, `brotliDecompress`, stream transforms), auto-detecting `unzipSync`, `unzip`, `createUnzip`, and CRC-32 checksum calculation.
- **Subprocess IPC & Forking (`node:child_process`)**: `child_process.fork()` with bidirectional IPC channels, message buffering, `child.send()`, and `process.send()`.
- **TypeScript & JSX**: Native `.ts`, `.tsx`, `.jsx`, `.mts`, `.cts` transpilation via SWC with disk caching; ECMA decorators; `tsconfig.json` path alias mapping (`@/*`, `baseUrl`).
- **WebSockets**: Client `WebSocket` and server upgrade (`jse.upgradeWebSocket`); RFC 6455 validation; `binaryType = 'nodebuffer' | 'arraybuffer' | 'blob'`; `ws` package compatibility (`WebSocketServer`).
- **HTTP/2 & HTTP/3**: `node:http2` API; ALPN `h2` and cleartext `h2c` prior knowledge multiplexing; streaming request/response bodies; RFC 9114 `Alt-Svc` HTTP/3 discovery advertising.
- **DNS Engine**: RFC 1035 UDP query engine for `resolve4`, `resolve6`, `resolveTxt`, `resolveSrv`, `resolveMx`, `resolveNs`, `resolveCname`, `resolvePtr`, `lookupService`, and `node:dns/promises`.
- **WebAssembly Compilation & Execution (`--wasm`)**: Compile and run applications through WebAssembly with `jse run --wasm app.ts`. Standalone `.wasm` compilation via `jse compile --wasm app.ts -o app.wasm` or direct `.wasm` execution (`jse run app.wasm`). Supports WASI preview-1.
- **Runtime Optimizer (`jse.optimizer`)**:
  - **Memory Compaction**: Monitors heap statistics and executes non-blocking V8 memory compaction during idle turns and after request batches.
  - **JIT Tiering**: Pre-tunes V8 flags (`--wasm-dynamic-tiering`, `--wasm-lazy-compilation`, `--wasm-tier-up`, `--turbo-fast-api-calls`).
  - **WebAssembly JIT Synthesis (`jse.wasm.compile`)**: Compiles mathematical operations into WebAssembly bytecode functions.
  - **HTTP Server Compaction**: Runs compaction sweeps periodically during HTTP request processing.
- **Node Builtin Coverage**: `node:assert`, `node:async_hooks`, `node:buffer`, `node:child_process`, `node:cluster`, `node:console`, `node:constants`, `node:crypto`, `node:diagnostics_channel`, `node:dns`, `node:domain`, `node:events`, `node:fs`, `node:http`, `node:http2`, `node:https`, `node:inspector`, `node:module`, `node:net`, `node:os`, `node:path`, `node:perf_hooks`, `node:process`, `node:punycode`, `node:querystring`, `node:readline`, `node:sqlite`, `node:stream`, `node:string_decoder`, `node:test`, `node:timers`, `node:tls`, `node:tty`, `node:url`, `node:util`, `node:v8`, `node:vm`, `node:wasi`, `node:worker_threads`, `node:ws`, `node:zlib`.
- **Configuration System (`jse.json` / `jse.toml`)**: Configures scripts, permissions, environment variables, and entry points in a single file, with fallback to `package.json`.
- **Shared Key-Value Cache (`jse.kv`)**: In-memory key-value store living in native Rust memory outside the V8 heap, with monotonic versioning, compare-and-swap (`cas`), atomic counters, and TTL expiration.
- **Routing & Static Files (`jse.Router`)**: Radix-tree HTTP router with `:param` extraction, wildcards, and static file streaming with ETag generation and 304 handling.
- **Embedded SQLite (`jse.sql`)**: SQLite engine bundled in the binary, accessible via tagged template literals (`jse.sql`) or standard `node:sqlite`.
- **Production Lifecycle & Metrics (`jse.production` / `jse.metrics`)**: Graceful shutdown handlers on `SIGTERM`/`SIGINT`, prometheus metrics formatting via `jse.metrics.prometheus()`, and health check handlers.
- **File Watching (`jse run --watch` / `jse dev`)**: Recursive file watcher that reloads the application on changes.
- **Standalone Binary Compiler (`jse compile` / `jse build --standalone`)**: Compiles an application into a standalone executable with embedded runtime and zero external dependencies.

## Quick Start & Configuration

### 1. Initialize a Project
```bash
# Generate jse.json (supports comments and trailing commas)
jse init

# Or generate TOML format
jse init --toml
```

### Configuration (`jse.json` / `jse.toml`)

`jse` projects can be configured with a `jse.json` file (supporting comments and trailing commas) or `jse.toml`:

```json
{
  "$schema": "https://jse.dev/schema.json",
  "name": "my-app",
  "version": "1.0.0",

  // 1. TypeScript or JavaScript entry point
  "entry": "src/index.ts",

  // 2. Environment variables with ${VAR:-default} expansion
  "env": {
    "PORT": "3000",
    "NODE_ENV": "development",
    "API_URL": "http://localhost:${PORT:-3000}/v1"
  },

  // 3. Security permissions: "all", "strict", or granular access
  "permissions": "all",

  // 4. Path aliases
  "paths": {
    "@/*": "./src/*"
  },

  // 5. Cluster mode
  // "cluster": "auto",

  // 6. Project scripts executed via `jse <script>` or `jse run <script>`
  "scripts": {
    "dev": "jse dev",
    "start": "jse start",
    "build": "jse build",
    "test": "jse test"
  },

  // 7. Production telemetry
  "production": {
    "port": 3000,
    "metrics": true,
    "logLevel": "info"
  }
}
```

Or in TOML format (`jse.toml`):
```toml
# jse.toml configuration
name = "my-app"
version = "1.0.0"
entry = "src/index.ts"
permissions = "all"

[env]
PORT = "3000"
NODE_ENV = "development"

[paths]
"@/*" = "./src/*"

[scripts]
dev = "jse dev"
start = "jse start"
build = "jse build"
test = "jse test"
```

### 2. Run & Develop
```bash
# Auto-detects jse.json / jse.toml / package.json and runs entry point
jse

# Hot reloading development server (watches files and instantly reloads)
jse dev

# Production server (with automatic multi-core clustering if configured)
jse start

# Run tests
jse test

# Inspect active configuration and resolved environment
jse config show
jse config get entry

# Run any custom script defined in jse.json directly
jse my-script
```

### 3. Build Standalone Single-Binary Executable
```bash
jse build --standalone src/index.ts -o dist/my_app
./dist/my_app
```

### 4. Production Server Example
```typescript
// src/index.ts
const router = new jse.Router();

// 1. Off-heap cache
jse.kv.set("stats:started", Date.now());

// 2. Embedded database
await jse.sql`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, name TEXT);`;

// 3. API Routes
router.get("/healthz", jse.healthCheck());
router.get("/metrics", (req) => new Response(jse.metrics.prometheus()));
router.get("/api/users/:id", async (req) => {
  const user = jse.kv.get(`user:${req.params.id}`);
  return user || { id: req.params.id, status: "active" };
});

// 4. Serve static files with ETags
router.static("/public", "./public", { spa: true });

// 5. Graceful shutdown in production (SIGTERM/SIGINT)
jse.onShutdown(async () => {
  console.log("Draining connections and flushing logs...");
});

// Start HTTP server on port from jse.json or default 3000
const port = Number(process.env.PORT) || 3000;
jse.serve(router.handler(), { port });
```

### 5. NPM Compatibility & Ecosystem Integration

`jse` supports npm packages and standard Node tooling workflows:

#### 1. Package Management
```bash
# Install all dependencies (auto-detects pnpm, yarn, or npm lockfiles)
jse install

# Add packages to project
jse add express lodash
jse install -D typescript @types/node

# Pass through directly to npm
jse npm audit
jse npm publish
```

#### 2. Tool Execution (npx equivalent)
`jse` automatically traverses upward to locate local project binaries in `node_modules/.bin`:
```bash
# Run local tools directly without global installation
jse prettier --check .
jse tsc --noEmit
jse prisma migrate dev

# Or explicitly via `jse x` (npx equivalent)
jse x prettier --write .
```

#### 3. Module Resolution
- **`exports` & `module` fields**: Resolves modern ESM-first and dual CJS/ESM npm packages.
- **`NODE_PATH` Support**: Fully respects `NODE_PATH` for global libraries, workspace monorepos, and containerized volume mounts.

#### 4. Distributable via NPM (`npx jse`)
`jse` includes a complete npm distribution package (`npm/jse`) with platform-specific native binary packages:
- `@jse/darwin-arm64` (Apple Silicon M1/M2/M3/M4)
- `@jse/darwin-x64` (macOS Intel)
- `@jse/linux-x64-gnu` (Linux glibc)
- `@jse/linux-x64-musl` (Alpine Linux musl)
- `@jse/linux-arm64-gnu` (Linux ARM64 glibc)
- `@jse/linux-arm64-musl` (Linux ARM64 musl)
- `@jse/win32-x64` (Windows x64)

Run without installation anywhere Node/npm is present:
```bash
npx jse app.ts
# Or install globally:
npm install -g jse
```

#### 5. Standalone Binary Deployment
With standalone compilation (`jse build --standalone`), you do not need Node or npm on production servers:
```bash
jse build --standalone src/index.ts -o dist/server
```

---

## Container Deployment

`jse` supports containerized environments (Docker, Kubernetes):

### 1. Linux cgroup v1 & v2 Memory & CPU Auto-Detection
`jse` reads container cgroup limits instead of host hardware specs:
- **Memory Quotas**: Inspects `/sys/fs/cgroup/memory.max` (cgroups v2) and `/sys/fs/cgroup/memory/memory.limit_in_bytes` (cgroups v1). `os.totalmem()` and `os.freemem()` report container limits (e.g. 512MB RAM), allowing V8 garbage collection to schedule within container bounds.
- **CPU Bandwidth (CFS Quotas)**: Inspects `/sys/fs/cgroup/cpu.max` and `cpu.cfs_quota_us` to compute allocated container vCPUs, sizing thread and worker pools to container limits.

### 2. PID 1 Signal Forwarding & Graceful Shutdown
When running as PID 1 in a container:
- `jse` intercepts `SIGTERM` and `SIGINT`.
- Automatically dispatches signals to Node.js `process.on('SIGTERM')`, `process.on('SIGINT')`, and `jse.production.onShutdown(hook)`.
- Existing connections and active requests are given time to complete before terminating with code `0`.
- If unhandled, it terminates with standard POSIX container exit codes (143 for `SIGTERM`, 130 for `SIGINT`).

### 3. Container Networking Defaults
- **0.0.0.0 Binding**: `jse.serve` and `node:http` default to `0.0.0.0` rather than `127.0.0.1`, allowing incoming connections across container networks without extra configuration.
- **Environment Variables**: Reads standard environment variables (`PORT`, `HOST`, `NODE_ENV`).

### 4. Production Multi-Stage Dockerfile
```dockerfile
# Build stage
FROM rust:1.85-bookworm AS builder
WORKDIR /usr/src/jse
COPY . .
RUN cargo build --release --bin jse && strip target/release/jse

# Minimal runtime
FROM debian:bookworm-slim
RUN groupadd -g 10001 jse && useradd -u 10001 -g jse -m -s /bin/false jse
COPY --from=builder /usr/src/jse/target/release/jse /usr/local/bin/jse
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
USER jse:jse
HEALTHCHECK --interval=30s --timeout=5s CMD jse -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8000) + '/health').then(r => process.exit(r.ok ? 0 : 1))"
ENTRYPOINT ["/usr/local/bin/jse"]
CMD ["run", "index.js"]
```

---

## Database Support

`jse` supports standard database drivers and wire protocols:

| Database | Supported Drivers / Protocols | Runtime Capabilities Provided |
|---|---|---|
| **MongoDB** | `mongodb`, `mongoose`, BSON | RFC 2898 `crypto.pbkdf2Sync` / `pbkdf2` for **SCRAM-SHA-256** & **SCRAM-SHA-1** auth; `dns.resolveSrv` / `resolveTxt` for `mongodb+srv://` Atlas connections; BSON 64-bit BigInt (`readBigInt64LE`, `writeBigInt64LE`) & slice helpers (`utf8Slice`). |
| **Redis / Valkey** | `ioredis`, `redis` | Binary RESP wire protocol parsing over `node:net` TCP sockets; `setNoDelay`, `setKeepAlive`, `setTimeout`. |
| **CouchDB / PouchDB** | `nano`, `pouchdb` | HTTP/REST JSON streaming via native `fetch()` and `node:http`. |
| **Apache Cassandra / ScyllaDB** | `cassandra-driver` | CQL v4/v5 binary protocol framing; big-endian integer encoding (`writeInt32BE`, `writeUInt16BE`); UUID generation (`crypto.randomUUID()`). |
| **Amazon DynamoDB** | `@aws-sdk/client-dynamodb` | AWS SigV4 HMAC-SHA256 signature derivation; TLS HTTP/1.1 and HTTP/2 transport. |
| **Elasticsearch / OpenSearch** | `@elastic/elasticsearch` | Bulk NDJSON streaming and HTTP keep-alive connection pooling. |
| **SQLite (Built-in)** | `node:sqlite`, `jse.sql` | Node 22+ `DatabaseSync` & `StatementSync` with zero dependencies, plus embedded `jse.sql` tagged templates. |
| **PostgreSQL & MySQL** | `pg`, `pg-pool`, `mysql2` | TCP full-duplex streaming, SCRAM-SHA-256 / MD5 / `caching_sha2_password` auth. |

---

## Docker Compose Example

Run the included stack with MongoDB and Redis:

```bash
docker compose up --build
```

---

## Additional Capabilities

### 1. AEAD Ciphers & Ed25519 Signatures
Uses the Rust `ring` crate for AEAD ciphers and Ed25519 signatures:
- **AEAD Ciphers**: `crypto.createCipheriv` and `crypto.createDecipheriv` support `aes-256-gcm`, `aes-128-gcm`, and `chacha20-poly1305` with 128-bit authentication tags and authenticated additional data (AAD). Tampered ciphertexts trigger authentication errors.
- **Asymmetric Ed25519**: Keypair generation (`crypto.generateKeyPairSync("ed25519")`), signing (`crypto.sign(null, msg, privKey)`), and signature verification (`crypto.verify(null, msg, pubKey, sig)`).

### 2. Unix Domain Sockets (IPC)
POSIX Unix domain stream sockets in `node:net`:
- **Server**: `net.createServer(handler).listen("/var/run/app.sock")`
- **Client**: `net.connect({ path: "/var/run/app.sock" })`

### 3. Single-Binary Standalone Compilation
Pack an application into a standalone native executable:
```bash
# Ahead-of-time compiles TypeScript and bundles into a single binary
jse compile app.ts -o dist/my-service
./dist/my-service
```

### 4. OpenTelemetry Tracing (`jse.trace`)
Built-in tracing in `globalThis.jse.trace`:
- **W3C Trace Context**: Generates and parses `traceparent` headers (`00-<32hex>-<16hex>-01`).
- **Span Scoping**: Synchronous and asynchronous span hierarchies (`jse.trace.startSpan(name, fn)`).
- **Error Recording**: Captures exceptions, stack traces, and marks span status as `ERROR`.
- **OTLP Export**: `jse.trace.export("otlp")` outputs standard OTLP JSON.

### 5. Embedded Persistent Task Queue (`jse.queue`)
Background job and message queue in `globalThis.jse.queue` backed by SQLite:
- **Durability**: Backed by SQLite database transactions.
- **Atomic Leasing**: `q.pop(topic, leaseMs)` claims jobs with automatic visibility timeouts.
- **Dead-Letter Queues (DLQ)**: Moves failed tasks to DLQ after configurable `maxRetries`.
- **Delivery**: Explicit `q.ack(id)` and backoff `q.nack(id, delayMs)` semantics.
