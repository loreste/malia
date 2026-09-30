# Malia

A JavaScript/TypeScript and WebAssembly runtime written in Rust. It uses V8
(via `deno_core`) for execution, tokio for the event loop, `deno_ast` (SWC)
for TypeScript transpilation, and a Node-compatible module resolver for npm
packages.

The binary is available under two names, `malia` and `jse`. They are the
same program. In code, the `malia.*` and `jse.*` globals are also the same.

Guides for common tasks are in [docs/HOWTO.md](docs/HOWTO.md).

## Installation

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the
archives below and attaches them to a GitHub release. The install scripts
download from the latest release. No release has been published yet, so
until one is, build from source.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh
```

Installs `malia` to `~/.malia/bin` and creates a `jse` alias.

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex
```

Installs `malia.exe` and `jse.exe` to `%LOCALAPPDATA%\malia\bin` and adds that directory to `PATH`.

**Manual download**

Archives are attached to each [GitHub release](https://github.com/loreste/malia/releases):

| Platform | Archive |
|---|---|
| macOS arm64 | `malia-darwin-arm64.tar.gz` |
| macOS x64 | `malia-darwin-x64.tar.gz` |
| Linux x64 (glibc) | `malia-linux-x64-gnu.tar.gz` |
| Linux x64 (musl) | `malia-linux-x64-musl.tar.gz` |
| Linux arm64 | `malia-linux-arm64-gnu.tar.gz` |
| Windows x64 | `malia-win32-x64.zip` |

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

malia compile examples/hello.ts -o dist/hello   # standalone native executable
malia compile --wasm examples/hello.ts -o app.wasm
malia run app.wasm
```

### Commands

| Command | Description |
|---|---|
| `malia` | Run the entry point from the project config (see [Configuration](#configuration)); opens the REPL if none is found |
| `malia run <file\|dir>` | Run a `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`, `.jsx`, or `.wasm` file. `--watch` restarts on file changes; `--wasm` runs the program through WebAssembly |
| `malia eval <code>` | Evaluate a snippet as an ES module |
| `malia repl` | Start the REPL |
| `malia init [--toml]` | Create a project config file |
| `malia dev` | Run the entry point and restart on file changes |
| `malia start` | Run the entry point; forks cluster workers when `cluster` is configured |
| `malia test` | Run tests (`node:test`, TAP output) |
| `malia install` / `add` / `i` | Install npm dependencies (detects npm, pnpm, or yarn lockfiles) |
| `malia x <bin>` | Run a binary from `node_modules/.bin`, falling back to npx |
| `malia npm <args>` | Pass arguments through to npm |
| `malia config [show\|get <key>]` | Print the resolved configuration |
| `malia compile <file>` | Compile to a standalone executable, or to `.wasm` with `--wasm` |
| `malia build` | Build a standalone executable from the configured entry point |
| `malia bench <file>` | Run a file and print its wall-clock time |
| `malia <script>` | Run a script defined in the config file or `package.json` |

### Node-compatible flags

`-r/--require`, `--import`, `-e/--eval`, `-p/--print`, `-c/--check`,
`-i/--interactive`, `-v/--version`, `--no-warnings`, `--max-old-space-size`,
`--inspect[=host:port]`, `--inspect-brk[=host:port]`,
and `--enable-source-maps` are accepted. Flags in `NODE_OPTIONS` are read as
well. When invoked through a `node` symlink, `--version` prints `v20.18.0`.

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

- **Execution**: V8 150.4 from `deno_core` 0.412.
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
| ECMAScript | Whatever V8 150.4 supports, including ES2024 and ES2025 features (`Promise.withResolvers`, `Object.groupBy`, `RegExp.escape`, `Promise.try`, `Float16Array`, Set methods, iterator helpers). See `tests/fixtures/es_features.js` |
| Import attributes | `with { type: "json" }`. `text` and `bytes` are not supported |
| TypeScript | `.ts`, `.mts`, `.cts`, `.tsx`, `.jsx` transpiled; `.cts` loads as CommonJS; `tsconfig.json` `paths` and `baseUrl`; ECMA decorators |
| ESM | Static and dynamic import, top-level await, `import.meta` |
| CommonJS | `.cjs`, and `.js` in packages without `"type": "module"`; `module`, `exports`, `require`, `__filename`, `__dirname` |
| npm | Bare specifiers; `exports` conditions `import`/`require`/`node`/`default` and subpath patterns; `imports` (`#…`); `NODE_PATH` |
| WebAssembly | `import m from "./m.wasm"`, `require("./m.wasm")`, `WebAssembly.compileStreaming`/`instantiateStreaming`, WASI Preview 1 (`node:wasi`) |

## Runtime APIs

| API | Description |
|---|---|
| `fetch`, `Request`, `Response`, `Headers` | reqwest + rustls. Decodes gzip, deflate, and Brotli responses; `redirect` may be `follow`, `manual`, or `error`. Response bodies stream (`response.body` is async-iterable and has `getReader()`). Request bodies: string, `URLSearchParams`, `Blob`, `FormData`, `ArrayBuffer`/typed arrays, and streamed (chunked) `ReadableStream`/async iterables |
| `jse.serve(options, handler)` | Deno-style HTTP server. Handler returns a `Response` or a promise of one. Supports keep-alive, whole and chunked bodies, TLS |
| `WebSocket`, `jse.upgradeWebSocket(req)` | WebSocket client and server upgrade. `binaryType` may be `nodebuffer`, `arraybuffer`, or `blob` |
| `chan(capacity?)` | Channels with `send`/`recv`/`close`/`for await`, backed by tokio mpsc. Bounded channels apply backpressure |
| `Worker`, `WorkerPool` | One OS thread and V8 isolate per worker. Messages use V8 structured clone. `new WorkerPool(path, { size })`, `pool.run(arg)`, `pool.map(items)`, `pool.stream(arg)` (async iterable of multiple replies), `pool.close()` |
| `structuredClone` | V8 value serializer |
| `URL`, `URLSearchParams` | `URL` via the `url` crate; `URLSearchParams` in JS |
| `jse.Router` | Router with `:param` and wildcard routes; `router.static()` serves files with ETag and 304 handling |
| `jse.kv` | In-process key-value store held outside the V8 heap. Versioning, compare-and-swap, counters, TTL |
| `jse.sql` | Embedded SQLite via tagged templates; `jse.sql.open(path)` returns a `Database` |
| `jse.queue` | SQLite-backed task queue: `push`, `pop` with lease, `ack`, `nack`, dead-letter via `dead` |
| `jse.trace` | Spans, W3C `traceparent` inject/extract, OTLP JSON export |
| `jse.log` | Structured logger (text or JSON). Configured with `JSE_LOG`, `JSE_LOG_FORMAT`, `JSE_HTTP_LOG` |
| `jse.onShutdown`, `jse.healthCheck`, `jse.metrics` | Shutdown hooks on SIGTERM/SIGINT, a health-check handler, Prometheus-format metrics |
| `jse.optimizer` | Sets V8 Wasm tiering flags and triggers V8 memory compaction during idle turns and between request batches |

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

## Node builtins

| Module | Implemented |
|---|---|
| `assert`, `assert/strict` | `ok`, `equal`, `strictEqual`, `deepEqual`, `deepStrictEqual` (Map/Set/Date/RegExp/typed array aware), `match`, `doesNotMatch`, `ifError`, `throws`/`rejects` with class, RegExp, object, or function validation, `strict` |
| `async_hooks` | `AsyncLocalStorage` (context propagates across `await` via Promise.then patching), `AsyncResource` with `runInAsyncScope` and `bind` |
| `buffer` | `Buffer` backed by `Uint8Array`, allocations of 4 KB or less come from a shared 8 KB pool (as in Node). Encodings: utf8, base64, hex, latin1, utf16le, ascii |
| `child_process` | `spawn`, `exec`, `execFile`, their `*Sync` forms, `fork` with IPC |
| `cluster` | `isPrimary`, `isWorker`, `fork`, lifecycle events, IPC. Workers bind the same port with `SO_REUSEPORT` |
| `console` | `log`, `info`, `warn`, `error`, `debug`, `trace`, `assert`, `time`, `timeEnd`, `timeLog`, `count`, `countReset`, `table`, `dir`, `group`, `groupEnd`, `groupCollapsed`, `clear` |
| `crypto` | `createHash` and `hash` (md5, sha1, sha224, sha256, sha384, sha512, sha512-256; `copy()`), `createHmac`, `randomBytes`, `randomInt`, `randomUUID`, `timingSafeEqual`, `pbkdf2`, `scrypt`; ciphers `aes-{128,192,256}-{cbc,ctr}`, `aes-{128,256}-gcm`, `chacha20-poly1305`; `KeyObject`, `createPrivateKey`/`createPublicKey`/`createSecretKey` (PEM, DER, JWK; PKCS#1, PKCS#8, SEC1, SPKI), `generateKeyPair(Sync)` for RSA, EC (P-256/384/521), Ed25519; `sign`/`verify`, `createSign`/`createVerify` (RSA PKCS#1 v1.5 and PSS, ECDSA DER or IEEE P1363, Ed25519); `publicEncrypt`/`privateDecrypt` (OAEP, PKCS#1 v1.5); `createECDH` (P-256, P-384, P-521, X25519), `diffieHellman`; `webcrypto` |
| `diagnostics_channel` | `channel`, `subscribe`, `unsubscribe`, `hasSubscribers`, `tracingChannel` (`traceSync`, `tracePromise`, `traceCallback`) |
| `dgram` | UDP sockets: `createSocket`, `bind`, `send`, `close`, message events, auto-bind on send |
| `dns`, `dns/promises` | `lookup`, `lookupService`, `resolve4`, `resolve6`, `resolveTxt`, `resolveSrv`, `resolveMx`, `resolveNs`, `resolveCname`, `resolvePtr`, `reverse` |
| `domain` | `create`, `Domain` |
| `events` | `EventEmitter`, `once`, `on` (async iterator), `getEventListeners`, `defaultMaxListeners` |
| `fs`, `fs/promises` | Sync, callback, and promise APIs with Node's error shape (`code`, `errno`, `syscall`, `path`): read/write with `flag`, `mode`, and encodings, `stat` (`throwIfNoEntry`), `readdir` (`recursive`, `withFileTypes`), `mkdir`, `rm`, `cp`, `copyFile` (`COPYFILE_EXCL`), `rename`, `link`, `symlink`, `utimes`, `opendir`, file descriptors, `FileHandle`, streams, `watch` (native inotify/kqueue/FSEvents via notify, falls back to polling), `watchFile` |
| `http`, `https` | `createServer`, `request`, `get`, `IncomingMessage`, `ServerResponse`, `Agent`, `globalAgent`, `STATUS_CODES`, `validateHeaderName`/`validateHeaderValue`. The server shares the hyper engine with `jse.serve`; client responses are `Readable` streams |
| `http2` | Server and client; ALPN `h2` and cleartext `h2c` with prior knowledge |
| `inspector` | `Session` (connects to the running V8 inspector over WebSocket), `open`, `close`, `url`. See [Debugging](#debugging) |
| `module` | `createRequire`, `builtinModules`, `isBuiltin`, `Module` |
| `net`, `tls` | TCP, Unix domain sockets, and Windows named pipes; `Socket`, `Server`, `isIP`, `SocketAddress`, `BlockList` |
| `os` | `cpus` (real brand/frequency/times), `loadavg`, `uptime`, `totalmem`, `freemem`, `networkInterfaces` (MAC addresses), `userInfo`, `hostname`, `platform`, `arch`, `type`, `release`, `version`, `machine`, `availableParallelism`, `tmpdir`, `homedir`, `endianness`. Reports cgroup limits inside containers |
| `path` | Port of Node's implementation; `posix` and `win32`, with the platform's variant as the default |
| `perf_hooks` | `performance.mark`, `performance.measure`, `performance.getEntries`, `PerformanceObserver` (fires callbacks on entries), `monitorEventLoopDelay` |
| `process` | `argv`, `env` (mutations propagate to child processes), `cwd`, `chdir`, `nextTick`, `hrtime`, `hrtime.bigint`, `memoryUsage`, `cpuUsage`, `exit`, `stdin` (readable stream), `stdout`/`stderr` (writable streams), `uncaughtException`/`unhandledRejection`/`SIGTERM`/`SIGINT` events, `emitWarning`, `umask` |
| `punycode`, `querystring`, `readline`, `string_decoder`, `timers`, `tty`, `constants` | Available |
| `sqlite` | `DatabaseSync`, `StatementSync` (Node 22 API) |
| `stream`, `stream/promises`, `stream/consumers`, `stream/web` | Node's stream implementation (readable-stream 4): `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `compose`, backpressure, `toWeb`/`fromWeb`; consumers; WHATWG streams |
| `test` | `test`, `describe`, `it`, `before`/`after`/`beforeEach`/`afterEach`, TAP output |
| `url` | `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL` |
| `util`, `util/types` | `format`, `inspect`, `promisify`, `callbackify`, `inherits`, `deprecate`, `isDeepStrictEqual`, type predicates |
| `v8` | `getHeapStatistics`, `serialize`, `deserialize`, `Serializer`, `Deserializer` |
| `vm` | `createContext`, `runInContext`, `runInNewContext`, `runInThisContext`, `Script` |
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

Tested with modern framework packages (npm packages executed end-to-end):

- **Angular**: `@angular/core` (Signals, `signal()`, `computed()`, Dependency Injection, `Injector`, `InjectionToken`) and `rxjs` (`Observable`, `map`, `filter`)
- **Vue 3**: `vue` + `@vue/server-renderer` (Server-Side Rendering via `createSSRApp` and `renderToString`)
- **React 19**: `react` + `react-dom/server` (`renderToString` component tree rendering)
- **Preact**: `preact` + `preact-render-to-string` (SSR component rendering)
- **Svelte 5**: `svelte/compiler` (compiling Svelte 5 components) + `svelte/server` (`render`)
- **Fastify 5**: `fastify` (route registration and request dispatch via `inject`)
- **Express 5**: `express` (routing, query parsing, middleware, static files)

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

- `Blob` contents are held in memory (same as Node).
- Crypto: no encrypted (passphrase-protected) PEM import/export, RSA key
  generation only for 2048/3072/4096/8192 bits with exponent 65537, and
  RSA-PSS salt length must equal the digest length.
- Windows: `node:cluster` workers cannot share a port (it relies on
  `SO_REUSEPORT`), and `chmod` only toggles the read-only attribute.
- HTTP server request bodies are read fully into memory. The `node:http`
  client sends buffered bodies with `Content-Length` and `Connection: close`,
  and `http.Agent` does not pool connections.
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
