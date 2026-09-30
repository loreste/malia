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
| `jse install` | Install npm dependencies (detects npm, pnpm, or yarn lockfiles) |
| `jse add <pkg>` | Add an npm package |
| `jse x <bin>` | Run a binary from `node_modules/.bin`, falling back to npx |
| `jse compile <file>` | Compile to a standalone executable |
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
    q.ack(job.id);
  } catch {
    q.nack(job.id, 5000); // retry after 5 s; moved to dead-letter after maxRetries
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

## 10. Workers and clustering

### WorkerPool

`new WorkerPool(path, { size })` starts `size` workers (default: number of
CPUs). `pool.run(arg)` sends `arg` to an idle worker and resolves with that
worker's reply. Each worker must post exactly one reply per message.

```javascript
// worker.js
onmessage = (e) => {
  postMessage(e.data.n * 2);
};
```

```javascript
// main.js
const pool = new WorkerPool("./worker.js", { size: 4 });

const results = await pool.map([{ n: 1 }, { n: 2 }, { n: 3 }]);
console.log(results); // [2, 4, 6]

pool.close();
```

### node:cluster

Workers bind the same port with `SO_REUSEPORT`, and the OS distributes
incoming connections among them.

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

---

## 11. WebAssembly

`.wasm` files can be imported directly. Exports are available on the
default import.

```javascript
import math from "./math.wasm";
console.log(math.add(40, 2));
```

```bash
jse run --wasm app.ts                 # run the program through WebAssembly
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
