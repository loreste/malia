# Malia How-To & Operational Guide

Practical guides and operational patterns for building, running, and deploying applications with **Malia** (and the `jse` CLI alias).

> **Note on Command Aliases & Compatibility**: `malia` and `jse` are dual entry points to the same engine. Whether you run `malia run app.ts` or `jse run app.ts`, behavior is identical. In JavaScript/TypeScript code, both `malia.*` and `jse.*` global namespaces are available.

---

## Table of Contents

1. [Quick Start & Project Configuration](#1-quick-start--project-configuration)
2. [TypeScript Without Build Steps](#2-typescript-without-build-steps)
3. [Migrating Existing Node.js Applications](#3-migrating-existing-nodejs-applications)
4. [Compiling Standalone Single-Binary Executables](#4-compiling-standalone-single-binary-executables)
5. [Database Connectivity & Drivers](#5-database-connectivity--drivers)
6. [High-Performance Networking & IPC](#6-high-performance-networking--ipc)
7. [Production Observability & Tracing](#7-production-observability--tracing)
8. [Durable Background Task Queuing](#8-durable-background-task-queuing)
9. [Cryptography, Signatures & Security](#9-cryptography-signatures--security)
10. [Multi-Core Concurrency & Worker Pools](#10-multi-core-concurrency--worker-pools)
11. [WebAssembly & Runtime Optimization](#11-webassembly--runtime-optimization)
12. [Container & Kubernetes Deployment](#12-container--kubernetes-deployment)

---

## 1. Quick Start & Project Configuration

Malia projects can be configured with a `malia.json`, `malia.toml`, `jse.json`, or `jse.toml` file, or by using an existing `package.json`.

### Initializing a Project

```bash
# Generate a clean, annotated malia.json (supports JSONC comments & trailing commas)
malia init
# Or using the jse command alias:
jse init

# Generate clean TOML format if preferred
malia init --toml
```

### Example `malia.json` (or `jse.json`)

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
    "dev": "malia run --watch src/server.ts",
    "start": "malia run src/server.ts",
    "test": "malia test",
    "compile": "malia compile src/server.ts -o dist/payment-service"
  }
}
```

### Everyday CLI Commands

All commands can be invoked using either `malia` or `jse`:

| Command | Action |
|---|---|
| `malia` / `jse` | Auto-detects `malia.json` / `jse.json`, loads environment, checks permissions, and executes `main` |
| `malia run <file>` | Runs any `.js`, `.ts`, `.mjs`, `.cjs`, or `.wasm` file immediately |
| `malia dev` | Starts the application and reloads automatically on file changes |
| `malia test` | Executes built-in test suite (supports `node:test` and TAP output) |
| `malia install` | Installs npm dependencies (auto-detects npm, pnpm, or yarn lockfiles) |
| `malia add <pkg>` | Adds and installs an npm package (e.g. `malia add lodash`) |
| `malia x <bin>` | Executes a package binary without global install (npx equivalent) |
| `malia compile <file>` | Compiles an application ahead-of-time into a self-contained native executable |
| `malia config` | Prints resolved configuration, permissions, and environment variables |

---

## 2. TypeScript Without Build Steps

`jse` transpiles TypeScript via SWC (`deno_ast`) at runtime and caches the output to disk. No separate compiler step (`tsc` or `tsx`) is required.

### Running TypeScript Directly

Create `src/app.ts`:

```typescript
interface Customer {
  id: string;
  name: string;
  balance: number;
}

function summarize(customer: Customer): string {
  return `Customer ${customer.name} (${customer.id}): $${customer.balance.toFixed(2)}`;
}

const alice: Customer = { id: "C-109", name: "Alice Smith", balance: 450.5 };
console.log(summarize(alice));
```

Run directly:

```bash
jse run src/app.ts
```

### TypeScript Path Aliases (`tsconfig.json`)

`jse` resolves path aliases defined in `tsconfig.json`:

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

In your code, path aliases resolve accordingly:

```typescript
import { User } from "@models/user.ts";
import { formatCurrency } from "@utils/format.ts";
```

---

## 3. Migrating Existing Node.js Applications

`jse` supports Node.js core APIs and npm packages, allowing existing Node.js applications to run without modification.

### Running Existing Express & Fastify Apps

Existing `node_modules` and `package.json` dependencies work as expected:

```javascript
// server.js
const express = require("express");
const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: Date.now() });
});

app.post("/users", (req, res) => {
  res.status(201).json({ id: 1, ...req.body });
});

app.listen(8080, () => {
  console.log("Express server running on http://localhost:8080");
});
```

Run with `jse`:

```bash
jse run server.js
```

### Full-Stack SSR & Frameworks (React, Vue, Svelte, Nuxt, Next)

`jse` includes the browser and runtime globals expected by modern SSR engines:
- Standard DOM/Browser globals: `window`, `self`, `global`, `navigator`, `DOMException`, `btoa`, `atob`.
- `AsyncLocalStorage` (`node:async_hooks`): Retains request contexts across asynchronous execution trees.
- `MessageChannel` & `MessagePort`: Required for React Scheduler's concurrent rendering loop.
- `createRequire`: Seamlessly intermixes ESM `import` and legacy CommonJS `require()`.

```javascript
import { AsyncLocalStorage } from "node:async_hooks";

const asyncLocalStorage = new AsyncLocalStorage();

function logWithTrace(msg) {
  const store = asyncLocalStorage.getStore();
  console.log(`[${store?.requestId || "anonymous"}] ${msg}`);
}

asyncLocalStorage.run({ requestId: "req-998" }, async () => {
  logWithTrace("Database lookup started");
  await new Promise((r) => setTimeout(r, 20));
  logWithTrace("Database lookup complete");
});
```

---

## 4. Compiling Standalone Single-Binary Executables

Turn any JavaScript or TypeScript service into a self-contained, statically linked executable with zero runtime dependencies.

### Compiling a Service

```bash
# Compiles TypeScript ahead-of-time and produces a standalone binary
jse compile src/server.ts -o dist/my-service

# Make executable and run anywhere (Linux / macOS)
chmod +x dist/my-service
./dist/my-service
```

### Standalone Executable Properties:
1. **Self-Contained**: The target host does not need Node.js, `npm`, or `jse` installed.
2. **Pre-Bundled**: Includes the pre-warmed snapshot and compiled bytecode.
3. **Container-Friendly**: Can run in minimal base images without a system runtime.

---

## 5. Database Connectivity & Drivers

`jse` supports standard database drivers and client libraries.

### MongoDB & Mongoose
Supports SCRAM-SHA-256 and SCRAM-SHA-1 authentication via PBKDF2, SRV connection strings via DNS lookups, and BSON 64-bit integers.

```javascript
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://root:example@localhost:27017");
await client.connect();

const db = client.db("production");
const collection = db.collection("orders");

await collection.insertOne({ orderId: "ORD-1", amount: 199.95, date: new Date() });
const doc = await collection.findOne({ orderId: "ORD-1" });
console.log("Retrieved MongoDB Document:", doc);

await client.close();
```

### Redis & Valkey
Binary RESP wire protocol parsing over TCP sockets.

```javascript
import Redis from "ioredis";

const redis = new Redis("redis://localhost:6379");
await redis.set("session:user:42", JSON.stringify({ name: "Bob", role: "admin" }), "EX", 3600);

const session = await redis.get("session:user:42");
console.log("Cached Redis Session:", JSON.parse(session));

await redis.quit();
```

### PostgreSQL (`pg` & Drizzle ORM)
Full-duplex TCP streaming with SCRAM-SHA-256 and MD5 password authentication.

```javascript
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ connectionString: "postgres://postgres:secret@localhost:5432/app" });
const { rows } = await pool.query("SELECT NOW() AS current_time, 1 + 1 AS two;");
console.log("PostgreSQL query result:", rows[0]);
await pool.end();
```

### Embedded SQLite (`jse.sql` and `node:sqlite`)
SQLite is embedded directly in the `jse` binary, requiring no external compilation or `node-gyp`.

#### Using Tagged Template Literals (`jse.sql`):
```javascript
// Parameterized query via tagged template literal
const db = jse.sql.open("production.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL
  );
`);

const name = "Alice";
const email = "alice@example.com";
db.sql`INSERT OR REPLACE INTO users (name, email) VALUES (${name}, ${email})`;

const users = db.sql`SELECT * FROM users WHERE email = ${email}`;
console.log("Found user:", users[0]);
```

#### Using Node 22+ Standard `node:sqlite`:
```javascript
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, key TEXT, val REAL)");
const insert = database.prepare("INSERT INTO metrics (key, val) VALUES (?, ?)");
insert.run("cpu_usage", 42.5);

const select = database.prepare("SELECT * FROM metrics WHERE key = ?");
console.log("Metric:", select.get("cpu_usage"));
```

---

## 6. Networking & IPC

### Web Server (`jse.serve`)
Built on Hyper 1.x with synchronous handler dispatch on the request path:

```javascript
jse.serve({ port: 8000, host: "0.0.0.0" }, (req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/ping") {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("Not Found", { status: 404 });
});
console.log("jse.serve listening on port 8000");
```

### WebSockets (`jse.upgradeWebSocket`)
WebSocket server upgrades:

```javascript
jse.serve({ port: 8080 }, (req) => {
  const upgrade = jse.upgradeWebSocket(req);
  if (upgrade) {
    const { socket, response } = upgrade;
    socket.onopen = () => socket.send("Welcome to real-time streams!");
    socket.onmessage = (event) => socket.send(`Echo: ${event.data}`);
    return response;
  }
  return new Response("HTTP endpoint");
});
```

### Unix Domain Sockets (`node:net` IPC)
For inter-process communication on the same machine (such as sidecar proxies or reverse proxy upstreams):

#### Server:
```javascript
import net from "node:net";
import fs from "node:fs";

const socketPath = "/tmp/service-ipc.sock";
if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

const server = net.createServer((sock) => {
  sock.on("data", (chunk) => {
    sock.write(`IPC ACK: ${chunk.toString()}`);
  });
});

server.listen(socketPath, () => {
  console.log(`IPC server listening on ${socketPath}`);
});
```

#### Client:
```javascript
import net from "node:net";

const client = net.connect({ path: "/tmp/service-ipc.sock" }, () => {
  client.write("PAYLOAD_FROM_CLIENT");
});

client.on("data", (response) => {
  console.log("Received from server:", response.toString());
  client.end();
});
```

---

## 7. Production Observability & Tracing

### Distributed Tracing with OpenTelemetry (`jse.trace`)
Built-in W3C trace context generation, propagation, and OTLP JSON export:

```javascript
// 1. Start a root span for an incoming HTTP request
const result = jse.trace.startSpan("handle_checkout", (rootSpan) => {
  rootSpan.setAttribute("http.route", "/checkout");
  rootSpan.setAttribute("user.id", "usr_102");

  // Get W3C traceparent header: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
  const traceparent = rootSpan.toTraceparent();

  // 2. Start a nested child span
  jse.trace.startSpan("charge_credit_card", (childSpan) => {
    childSpan.setAttribute("gateway", "stripe");
    childSpan.addEvent("gateway_authorized", { authCode: "AUTH_883" });
    return "SUCCESS";
  });

  return { success: true, traceparent };
});

// 3. Export spans to OTLP JSON for Jaeger, Datadog, or OpenTelemetry Collector
const otlpReport = jse.trace.export("otlp");
console.log("OTLP JSON Payload:", JSON.stringify(otlpReport, null, 2));
```

### Propagating Context Across Microservices
```javascript
// Outgoing client request: inject traceparent header
const headers = {};
const span = jse.trace.startSpan("remote_rpc_call");
jse.trace.inject(span, headers);

// Headers now contains { traceparent: "00-..." }
await fetch("http://downstream-service/api", { headers });
span.end();

// Downstream server: extract trace context
const incomingHeaders = req.headers;
const context = jse.trace.extract(incomingHeaders);
jse.trace.startSpan("downstream_operation", (span) => {
  // Automatically attaches to upstream traceId!
});
```

### Structured Logging (`jse.log`)
Structured logger supporting human-readable text with ANSI color badges or single-line JSON formatting:

```bash
# Configure via environment variables
export JSE_LOG=debug
export JSE_LOG_FORMAT=json
```

In your application code:
```javascript
jse.log.info("Order processed successfully", { orderId: 8810, amount: 49.99 });
jse.log.warn("Rate limit approaching", { currentRate: 480, limit: 500 });
jse.log.error("Payment authorization failed", new Error("Card declined"));
```

Outputs machine-readable JSON:
```json
{"timestamp":"2026-09-30T01:30:00.123Z","level":"info","target":"app","message":"Order processed successfully","meta":{"orderId":8810,"amount":49.99}}
```

---

## 8. Durable Background Task Queuing

`globalThis.jse.queue` provides an embedded task queue backed by SQLite for background jobs:

### Producing Tasks
```javascript
const q = jse.queue.open("./tasks.db");

// Push background jobs
const jobId = q.push("notifications", {
  userId: "user_456",
  email: "user@example.com",
  template: "monthly_receipt"
}, {
  maxRetries: 3,
  delayMs: 5000 // Deliver after 5 seconds
});

console.log("Enqueued job:", jobId);
```

### Consuming Tasks with Leases
```javascript
// Pop next job with a 30-second visibility lease
const job = q.pop("notifications", 30000);

if (job) {
  try {
    console.log(`Processing job ${job.id}, payload:`, job.payload);
    // Send email...
    
    // Acknowledge successful completion
    q.ack(job.id);
  } catch (err) {
    // Negative acknowledge: releases job after backoff
    // Automatically routes to Dead-Letter Queue (DLQ) if maxRetries exceeded
    q.nack(job.id, 5000);
  }
}
```

### Inspecting Dead-Letter Queues (DLQ)
```javascript
const deadJobs = q.dead("notifications");
console.log(`Found ${deadJobs.length} failed jobs in dead letter queue:`, deadJobs);
```

---

## 9. Cryptography, Signatures & Security

### AEAD Encryption
Authenticated Encryption with Associated Data (AEAD) provides confidentiality and authentication.

```javascript
import crypto from "node:crypto";

const key = crypto.randomBytes(32); // 256-bit key
const iv = crypto.randomBytes(12);  // 96-bit standard nonce

// 1. Encrypt with AES-256-GCM
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(Buffer.from("user-tenant-100")); // Authenticated Additional Data

let encrypted = cipher.update("CONFIDENTIAL_PATIENT_RECORD", "utf8");
encrypted = Buffer.concat([encrypted, cipher.final()]);
const tag = cipher.getAuthTag(); // 128-bit authentication tag

// 2. Decrypt & Verify Integrity
const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAAD(Buffer.from("user-tenant-100"));
decipher.setAuthTag(tag);

let decrypted = decipher.update(encrypted);
decrypted = Buffer.concat([decrypted, decipher.final()]);
console.log("Decrypted plaintext:", decrypted.toString("utf8"));
```

### Ed25519 Asymmetric Signatures
Digital signatures for APIs, authentication tokens, and audit logs:

```javascript
import crypto from "node:crypto";

// Generate Ed25519 keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const message = Buffer.from("ACTION: TRANSFER $1,000,000 to ACCT-990");

// Sign message with private key
const signature = crypto.sign(null, message, privateKey);

// Verify signature with public key
const isAuthentic = crypto.verify(null, message, publicKey, signature);
console.log("Signature is authentic:", isAuthentic); // true
```

### Permission Controls
Restrict runtime capabilities per application:

```bash
# Allow read-only access to assets, network access only to specific APIs
jse run --allow-read=./assets --allow-net=api.stripe.com src/server.ts

# Allow full access for trusted production containers
jse run --allow-all src/server.ts
```

---

## 10. Concurrency & Worker Pools

`jse` supports worker threads, worker pools, and process clustering via `node:cluster`:

### HTTP Clustering (`node:cluster`)
`node:cluster` uses OS-level `SO_REUSEPORT` socket sharing so worker processes bind directly to the same port and the operating system distributes incoming connections.

```javascript
// cluster.js
import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";

if (cluster.isPrimary) {
  const numCPUs = os.availableParallelism();
  console.log(`Primary ${process.pid} is starting ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died. Replacing...`);
    cluster.fork();
  });
} else {
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Handled by worker PID ${process.pid}\n`);
  }).listen(8080);
}
```

### Worker Pool (`WorkerPool`)
For CPU-intensive workloads (image compression, cryptography, data processing):

```javascript
const pool = new WorkerPool({
  workerScript: "./worker.js",
  minWorkers: 4,
  maxWorkers: 16
});

// Distribute tasks across worker threads
const results = await Promise.all([
  pool.runTask({ file: "image1.png" }),
  pool.runTask({ file: "image2.png" }),
  pool.runTask({ file: "image3.png" })
]);
console.log("Processing complete:", results);
```

---

## 11. WebAssembly & Memory Management

### Direct WebAssembly Imports
Import `.wasm` files directly in ES modules or CommonJS without glue code:

```javascript
// Import WebAssembly module directly
import math from "./math.wasm";

console.log("Wasm execution:", math.add(40, 2)); // 42
```

### WebAssembly Execution & Compilation
```bash
# Run an application via WebAssembly
jse run --wasm app.ts

# Compile app into portable .wasm binary
jse compile --wasm app.ts -o app.wasm
```

### Memory Compaction (`jse.optimizer`)
`jse.optimizer` performs periodic memory management during runtime execution:
- **Memory Compaction**: Reclaims unreferenced V8 pages and returns memory to the OS during idle event loop turns.
- **Periodic Compaction**: Trims heap fragmentation periodically during request processing to maintain a compact memory footprint.

---

## 12. Container & Kubernetes Deployment

### Linux cgroup v1 & v2 Memory & CPU Auto-Detection
When running in Docker or Kubernetes with limits (e.g. `resources.limits.memory: 512Mi`), `jse` automatically detects container cgroup limits and configures V8's heap and worker pool limits accordingly.

### PID 1 Signal Forwarding & Graceful Shutdown
When executed as PID 1 in a container, `jse` catches `SIGTERM` and `SIGINT`, triggers registered shutdown hooks, drains in-flight HTTP connections, and exits cleanly:

```javascript
jse.onShutdown(async () => {
  console.log("Draining database connections...");
  await dbPool.end();
  console.log("Shutdown complete.");
});
```

### Hardened Production Dockerfile

```dockerfile
# ---------------------------------------------------------------------------
# Multi-stage build for minimal production container
# ---------------------------------------------------------------------------
FROM rust:1.85-bookworm AS builder
WORKDIR /usr/src/jse
COPY . .
RUN cargo build --release --bin jse && strip target/release/jse

# Distroless / minimal runtime stage
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

### Docker Compose Full Stack Example

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - MONGO_URL=mongodb://mongo:27017/prod
      - REDIS_URL=redis://redis:6379
    depends_on:
      - mongo
      - redis

  mongo:
    image: mongo:7.0
    restart: always
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7.2-alpine
    restart: always

volumes:
  mongo_data:
```
