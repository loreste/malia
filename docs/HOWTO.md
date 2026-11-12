# Malia How-To Guide

Examples for common tasks. `malia` and `jse` are the same binary, and the
`malia.*` and `jse.*` globals are the same object; this guide uses `jse`.

## Contents

1. [Project configuration](#1-project-configuration)
2. [TypeScript](#2-typescript)
3. [Running existing Node.js applications](#3-running-existing-nodejs-applications)
4. [Standalone executables](#4-standalone-executables)
5. [Databases](#5-databases)
6. [HTTP, WebSockets, and IPC](#6-http-websockets-and-ipc)
7. [Tracing and logging](#7-tracing-and-logging)
8. [Task queue](#8-task-queue)
9. [Cryptography and permissions](#9-cryptography-and-permissions)
10. [Workers and clustering](#10-workers-and-clustering)
11. [WebAssembly](#11-webassembly)
12. [Container deployment](#12-container-deployment)
13. [Debugging](#13-debugging)
14. [UDP sockets](#14-udp-sockets)
15. [AI toolkit](#15-ai-toolkit)
16. [Hot module replacement](#16-hot-module-replacement)
17. [Package management](#17-package-management)
18. [Concurrency](#18-concurrency)
19. [Cron scheduler](#19-cron-scheduler)
20. [Security](#20-security)
21. [Developer tools](#21-developer-tools)
22. [Deployment](#22-deployment)
23. [Profiling](#23-profiling)
24. [Database migrations](#24-database-migrations)
25. [Env encryption](#25-env-encryption)
26. [Pub/Sub](#26-pubsub)
27. [Caching](#27-caching)

---

## 1. Project configuration

`jse init` writes a `jse.json` (`jse init --toml` writes `jse.toml`). Config
files are searched in this order: `malia.json`, `malia.toml`,
`malia.config.json`, `jse.json`, `jse.toml`, `jse.config.json`, then
`package.json`.

```jsonc
{
  "name": "payment-service",
  "version": "1.0.0",
  "main": "src/server.ts",
  "env": {
    "NODE_ENV": "development",
    "PORT": "8080"
  },
  "permissions": {
    "read": ["./", "/tmp"],
    "write": ["./logs", "/tmp"],
    "net": ["0.0.0.0", "api.stripe.com", "postgres.internal"]
  },
  "scripts": {
    "dev": "jse run --watch src/server.ts",
    "start": "jse run src/server.ts",
    "test": "jse test",
    "compile": "jse compile src/server.ts -o dist/payment-service"
  }
}
```

| Command | Action |
|---|---|
| `jse` | Run the configured entry point, or open the REPL if there is none |
| `jse run <file>` | Run a `.js`, `.ts`, `.mjs`, `.cjs`, or `.wasm` file |
| `jse dev` | Run the entry point and restart on file changes |
| `jse test` | Run tests (`node:test`, TAP output) |
| `jse install` | Install dependencies from package.json (built-in or delegates to npm/yarn/pnpm) |
| `jse install <pkg>` / `jse add <pkg>` | Add a package, update package.json |
| `jse install -g <pkg>` | Install a package globally to `~/.malia/bin` |
| `jse uninstall <pkg>` / `jse rm` | Remove a package |
| `jse list` / `jse ls` | List installed packages |
| `jse x <bin>` | Run a binary from `node_modules/.bin`, falling back to npx |
| `jse compile <file>` | Embed entry source and permissions in the host runtime |
| `jse config show` | Print the resolved configuration |
| `jse <script>` | Run a script from the config file or `package.json` |

---

## 2. TypeScript

TypeScript is transpiled with SWC at load time and cached on disk. Types are
not checked; run `tsc --noEmit` (for example `jse x tsc --noEmit`) for that.

```typescript
// src/app.ts
interface Customer {
  id: string;
  name: string;
  balance: number;
}

function summarize(c: Customer): string {
  return `${c.name} (${c.id}): $${c.balance.toFixed(2)}`;
}

console.log(summarize({ id: "C-109", name: "Alice Smith", balance: 450.5 }));
```

```bash
jse run src/app.ts
```

Path aliases from `tsconfig.json` (`baseUrl`, `paths`) are resolved:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@models/*": ["src/models/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}
```

```typescript
import { User } from "@models/user.ts";
import { formatCurrency } from "@utils/format.ts";
```

---

## 3. Running existing Node.js applications

Applications that use `node_modules` and Node core APIs can be run directly.
Native addons (`.node` files) are not supported.

```javascript
// server.js
const express = require("express");
const app = express();

app.use(express.json());
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.post("/users", (req, res) => res.status(201).json({ id: 1, ...req.body }));

app.listen(8080, () => console.log("listening on 8080"));
```

```bash
jse run --allow-net --allow-read --allow-env server.js
```

For SSR frameworks, the runtime defines `window`, `self`, `global`,
`navigator`, `DOMException`, `btoa`, `atob`, `MessageChannel`, and
`AsyncLocalStorage`. `AsyncLocalStorage` keeps its store across `await`:

```javascript
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

als.run({ requestId: "req-998" }, async () => {
  console.log(als.getStore().requestId); // req-998
  await new Promise((r) => setTimeout(r, 20));
  console.log(als.getStore().requestId); // req-998
});
```

### Migrating CPU-heavy work to WorkerPool

If your Node app has endpoints that do CPU-intensive work on the main
thread, you can move them to a WorkerPool with minimal changes.

**Before (Node — blocks the event loop):**

```javascript
import express from "express";
const app = express();

app.post("/pdf", (req, res) => {
  // This blocks every other request while it runs
  const result = generateReport(req.body);
  res.json({ url: result.url });
});

function generateReport(data) {
  // CPU-heavy: template rendering, data crunching, image processing
  let output = "";
  for (const row of data.rows) {
    output += formatRow(row); // 50ms per row, 1000 rows = 50 seconds blocked
  }
  return { url: "/reports/" + data.id + ".pdf" };
}
```

**After (Malia — runs in parallel, main thread stays free):**

```javascript
// report_worker.js
onmessage = (e) => {
  const data = e.data;
  let output = "";
  for (const row of data.rows) {
    output += formatRow(row);
  }
  postMessage({ url: "/reports/" + data.id + ".pdf" });
};
```

```javascript
import express from "express";
const app = express();
const pool = new WorkerPool("./report_worker.js");

app.post("/pdf", async (req, res) => {
  // Runs on a worker thread — other requests keep flowing
  const result = await pool.run(req.body);
  res.json(result);
});
```

Three lines changed. The endpoint is now non-blocking and runs across
all available cores.

### Replacing manual worker_threads with WorkerPool

**Before (Node — manual worker lifecycle):**

```javascript
import { Worker } from "worker_threads";

async function processItems(items) {
  const results = [];
  for (const item of items) {
    const result = await new Promise((resolve, reject) => {
      const w = new Worker("./process.js", { workerData: item });
      w.on("message", resolve);
      w.on("error", reject);
      w.on("exit", (code) => {
        if (code !== 0) reject(new Error("worker exit " + code));
      });
    });
    results.push(result);
  }
  return results;
}
```

**After (Malia — one line):**

```javascript
const pool = new WorkerPool("./process.js");
const results = await pool.map(items);
pool.close();
```

Same result. No manual worker lifecycle, no error wiring, automatic
reuse and parallelism across cores.

### Adding backpressure with channels

**Before (Node — unbounded queue, memory grows):**

```javascript
const queue = [];

app.post("/ingest", (req, res) => {
  queue.push(req.body); // no limit, grows forever under load
  res.sendStatus(202);
});

setInterval(() => {
  while (queue.length > 0) {
    process(queue.shift());
  }
}, 100);
```

**After (Malia — bounded channel, producer waits when full):**

```javascript
const ch = chan(100); // max 100 buffered items

app.post("/ingest", async (req, res) => {
  await ch.send(req.body); // waits if buffer is full
  res.sendStatus(202);
});

(async () => {
  for await (const item of ch) {
    process(item);
  }
})();
```

The channel applies backpressure automatically. Under load, `send()`
waits instead of growing memory without bound.

### Hot reload via require.cache

Test runners and dev tools clear `require.cache` to force a module
to reload. This works the same as Node:

```javascript
const resolved = require.resolve("./config.js");
delete require.cache[resolved];
const fresh = require("./config.js"); // re-reads and re-executes the file
```

---

## 4. Standalone executables

`jse compile` transpiles the application and writes an executable that
contains the runtime, the startup snapshot, and the application code. The
target machine does not need Node.js or `jse` installed.

```bash
jse compile src/server.ts -o dist/my-service
./dist/my-service
```

`jse build` does the same using the entry point from the config file.

---

## 5. Databases

Database drivers are regular npm packages. The examples below assume the
package is installed and the program is run with `--allow-net`.

### MongoDB

```javascript
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://root:example@localhost:27017");
await client.connect();

const orders = client.db("app").collection("orders");
await orders.insertOne({ orderId: "ORD-1", amount: 199.95, date: new Date() });
console.log(await orders.findOne({ orderId: "ORD-1" }));

await client.close();
```

### Redis

```javascript
import Redis from "ioredis";

const redis = new Redis("redis://localhost:6379");
await redis.set("session:42", JSON.stringify({ name: "Bob" }), "EX", 3600);
console.log(JSON.parse(await redis.get("session:42")));
await redis.quit();
```

### PostgreSQL

```javascript
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://postgres:secret@localhost:5432/app" });
const { rows } = await pool.query("SELECT NOW() AS now, 1 + 1 AS two");
console.log(rows[0]);
await pool.end();
```

### SQLite

SQLite is compiled into the binary. `jse.sql` runs statements against a
default in-memory database; `jse.sql.open(path)` opens a file. Interpolated
values are passed as bound parameters. `SELECT`, `PRAGMA`, and `EXPLAIN`
return rows; other statements return the exec result.

```javascript
const db = jse.sql.open("app.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL
  )
`);

const name = "Alice";
const email = "alice@example.com";
db.sql`INSERT OR REPLACE INTO users (name, email) VALUES (${name}, ${email})`;

const users = db.sql`SELECT * FROM users WHERE email = ${email}`;
console.log(users[0]);
```

The Node 22 `node:sqlite` API is also available:

```javascript
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, key TEXT, val REAL)");
db.prepare("INSERT INTO metrics (key, val) VALUES (?, ?)").run("cpu", 42.5);
console.log(db.prepare("SELECT * FROM metrics WHERE key = ?").get("cpu"));
```

---

## 6. HTTP, WebSockets, and IPC

### HTTP server

The handler receives a `Request` and returns a `Response` or a promise of one.
`req.url` is the request target as sent by the client (usually a path), so
pass a base when constructing a `URL`.

```javascript
jse.serve({ port: 8000, hostname: "0.0.0.0" }, (req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/ping") {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("Not Found", { status: 404 });
});
```

### Server options

```javascript
jse.serve({
  port: 3000,
  hostname: "0.0.0.0",
  limits: {
    maxBodyBytes: 50 * 1024 * 1024,  // 50 MB (default: 10 MB)
    requestTimeoutMs: 120000,         // 2 minutes (or: timeout, handlerTimeout)
  },
}, handler);
```

Large request bodies (> `maxBodyBytes`) are streamed through a channel
instead of being rejected. The handler reads them via `req.body` or
`await req.text()`.

### Hot reload (see also [section 16](#16-hot-module-replacement))

```javascript
const server = jse.serve({ port: 3000 }, handler);
await server.hot("./handler.mjs");   // watch file, reload on change
server.reload(newHandler);            // programmatic swap
```

### Router

```javascript
const router = new jse.Router();

router.get("/healthz", jse.healthCheck());
router.get("/metrics", () => new Response(jse.metrics.prometheus()));
router.get("/api/users/:id", (req) => ({ id: req.params.id }));
router.static("/public", "./public", { spa: true });

jse.serve(router.handler(), { port: 3000 });
```

### WebSocket server

```javascript
jse.serve({ port: 8080 }, (req) => {
  const upgrade = jse.upgradeWebSocket(req);
  if (upgrade) {
    const { socket, response } = upgrade;
    socket.onmessage = (event) => socket.send(`echo: ${event.data}`);
    return response;
  }
  return new Response("not a websocket request", { status: 400 });
});
```

### Unix domain sockets

Server:

```javascript
import net from "node:net";
import fs from "node:fs";

const path = "/tmp/service.sock";
if (fs.existsSync(path)) fs.unlinkSync(path);

net.createServer((sock) => {
  sock.on("data", (chunk) => sock.write(`ack: ${chunk}`));
}).listen(path);
```

Client:

```javascript
import net from "node:net";

const client = net.connect({ path: "/tmp/service.sock" }, () => client.write("hello"));
client.on("data", (data) => {
  console.log(data.toString());
  client.end();
});
```

---

## 7. Tracing and logging

### Spans

`jse.trace.startSpan(name, fn)` runs `fn` inside a span, ends the span when
`fn` returns or its promise settles, and records any thrown error. Spans
started inside `fn` become children. Without `fn`, it returns an open span
that must be ended with `span.end()`.

```javascript
jse.trace.startSpan("handle_checkout", (root) => {
  root.setAttribute("http.route", "/checkout");

  jse.trace.startSpan("charge_card", (child) => {
    child.addEvent("authorized", { code: "AUTH_883" });
  });

  return root.toTraceparent(); // "00-<32 hex>-<16 hex>-01"
});

const otlp = jse.trace.export("otlp"); // OTLP JSON object
```

### Propagating context

```javascript
// Outgoing request
const span = jse.trace.startSpan("call_downstream");
const headers = jse.trace.inject(span, {}); // { traceparent: "00-..." }
await fetch("http://downstream/api", { headers });
span.end();

// Receiving service
const parent = jse.trace.extract(Object.fromEntries(req.headers)); // { traceId, parentSpanId, flags } or null
jse.trace.startSpan("downstream_operation", parent ?? {}, (span) => {
  // span.traceId matches the caller's trace
});
```

### Logging

```bash
export JSE_LOG=debug        # debug | info | warn | error
export JSE_LOG_FORMAT=json  # text | json
```

```javascript
jse.log.info("order processed", { orderId: 8810, amount: 49.99 });
jse.log.warn("rate limit approaching", { current: 480, limit: 500 });
jse.log.error("payment failed", new Error("card declined"));
```

With `JSE_LOG_FORMAT=json`, each entry is written as one JSON object per line.

---

## 8. Task queue

`jse.queue.open(path)` opens a queue stored in a SQLite database
(`:memory:` if no path is given).

```javascript
const q = jse.queue.open("./tasks.db");

const id = q.push("emails", { to: "user@example.com" }, {
  maxRetries: 3, // default 5
  delayMs: 5000, // not deliverable for 5 s
});
```

`pop(topic, leaseMs)` claims the next pending job for `leaseMs`
milliseconds (default 30000). If the job is not acknowledged before the
lease expires, it becomes available again.

```javascript
const job = q.pop("emails", 30000);
if (job) {
  try {
    await sendEmail(job.payload);
    q.ack(job.id, job.token);
  } catch {
    q.nack(job.id, job.token, 5000); // retry after 5 s; moved to dead-letter after maxRetries
  }
}

console.log(q.dead("emails")); // jobs that exceeded maxRetries
```

---

## 9. Cryptography and permissions

### AES-GCM

Supported AEAD ciphers: `aes-128-gcm`, `aes-256-gcm`, `chacha20-poly1305`.
`decipher.final()` throws if the ciphertext, tag, or AAD was modified.

```javascript
import crypto from "node:crypto";

const key = crypto.randomBytes(32);
const iv = crypto.randomBytes(12);
const aad = Buffer.from("tenant-100");

const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(aad);
const encrypted = Buffer.concat([cipher.update("secret", "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();

const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAAD(aad);
decipher.setAuthTag(tag);
const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
console.log(decrypted.toString("utf8")); // secret
```

### Ed25519

```javascript
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const message = Buffer.from("payload");
const signature = crypto.sign(null, message, privateKey);
console.log(crypto.verify(null, message, publicKey, signature)); // true
```

### Permissions

`jse run` denies file, network, subprocess, and environment access unless a
flag grants it:

```bash
jse run --allow-read=./assets --allow-net=api.stripe.com src/server.ts
jse run --allow-all src/server.ts
```

---

## 10. Concurrency and parallelism

JavaScript is single-threaded. Node works around this with an event loop
and `worker_threads`, but CPU-bound work still blocks the main thread,
worker setup is manual, and there is no built-in pool or channel primitive.

Malia provides three things Node does not: a worker pool, bounded channels,
and streaming workers. Each worker runs its own V8 isolate on a dedicated
OS thread. I/O runs on a separate tokio runtime. The JS thread never
competes with network handling.

### WorkerPool

Dispatch CPU work to a fixed set of workers. Default size is `cpus - 1`,
leaving one core free for the main thread and I/O. Override with
`{ size: N }`.

```javascript
// worker.js
onmessage = (e) => postMessage(e.data * 2);
```

```javascript
const pool = new WorkerPool("./worker.js", { size: 8 });

// Single task
const result = await pool.run(21); // 42

// Parallel map
const results = await pool.map([1, 2, 3, 4, 5]); // [2, 4, 6, 8, 10]

pool.close();
```

Options: `{ size, maxQueue, maxBuffered, timeoutMs }`. Jobs that exceed
`timeoutMs` are terminated and the worker is replaced. `maxQueue` rejects
new work when the backlog is full. Cancellation via `AbortSignal`:

```javascript
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);
try {
  await pool.run(heavyInput, { signal: controller.signal });
} catch (e) {
  // e.message: "job aborted"
}
```

### Streaming workers

When a single task produces multiple results, use `pool.stream()` instead
of `pool.run()`. The worker sends results one at a time; the caller
consumes them as an async iterator.

```javascript
// stream_worker.js
onmessage = (e) => {
  for (const item of e.data) {
    postMessage(transform(item));
  }
  postMessage({ __done: true });
};
```

```javascript
const pool = new WorkerPool("./stream_worker.js", { size: 4 });
for await (const result of pool.stream(largeDataset)) {
  process(result);
}
pool.close();
```

### Bounded channels

Channels are typed message queues between async tasks within one isolate.
Bounded channels apply backpressure: `send()` waits when full.

```javascript
const ch = chan(10); // capacity 10; chan() for unbounded

// Producer
(async () => {
  for (let i = 0; i < 100; i++) {
    await ch.send(i); // blocks when 10 items buffered
  }
  ch.close();
})();

// Consumer
for await (const msg of ch) {
  console.log(msg);
}
```

Channels work between any async contexts in the same isolate: timers,
promises, request handlers. They do not cross worker boundaries; use
`postMessage` for that.

### Raw workers

Standard `Worker` and `worker_threads` APIs work for cases where the pool
abstraction doesn't fit. Each worker is a separate V8 isolate with its
own event loop.

```javascript
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (!isMainThread) {
  parentPort.on("message", (msg) => parentPort.postMessage(msg + " world"));
} else {
  const w = new Worker(new URL(import.meta.url));
  w.postMessage("hello");
  w.on("message", (msg) => {
    console.log(msg); // "hello world"
    w.terminate();
  });
}
```

### node:cluster

Workers bind the same port with `SO_REUSEPORT`. The OS distributes
connections; no primary-process bottleneck.

```javascript
import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";

if (cluster.isPrimary) {
  for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
  cluster.on("exit", () => cluster.fork());
} else {
  http.createServer((req, res) => {
    res.end(`worker ${process.pid}\n`);
  }).listen(8080);
}
```

### How it differs from Node

| | Node | Malia |
|---|---|---|
| Worker setup | Manual thread, manual message loop | `WorkerPool` with dispatch, timeout, cancellation |
| Parallel map | Write your own | `pool.map(items)` |
| Backpressure | None between async tasks | Bounded `chan(capacity)` |
| HTTP I/O | Same thread as JS | Separate tokio runtime |
| Async file/crypto | libuv pool (4 threads default) | tokio blocking pool (scales to CPU count) |
| Worker dispatch | ~10us/msg | ~0.04us/msg |

---

## 11. WebAssembly

`.wasm` files can be imported directly. Exports are available on the
default import.

```javascript
import math from "./math.wasm";
console.log(math.add(40, 2));
```

```bash
jse run --wasm app.ts                 # select Wasm options; JavaScript still runs in V8
jse compile --wasm app.ts -o app.wasm # compile to a .wasm file
jse run app.wasm
```

`jse.optimizer` triggers V8 memory compaction during idle event-loop turns
and between HTTP request batches.

---

## 12. Container deployment

- `os.totalmem()`, `os.freemem()`, and the default worker pool size use the
  container's cgroup limits.
- As PID 1, SIGTERM and SIGINT run `process.on("SIGTERM"/"SIGINT")`
  handlers and `jse.onShutdown` hooks before exiting.
- `jse.serve` and `node:http` bind to `0.0.0.0` by default.

```javascript
jse.onShutdown(async () => {
  await dbPool.end();
});
```

### Dockerfile

```dockerfile
FROM rust:1.85-bookworm AS builder
WORKDIR /usr/src/jse
COPY . .
RUN cargo build --release --bin jse && strip target/release/jse

FROM debian:bookworm-slim
RUN groupadd -g 10001 jse && useradd -u 10001 -g jse -m -s /bin/false jse
COPY --from=builder /usr/src/jse/target/release/jse /usr/local/bin/jse

WORKDIR /app
COPY package.json jse.json ./
COPY src/ ./src/

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER jse:jse
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD jse -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1))"

ENTRYPOINT ["/usr/local/bin/jse"]
CMD ["start"]
```

### Docker Compose

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - MONGO_URL=mongodb://mongo:27017/app
      - REDIS_URL=redis://redis:6379
    depends_on:
      - mongo
      - redis

  mongo:
    image: mongo:7.0
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7.2-alpine

volumes:
  mongo_data:
```

---

## 13. Debugging

### Chrome DevTools

```sh
jse --inspect run app.js
```

Open `chrome://inspect` in Chrome, click "Configure", add `127.0.0.1:9229`,
and your target appears under "Remote Target". Click "inspect" to open
DevTools. Breakpoints, stepping, console, heap snapshots, and CPU profiling
work.

### VS Code

Add a launch configuration to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug with malia",
      "runtimeExecutable": "malia",
      "runtimeArgs": ["--inspect-brk", "run", "--allow-all"],
      "program": "${workspaceFolder}/src/index.ts",
      "console": "integratedTerminal"
    }
  ]
}
```

`--inspect-brk` pauses before the first line, giving VS Code time to attach
and hit your breakpoints.

### Custom host/port

```sh
jse --inspect=0.0.0.0:9230 run app.js
```

Bind to all interfaces (useful inside containers) on a non-default port.

### Programmatic access

```js
import { Session } from "node:inspector";

const session = new Session();
session.connect();
session.post("Profiler.enable", () => {
  session.post("Profiler.start", () => {
    // ... do work ...
    session.post("Profiler.stop", (err, { profile }) => {
      // profile contains CPU profiling data
      session.disconnect();
    });
  });
});
```

---

## 14. UDP sockets

```js
import dgram from "node:dgram";

const server = dgram.createSocket("udp4");

server.on("message", (msg, rinfo) => {
  console.log(`${rinfo.address}:${rinfo.port} -> ${msg}`);
  server.send(`echo: ${msg}`, rinfo.port, rinfo.address);
});

server.bind(41234, () => {
  console.log("UDP server listening on", server.address());
});
```

Client:

```js
import dgram from "node:dgram";

const client = dgram.createSocket("udp4");
client.send("hello", 41234, "127.0.0.1", (err) => {
  if (err) console.error(err);
});
client.on("message", (msg) => {
  console.log("reply:", msg.toString());
  client.close();
});
```

`send()` auto-binds if the socket is not yet bound. The `message` event
delivers a `Buffer` and an `rinfo` object with `address`, `port`, `family`,
and `size`.

## Current engineering limits

See [the compatibility matrix](engineering/compatibility-matrix.md) before deployment. Entry-source executables are not complete application bundles. Wasm source containers execute JavaScript only through Malia. TLS server accept, TLS socket upgrades, custom roots and VM timeouts are currently unsupported and rejected.

HTTP incoming bodies under `maxBodyBytes` (default 10 MiB) are buffered in memory; larger bodies are streamed through a channel so handlers can process them incrementally. Configure limits with `jse.serve({ limits: { maxBodyBytes, maxRequests, maxConnections, bodyTimeoutMs, requestTimeoutMs } }, handler)`. `handlerTimeout`, `handlerTimeoutMs`, and `timeout` are accepted as aliases for `requestTimeoutMs`. Defaults are 10 MiB body, 128 requests, 256 connections, 30 seconds to read a body and 30 seconds for handler response. No upper cap on timeouts or body size -- the application decides. Full responses are capped at 8 MiB; stream larger output. Await streaming writes; a stream has eight 64 KiB native chunks of capacity, and each submitted chunk may be at most 1 MiB. Node HTTP response writers must respect `write()` returning false and wait for `drain`; queuing more than 1 MiB rejects. `http.Agent({ keepAlive: true })` enables connection pooling for outbound requests. These are per-listener limits, not a whole-process RSS guarantee.

WorkerPool defaults: 1024 queued jobs, 64 buffered replies per stream and 30-second active job deadline. Options are `maxQueue`, `maxBuffered`, `timeoutMs`, and `size` (maximum 256). `run(value, { signal })` and `stream(value, { signal })` support cancellation; cancellation terminates and replaces the worker. Worker channels each hold at most 64 messages of at most 1 MiB. The legacy stream completion value `{ __done: true }` remains reserved.

KV defaults are 100000 keys and 64 MiB of logical key, value, entry and expiry-index storage. Capacity errors preserve existing values. Expiry sweeps remove at most 128 keys per 100 ms and per operation; allocator and hash-table overhead are not RSS-accounted by this budget. It is process-local and nonpersistent.

Set `MALIA_NO_MODIFY_PATH=1` when installing into a disposable destination to keep shell profiles untouched.

---

## 15. AI toolkit

`malia.ai` provides built-in AI with zero npm packages. It auto-detects
local LLMs (Ollama, vLLM, LM Studio, llama.cpp) and cloud providers
(OpenAI, Anthropic, Google, Mistral, Groq, xAI, DeepSeek, Together,
Fireworks, Perplexity).

### One-liner chat

```javascript
// Auto-detect local Ollama or cloud provider from env vars
const reply = await malia.ai("Summarize this quarter's revenue trends");
console.log(reply);
```

### Streaming

```javascript
const ai = malia.ai({ model: "llama3", system: "You are a data analyst" });
for await (const token of ai.stream("What drives customer churn?")) {
  process.stdout.write(token);
}
```

### Frontier models

The provider is inferred from the model name. Set the corresponding
environment variable:

```javascript
// OpenAI
const ai = malia.ai("gpt-4o");               // OPENAI_API_KEY

// Anthropic
const ai = malia.ai("claude-sonnet-4-20250514");      // ANTHROPIC_API_KEY

// Google Gemini
const ai = malia.ai("gemini-2.0-flash");     // GOOGLE_API_KEY

// Groq (fast inference)
const ai = malia.ai("llama-3.3-70b-versatile"); // GROQ_API_KEY

// xAI
const ai = malia.ai("grok-3");               // XAI_API_KEY

// Or explicit
const ai = malia.ai({
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: process.env.MY_KEY,
  system: "You are a helpful assistant",
});
```

### Embeddings and similarity

```javascript
const ai = malia.ai();
const vecA = await ai.embed("machine learning");
const vecB = await ai.embed("artificial intelligence");
const score = malia.ai.similarity(vecA, vecB);
console.log("similarity:", score);  // ~0.85
```

### Conversation memory

```javascript
const ai = malia.ai({ system: "You are a tutor" });
await ai.chat("My name is Alice");
await ai.chat("What is my name?");  // "Alice"
console.log(ai.history);            // [{role, content}, ...]
ai.clear();                         // reset
```

### AI-powered API endpoint

```javascript
const ai = malia.ai({ system: "You are a customer support agent" });

jse.serve({ port: 3000 }, async (req) => {
  const { message } = await req.json();
  const reply = await ai.chat(message);
  return Response.json({ reply });
});
```

---

## 16. Hot module replacement

Zero-downtime code swaps on a running server. The HTTP socket stays open,
keep-alive connections persist, in-flight requests complete with the old
handler.

### File watching

```javascript
const server = jse.serve({ port: 3000 }, (req) => new Response("initial"));

// Watch handler file -- edits are picked up automatically
await server.hot("./handler.mjs");
```

`handler.mjs`:

```javascript
export default (req) => {
  return Response.json({ status: "live", version: 2 });
};
```

Edit the file, save, and the server picks it up in ~50ms. No restart, no
port rebind, no dropped connections. The log shows:

```
[INFO] [hot] reloaded ./handler.mjs (v2)
```

### Programmatic reload

```javascript
const server = jse.serve({ port: 3000 }, handlerV1);

// Later -- deploy new code without restarting
server.reload(handlerV2);

// Check version
console.log(server.version);  // increments on each reload
```

### How it works

The hyper HTTP server runs on a dedicated Rust thread pool. The JS
handler is a mutable function reference in the serve event loop.
`reload()` atomically swaps the reference. Requests that were already
dispatched to the old handler complete normally; new requests immediately
use the new handler.

### Production deployment pattern

```javascript
const server = jse.serve({ port: 3000 }, handler);

// Health check signals readiness
jse.healthCheck(() => ({ status: "ok", version: server.version }));

// Watch handler in development
if (process.env.NODE_ENV !== "production") {
  await server.hot("./src/handler.mjs");
}
```

---

## 17. Package management

Malia includes a built-in npm-compatible package manager. No separate Node.js
installation is needed.

### npm and npx commands

When you install malia, `npm` and `npx` commands are created in
`~/.malia/bin`. They route to malia's built-in package manager:

```sh
npm install express              # install a package
npm install -g http-server       # install globally to ~/.malia/bin
npm uninstall lodash             # remove a package
npm init -y                      # create package.json
npm ls                           # list installed packages
npm run dev                      # run a script from package.json
npm test                         # run the test script
npm start                        # run the start script
npx cowsay hello                 # run a package binary
```

### malia install

The `malia install` / `jse install` commands work identically:

```sh
# Install all dependencies from package.json
jse install

# Add a package (updates package.json)
jse install express
jse add lodash

# Add as a dev dependency
jse install -D jest

# Install globally
jse install -g typescript

# Remove a package
jse uninstall express
jse rm lodash

# List installed packages
jse ls
jse list -g            # global packages
jse list --all         # include sub-dependencies
```

### How it works

1. If an external package manager is available (npm, yarn, pnpm -- detected
   from lockfiles), malia delegates to it for full lockfile support.
2. If no package manager is found, malia's built-in installer handles it:
   fetches package metadata from the npm registry, resolves semver ranges,
   downloads and extracts tarballs, and installs sub-dependencies.
3. Global installs go to `~/.malia/lib/node_modules/` with bin links in
   `~/.malia/bin/`.

### Private registries

Set `NPM_REGISTRY` to point to a private registry:

```sh
NPM_REGISTRY=https://registry.internal.com jse install
```

### Migrating from Node.js

If you previously used Node.js and npm:

1. Install malia (the installer creates `npm`/`npx` shims if no system npm
   exists, or set `MALIA_INSTALL_SHIMS=1` to always create them)
2. Your existing `package.json` and `node_modules` work as-is
3. `npm install`, `npm run`, `npm test` all work unchanged
4. Optionally uninstall Node.js -- malia provides everything you need

---

## 18. Concurrency

### Parallel map with concurrency control

Node's `Promise.all(items.map(fn))` fires everything at once. Malia gives
you bounded parallelism:

```javascript
// Process 1000 items, 20 at a time
const results = await malia.parallel.map(items, async (item) => {
  const res = await fetch(`/api/${item.id}`);
  return res.json();
}, { concurrency: 20 });
```

### Mutex and semaphore

```javascript
// Protect a shared resource
const lock = malia.mutex();
await lock.run(async () => {
  await db.update(record);
});

// Allow max 5 concurrent database connections
const dbSem = malia.semaphore(5);
await dbSem.run(async () => {
  return await db.query("SELECT ...");
});
```

### Retry with backoff

```javascript
const data = await malia.retry(async () => {
  const res = await fetch("https://flaky-api.example.com/data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}, { attempts: 3, delay: 200, backoff: 2 });
```

### Reusable pool

```javascript
const imageProcessor = malia.parallel.pool(
  async (url) => {
    const img = await fetch(url).then(r => r.arrayBuffer());
    return processImage(img);
  },
  { concurrency: 4 }
);

// Submit work throughout the application lifetime
const result = await imageProcessor.submit("https://example.com/photo.jpg");
```

---

## 19. Cron scheduler

```javascript
// Standard cron expressions
malia.cron("0 */6 * * *", async () => {
  await generateReport();
  await sendEmail();
});

// Second-level precision (6 fields)
malia.cron("*/10 * * * * *", () => {
  healthCheck();
});

// Shorthand
malia.cron.every("30s", checkQueue);
malia.cron.daily(2, 0, cleanupLogs);     // 2:00 AM daily
malia.cron.weekly(1, 9, sendWeeklyEmail); // Monday 9:00 AM

// Control
const job = malia.cron("*/5 * * * *", handler);
job.stop();     // pause
job.start();    // resume
job.trigger();  // fire now
```

---

## 20. Security

### Security middleware

```javascript
// Replaces helmet + express-rate-limit + cors (3 packages)
const handler = async (req) => {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

jse.serve({ port: 3000 },
  jse.secure(               // HSTS, noSniff, X-Frame-Options, CSP
    jse.rateLimit(           // 100 req/min per IP
      jse.cors(handler, {    // CORS with preflight
        origin: "https://app.example.com",
      }),
      { max: 100, window: 60000 }
    )
  )
);
```

### Security scanning

```sh
# Before deploying -- scan for vulnerabilities
malia scan .

# Before committing -- check for leaked secrets
malia secrets .

# Before running untrusted code -- see what it needs
malia permissions untrusted-script.js

# For compliance -- generate SBOM
malia sbom

# For license review
malia deps --licenses
```

---

## 21. Developer tools

### Project health check

```sh
malia doctor
```

Checks: package.json validity, node_modules presence, lockfile, .gitignore
rules, sensitive keys in .env, system info.

### Static file server

```sh
malia serve .                    # serve current directory on port 3000
malia serve ./public --port 8080 # custom port
```

Features: directory listing, auto `index.html`, MIME types, ETag caching,
304 Not Modified, path traversal protection.

### Environment inspection

```sh
malia env
```

Shows all resolved env vars from `.env` files (with source), config file
env settings, and runtime variables. Sensitive values (passwords, tokens,
secrets) are automatically masked.

### Cleanup

```sh
malia clean       # remove node_modules, .cache, dist, build
malia clean --all # also clear global download cache
```

### Self-update

```sh
malia upgrade     # check latest version, show install command
```

---

## 22. Deployment

### Generate deployment files

```sh
malia deploy              # generates all three
malia deploy docker       # Dockerfile + .dockerignore only
malia deploy compose      # docker-compose.yml only
malia deploy systemd      # <app-name>.service only
```

The generated Dockerfile installs malia in a minimal Ubuntu base,
copies your `package.json` first (for layer caching), installs dependencies,
then copies your code. It sets `NODE_ENV=production` and exposes the port
from your `PORT` env var.

### Deploy with Docker

```sh
malia deploy
docker compose up -d      # build and start
docker compose logs -f    # watch logs
docker compose down       # stop
```

### Deploy with systemd

```sh
malia deploy systemd
sudo cp my-app.service /etc/systemd/system/
sudo systemctl enable --now my-app
sudo journalctl -u my-app -f   # watch logs
```

---

## 23. Profiling

```sh
malia profile server.js              # profile for 10 seconds (default)
malia profile server.js --duration 30  # profile for 30 seconds
```

Output includes:
- Top 20 functions by CPU time with file:line references
- Full `.cpuprofile` file for Chrome DevTools
- Memory usage (RSS, heap used, heap total)

To analyze in Chrome DevTools:
1. Open `chrome://inspect`
2. Click "Open dedicated DevTools for Node"
3. Go to Performance tab -> Load profile -> select the `.cpuprofile` file

---

## 24. Database migrations

### Create a migration

```sh
malia migrate create add_users_table
```

This creates `migrations/<timestamp>_add_users_table.up.sql` and
`migrations/<timestamp>_add_users_table.down.sql`.

### Write the SQL

```sql
-- migrations/<timestamp>_add_users_table.up.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- migrations/<timestamp>_add_users_table.down.sql
DROP TABLE users;
```

### Run migrations

```sh
malia migrate up       # apply all pending migrations
malia migrate down     # roll back the last applied migration
malia migrate status   # show [x] applied, [ ] pending
```

Migrations are tracked in `.malia-migrations.db` (auto-created). The
migration runner uses the built-in SQLite engine.

---

## 25. Env encryption

### Encrypt your .env for safe git storage

```sh
# Encrypt with auto-generated key
malia env-encrypt encrypt
# Output: Generated key (save this): <hex key>
# .env -> .env.encrypted

# Encrypt with explicit key
malia env-encrypt encrypt --key=<64-char-hex>

# Decrypt
malia env-encrypt decrypt --key=<64-char-hex>
# .env.encrypted -> .env
```

### CI/CD workflow

```sh
# In your CI environment, set MALIA_ENV_KEY as a secret
export MALIA_ENV_KEY=<64-char-hex>
malia env-encrypt decrypt    # restores .env from .env.encrypted
malia run --allow-all app.js # .env auto-loaded at startup
```

Encryption uses AES-256-GCM with a random 12-byte nonce per encryption.
The key is 32 bytes (64 hex chars). The encrypted file contains
`nonce (12 bytes) + ciphertext + GCM tag (16 bytes)`.

### .gitignore

```
.env
.env.local
.env.*.local
# DO commit:
# .env.encrypted
```

---

## 26. Pub/Sub

### Basic pub/sub

```javascript
const bus = malia.pubsub();

bus.subscribe("orders", (order) => {
  console.log("New order:", order.id);
});

bus.publish("orders", { id: 123, total: 49.99 });
```

### Pattern matching

```javascript
bus.subscribe("events:*", (msg, topic) => {
  // Matches events:login, events:logout, events:purchase, etc.
  console.log(`[${topic}]`, msg);
});

bus.publish("events:login", { userId: 1 });
bus.publish("events:purchase", { amount: 99 });
```

### Message history (replay for late joiners)

```javascript
const bus = malia.pubsub({ history: 100 });

bus.publish("chat:room1", { user: "Alice", text: "hello" });
bus.publish("chat:room1", { user: "Bob", text: "hi" });

// New subscriber immediately receives the 2 messages above
bus.subscribe("chat:room1", (msg) => {
  console.log(msg.user + ":", msg.text);
});
```

### Async patterns

```javascript
// Wait for a single event
const { message } = await bus.once("ready");

// Async iterator (consume events as a stream)
for await (const { message, topic } of bus.listen("events:*")) {
  await processEvent(message);
}
```

### WebSocket broadcast example

```javascript
const bus = malia.pubsub();
const clients = new Set();

jse.serve({ port: 3000 }, (req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = jse.upgradeWebSocket(req);
    clients.add(socket);
    socket.onclose = () => clients.delete(socket);
    socket.onmessage = (e) => bus.publish("chat", JSON.parse(e.data));
    return response;
  }
  return new Response("WebSocket server");
});

// Broadcast to all connected clients
bus.subscribe("chat", (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of clients) ws.send(data);
});

---

## 27. Caching

### LRU cache with TTL

```javascript
const cache = malia.cache({ max: 1000, ttl: 60000 }); // 1000 entries, 60s TTL

cache.set("session:abc", { userId: 1, role: "admin" });
const session = cache.get("session:abc");

// Per-key TTL overrides
cache.set("temp", "value", { ttl: 5000 });  // expires in 5 seconds
```

### Cache-aside pattern

The most common caching pattern: check cache first, compute on miss, store
the result. `getOrSet` does it in one call with automatic deduplication.

```javascript
const userCache = malia.cache({ max: 500, ttl: 30000 });

// This is the pattern every production app needs:
async function getUser(id) {
  return userCache.getOrSet("user:" + id, async () => {
    // Only runs on cache miss
    return await db.query("SELECT * FROM users WHERE id = ?", id);
  });
}

// 20 concurrent requests for the same user = 1 database query
const users = await malia.parallel.map(requestIds, id => getUser(id));
```

### Image and file caching

```javascript
const imageCache = malia.cache({
  max: 200,
  maxSize: 100 * 1024 * 1024,  // 100 MB total
  sizeOf: (buf) => buf.length,  // track byte size
  onEvict: (key, buf) => console.log(`Evicted ${key} (${buf.length} bytes)`),
});

async function getImage(url) {
  return imageCache.getOrSet(url, async () => {
    const res = await fetch(url);
    return Buffer.from(await res.arrayBuffer());
  }, { ttl: 3600000 }); // 1 hour
}
```

### Memoize functions

```javascript
// Wrap any async function with caching
const fetchPrice = malia.cache.memoize(async (symbol) => {
  const res = await fetch(`https://api.example.com/price/${symbol}`);
  return res.json();
}, { max: 100, ttl: 10000 }); // cache 100 symbols for 10 seconds

const btc = await fetchPrice("BTC");
const eth = await fetchPrice("ETH");
fetchPrice.cache.stats(); // { hits: 0, misses: 2, hitRate: 0, size: 2 }
```

### Cache with HTTP server

```javascript
const apiCache = malia.cache({ max: 1000, ttl: 15000 });

jse.serve({ port: 3000 }, async (req) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    const data = await apiCache.getOrSet(url.pathname + url.search, async () => {
      // Expensive computation or external API call
      return await fetchFromUpstream(url.pathname);
    });
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
    });
  }

  return new Response("Not Found", { status: 404 });
});
```

### Cache stats and monitoring

```javascript
const cache = malia.cache({ max: 1000, ttl: 60000 });

// Periodic stats logging
malia.cron.every("1m", () => {
  const s = cache.stats();
  console.log(`Cache: ${s.size}/${s.max} entries, ${(s.hitRate * 100).toFixed(1)}% hit rate`);
});

// Purge expired entries periodically
malia.cron.every("5m", () => {
  const purged = cache.purge();
  if (purged > 0) console.log(`Purged ${purged} expired entries`);
});
```
