[English](HOWTO.md) | **中文**

# Malia 使用指南

常见任务的示例。`malia` 和 `jse` 是同一个二进制文件，`malia.*` 和 `jse.*` 全局对象也相同；本指南统一使用 `jse`。

## 目录

1. [项目配置](#1-项目配置)
2. [TypeScript](#2-typescript)
3. [运行现有的 Node.js 应用](#3-运行现有的-nodejs-应用)
4. [独立可执行文件](#4-独立可执行文件)
5. [数据库](#5-数据库)
6. [HTTP、WebSocket 和 IPC](#6-httpwebsocket-和-ipc)
7. [追踪与日志](#7-追踪与日志)
8. [任务队列](#8-任务队列)
9. [加密与权限](#9-加密与权限)
10. [并发与并行](#10-并发与并行)
11. [WebAssembly](#11-webassembly)
12. [容器部署](#12-容器部署)
13. [调试](#13-调试)
14. [UDP 套接字](#14-udp-套接字)
15. [AI 工具包](#15-ai-工具包)
16. [热模块替换](#16-热模块替换)
17. [包管理](#17-包管理)
18. [并发控制](#18-并发控制)
19. [定时任务调度](#19-定时任务调度)
20. [安全](#20-安全)
21. [开发者工具](#21-开发者工具)
22. [部署](#22-部署)
23. [性能分析](#23-性能分析)
24. [数据库迁移](#24-数据库迁移)
25. [环境变量加密](#25-环境变量加密)
26. [发布/订阅](#26-发布订阅)
27. [缓存](#27-缓存)

---

## 1. 项目配置

`jse init` 会生成 `jse.json` 文件（`jse init --toml` 则生成 `jse.toml`）。配置文件按以下顺序查找：`malia.json`、`malia.toml`、`malia.config.json`、`jse.json`、`jse.toml`、`jse.config.json`，最后是 `package.json`。

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

| 命令 | 操作 |
|---|---|
| `jse` | 运行配置的入口文件，如果没有则打开 REPL |
| `jse run <file>` | 运行 `.js`、`.ts`、`.mjs`、`.cjs` 或 `.wasm` 文件 |
| `jse dev` | 运行入口文件并在文件变更时自动重启 |
| `jse test` | 运行测试（`node:test`，TAP 输出） |
| `jse install` | 安装 package.json 中的依赖（内置或委托给 npm/yarn/pnpm） |
| `jse install <pkg>` / `jse add <pkg>` | 添加一个包，更新 package.json |
| `jse install -g <pkg>` | 全局安装包到 `~/.malia/bin` |
| `jse uninstall <pkg>` / `jse rm` | 移除一个包 |
| `jse list` / `jse ls` | 列出已安装的包 |
| `jse x <bin>` | 运行 `node_modules/.bin` 中的二进制文件，如果找不到则回退到 npx |
| `jse compile <file>` | 将入口源码和权限嵌入宿主运行时（runtime） |
| `jse config show` | 打印解析后的配置 |
| `jse <script>` | 运行配置文件或 `package.json` 中的脚本 |

---

## 2. TypeScript

TypeScript 在加载时通过 SWC 转译并缓存到磁盘。不会进行类型检查；如需类型检查请运行 `tsc --noEmit`（例如 `jse x tsc --noEmit`）。

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

`tsconfig.json` 中的路径别名（`baseUrl`、`paths`）会被正确解析：

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

## 3. 运行现有的 Node.js 应用

使用 `node_modules` 和 Node 核心 API 的应用可以直接运行。不支持原生插件（`.node` 文件）。

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

对于 SSR 框架，运行时定义了 `window`、`self`、`global`、`navigator`、`DOMException`、`btoa`、`atob`、`MessageChannel` 和 `AsyncLocalStorage`。`AsyncLocalStorage` 在 `await` 之后仍然保持其存储：

```javascript
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

als.run({ requestId: "req-998" }, async () => {
  console.log(als.getStore().requestId); // req-998
  await new Promise((r) => setTimeout(r, 20));
  console.log(als.getStore().requestId); // req-998
});
```

### 将 CPU 密集型任务迁移到 WorkerPool

如果你的 Node 应用有在主线程上执行 CPU 密集型工作的接口，可以用很少的改动将其迁移到 WorkerPool。

**迁移前（Node — 阻塞事件循环）：**

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

**迁移后（Malia — 并行执行，主线程保持空闲）：**

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

只改了三行代码。接口现在是非阻塞的，并且可以在所有可用核心上并行运行。

### 用 WorkerPool 替代手动 worker_threads

**迁移前（Node — 手动管理 Worker 生命周期）：**

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

**迁移后（Malia — 一行搞定）：**

```javascript
const pool = new WorkerPool("./process.js");
const results = await pool.map(items);
pool.close();
```

效果相同。无需手动管理 Worker 生命周期，无需错误处理接线，自动复用并跨核心并行执行。

### 使用通道（channel）添加背压

**迁移前（Node — 无界队列，内存持续增长）：**

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

**迁移后（Malia — 有界通道，缓冲区满时生产者等待）：**

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

通道（channel）自动施加背压（backpressure）。在高负载下，`send()` 会等待，而不是无限制地增长内存。

### 通过 require.cache 实现热重载

测试运行器和开发工具会清除 `require.cache` 以强制模块重新加载。这与 Node 的行为相同：

```javascript
const resolved = require.resolve("./config.js");
delete require.cache[resolved];
const fresh = require("./config.js"); // re-reads and re-executes the file
```

---

## 4. 独立可执行文件

`jse compile` 会转译应用并生成一个包含运行时（runtime）、启动快照（snapshot）和应用代码的可执行文件。目标机器不需要安装 Node.js 或 `jse`。

```bash
jse compile src/server.ts -o dist/my-service
./dist/my-service
```

`jse build` 功能相同，使用配置文件中的入口文件。

---

## 5. 数据库

数据库驱动是普通的 npm 包。以下示例假设包已安装，程序使用 `--allow-net` 运行。

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

SQLite 已编译进二进制文件。`jse.sql` 在默认的内存数据库上运行语句；`jse.sql.open(path)` 打开一个文件。插值的值作为绑定参数传递。`SELECT`、`PRAGMA` 和 `EXPLAIN` 返回行；其他语句返回执行结果。

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

Node 22 的 `node:sqlite` API 同样可用：

```javascript
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, key TEXT, val REAL)");
db.prepare("INSERT INTO metrics (key, val) VALUES (?, ?)").run("cpu", 42.5);
console.log(db.prepare("SELECT * FROM metrics WHERE key = ?").get("cpu"));
```

---

## 6. HTTP、WebSocket 和 IPC

### HTTP 服务器

处理函数接收一个 `Request` 并返回一个 `Response` 或其 Promise。`req.url` 是客户端发送的请求目标（通常是路径），因此构造 `URL` 时需要传入一个基地址。

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

### 服务器选项

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

超过 `maxBodyBytes` 的大型请求体会通过通道（channel）以流式方式传输，而不是被拒绝。处理函数通过 `req.body` 或 `await req.text()` 读取它们。

### 热重载（另见[第 16 节](#16-热模块替换)）

```javascript
const server = jse.serve({ port: 3000 }, handler);
await server.hot("./handler.mjs");   // watch file, reload on change
server.reload(newHandler);            // programmatic swap
```

### 路由器

```javascript
const router = new jse.Router();

router.get("/healthz", jse.healthCheck());
router.get("/metrics", () => new Response(jse.metrics.prometheus()));
router.get("/api/users/:id", (req) => ({ id: req.params.id }));
router.static("/public", "./public", { spa: true });

jse.serve(router.handler(), { port: 3000 });
```

### WebSocket 服务器

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

### Unix 域套接字

服务端：

```javascript
import net from "node:net";
import fs from "node:fs";

const path = "/tmp/service.sock";
if (fs.existsSync(path)) fs.unlinkSync(path);

net.createServer((sock) => {
  sock.on("data", (chunk) => sock.write(`ack: ${chunk}`));
}).listen(path);
```

客户端：

```javascript
import net from "node:net";

const client = net.connect({ path: "/tmp/service.sock" }, () => client.write("hello"));
client.on("data", (data) => {
  console.log(data.toString());
  client.end();
});
```

---

## 7. 追踪与日志

### Span（跨度）

`jse.trace.startSpan(name, fn)` 在一个 span 内运行 `fn`，当 `fn` 返回或其 Promise 完成时结束 span，并记录任何抛出的错误。在 `fn` 内部启动的 span 会成为子 span。如果不传 `fn`，则返回一个需要用 `span.end()` 手动结束的开放 span。

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

### 传播上下文

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

### 日志

```bash
export JSE_LOG=debug        # debug | info | warn | error
export JSE_LOG_FORMAT=json  # text | json
```

```javascript
jse.log.info("order processed", { orderId: 8810, amount: 49.99 });
jse.log.warn("rate limit approaching", { current: 480, limit: 500 });
jse.log.error("payment failed", new Error("card declined"));
```

设置 `JSE_LOG_FORMAT=json` 时，每条日志以一个 JSON 对象一行的格式输出。

---

## 8. 任务队列

`jse.queue.open(path)` 打开一个存储在 SQLite 数据库中的队列（如果未指定路径则使用 `:memory:`）。

```javascript
const q = jse.queue.open("./tasks.db");

const id = q.push("emails", { to: "user@example.com" }, {
  maxRetries: 3, // default 5
  delayMs: 5000, // not deliverable for 5 s
});
```

`pop(topic, leaseMs)` 认领下一个待处理任务，租约时长为 `leaseMs` 毫秒（默认 30000）。如果任务在租约到期前未被确认，则会重新变为可用状态。

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

## 9. 加密与权限

### AES-GCM

支持的 AEAD 加密算法：`aes-128-gcm`、`aes-256-gcm`、`chacha20-poly1305`。如果密文、标签或 AAD 被篡改，`decipher.final()` 会抛出异常。

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

### 权限

`jse run` 默认禁止文件、网络、子进程和环境变量的访问，除非通过标志授予权限：

```bash
jse run --allow-read=./assets --allow-net=api.stripe.com src/server.ts
jse run --allow-all src/server.ts
```

---

## 10. 并发与并行

JavaScript 是单线程的。Node 通过事件循环（event loop）和 `worker_threads` 来解决这个问题，但 CPU 密集型工作仍然会阻塞主线程，Worker 的设置是手动的，也没有内置的线程池（thread pool）或通道（channel）原语。

Malia 提供了 Node 所没有的三样东西：工作线程池（worker pool）、有界通道（bounded channel）和流式 Worker（streaming worker）。每个 Worker 在专用的操作系统线程上运行自己的 V8 隔离实例（isolate）。I/O 在独立的 tokio 运行时上运行。JS 线程永远不会与网络处理竞争。

### WorkerPool

将 CPU 密集型工作分发到固定数量的 Worker。默认大小为 `CPU 核心数 - 1`，留一个核心给主线程和 I/O。可通过 `{ size: N }` 覆盖。

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

选项：`{ size, maxQueue, maxBuffered, timeoutMs }`。超过 `timeoutMs` 的任务会被终止，Worker 会被替换。`maxQueue` 在积压队列满时拒绝新任务。通过 `AbortSignal` 取消：

```javascript
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);
try {
  await pool.run(heavyInput, { signal: controller.signal });
} catch (e) {
  // e.message: "job aborted"
}
```

### 流式 Worker（Streaming workers）

当单个任务产生多个结果时，使用 `pool.stream()` 而不是 `pool.run()`。Worker 逐个发送结果；调用方以异步迭代器的方式消费它们。

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

### 有界通道（Bounded channels）

通道（channel）是同一隔离实例内异步任务之间的类型化消息队列。有界通道施加背压（backpressure）：缓冲区满时 `send()` 会等待。

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

通道在同一隔离实例内的任何异步上下文中都可工作：定时器、Promise、请求处理函数。通道不能跨 Worker 边界使用；跨 Worker 通信请使用 `postMessage`。

### 原始 Worker

标准的 `Worker` 和 `worker_threads` API 适用于线程池抽象不适合的场景。每个 Worker 是一个独立的 V8 隔离实例，拥有自己的事件循环（event loop）。

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

Worker 通过 `SO_REUSEPORT` 绑定相同端口。操作系统分发连接；没有主进程瓶颈。

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

### 与 Node 的区别

| | Node | Malia |
|---|---|---|
| Worker 设置 | 手动创建线程，手动消息循环 | `WorkerPool` 提供分发、超时、取消功能 |
| 并行 map | 需要自行实现 | `pool.map(items)` |
| 背压（Backpressure） | 异步任务间无背压机制 | 有界通道 `chan(capacity)` |
| HTTP I/O | 与 JS 在同一线程 | 独立的 tokio 运行时 |
| 异步文件/加密 | libuv 线程池（默认 4 个线程） | tokio 阻塞线程池（按 CPU 核心数扩展） |
| Worker 分发延迟 | ~10us/msg | ~0.04us/msg |

---

## 11. WebAssembly

`.wasm` 文件可以直接导入。导出内容可从默认导入上访问。

```javascript
import math from "./math.wasm";
console.log(math.add(40, 2));
```

```bash
jse run --wasm app.ts                 # select Wasm options; JavaScript still runs in V8
jse compile --wasm app.ts -o app.wasm # compile to a .wasm file
jse run app.wasm
```

`jse.optimizer` 在事件循环空闲时和 HTTP 请求批次之间触发 V8 内存压缩。

---

## 12. 容器部署

- `os.totalmem()`、`os.freemem()` 和默认工作线程池大小使用容器的 cgroup 限制。
- 作为 PID 1，SIGTERM 和 SIGINT 会在退出前运行 `process.on("SIGTERM"/"SIGINT")` 处理函数和 `jse.onShutdown` 钩子。
- `jse.serve` 和 `node:http` 默认绑定到 `0.0.0.0`。

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

## 13. 调试

### Chrome DevTools

```sh
jse --inspect run app.js
```

在 Chrome 中打开 `chrome://inspect`，点击"Configure"，添加 `127.0.0.1:9229`，你的目标会出现在"Remote Target"下。点击"inspect"打开 DevTools。断点、单步调试、控制台、堆快照（heap snapshot）和 CPU 性能分析均可使用。

### VS Code

在 `.vscode/launch.json` 中添加启动配置：

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

`--inspect-brk` 在第一行代码之前暂停，让 VS Code 有时间附加并命中断点。

### 自定义主机/端口

```sh
jse --inspect=0.0.0.0:9230 run app.js
```

绑定到所有网络接口（在容器内很有用）并使用非默认端口。

### 程序化访问

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

## 14. UDP 套接字

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

客户端：

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

如果套接字尚未绑定，`send()` 会自动绑定。`message` 事件传递一个 `Buffer` 和一个包含 `address`、`port`、`family` 和 `size` 的 `rinfo` 对象。

## 当前工程限制

部署前请参阅[兼容性矩阵](engineering/compatibility-matrix.md)。入口源码可执行文件不是完整的应用捆绑包。Wasm 源码容器仅通过 Malia 执行 JavaScript。TLS 服务端接受、TLS 套接字升级、自定义根证书和 VM 超时目前不受支持，会被拒绝。

HTTP 传入请求体低于 `maxBodyBytes`（默认 10 MiB）时会被缓存在内存中；更大的请求体通过通道（channel）流式传输，以便处理函数可以增量处理。使用 `jse.serve({ limits: { maxBodyBytes, maxRequests, maxConnections, bodyTimeoutMs, requestTimeoutMs } }, handler)` 配置限制。`handlerTimeout`、`handlerTimeoutMs` 和 `timeout` 是 `requestTimeoutMs` 的别名。默认值为：10 MiB 请求体、128 个请求、256 个连接、30 秒读取请求体超时和 30 秒处理函数响应超时。超时和请求体大小没有上限——由应用自行决定。完整响应上限为 8 MiB；更大的输出请使用流式传输。等待流式写入；一个流有八个 64 KiB 的原生块容量，每个提交的块最大为 1 MiB。Node HTTP 响应写入器必须在 `write()` 返回 false 时等待 `drain` 事件；排队超过 1 MiB 会被拒绝。`http.Agent({ keepAlive: true })` 为出站请求启用连接池。这些是每个监听器的限制，不是整个进程的 RSS 保证。

WorkerPool 默认值：1024 个排队任务、每个流 64 个缓冲回复和 30 秒活跃任务截止时间。选项为 `maxQueue`、`maxBuffered`、`timeoutMs` 和 `size`（最大 256）。`run(value, { signal })` 和 `stream(value, { signal })` 支持取消；取消操作会终止并替换 Worker。Worker 通道每个最多容纳 64 条消息，每条最大 1 MiB。旧的流完成标记值 `{ __done: true }` 仍为保留值。

KV 默认值为 100000 个键和 64 MiB 的逻辑键、值、条目和过期索引存储。容量错误会保留现有值。过期清理每 100 毫秒和每次操作最多删除 128 个键；分配器和哈希表开销不计入此预算的 RSS。KV 是进程本地的且非持久化的。

在安装到临时目标目录时设置 `MALIA_NO_MODIFY_PATH=1`，以保持 shell 配置文件不被修改。

---

## 15. AI 工具包

`malia.ai` 提供零 npm 依赖的内置 AI 功能。它自动检测本地大语言模型（Ollama、vLLM、LM Studio、llama.cpp）和云端提供商（OpenAI、Anthropic、Google、Mistral、Groq、xAI、DeepSeek、Together、Fireworks、Perplexity）。

### 一行代码对话

```javascript
// Auto-detect local Ollama or cloud provider from env vars
const reply = await malia.ai("Summarize this quarter's revenue trends");
console.log(reply);
```

### 流式输出

```javascript
const ai = malia.ai({ model: "llama3", system: "You are a data analyst" });
for await (const token of ai.stream("What drives customer churn?")) {
  process.stdout.write(token);
}
```

### 前沿模型

提供商从模型名称推断。设置对应的环境变量：

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

### 嵌入与相似度

```javascript
const ai = malia.ai();
const vecA = await ai.embed("machine learning");
const vecB = await ai.embed("artificial intelligence");
const score = malia.ai.similarity(vecA, vecB);
console.log("similarity:", score);  // ~0.85
```

### 对话记忆

```javascript
const ai = malia.ai({ system: "You are a tutor" });
await ai.chat("My name is Alice");
await ai.chat("What is my name?");  // "Alice"
console.log(ai.history);            // [{role, content}, ...]
ai.clear();                         // reset
```

### AI 驱动的 API 端点

```javascript
const ai = malia.ai({ system: "You are a customer support agent" });

jse.serve({ port: 3000 }, async (req) => {
  const { message } = await req.json();
  const reply = await ai.chat(message);
  return Response.json({ reply });
});
```

---

## 16. 热模块替换

在运行中的服务器上实现零停机代码替换。HTTP 套接字保持打开，keep-alive 连接持续有效，正在处理中的请求会使用旧的处理函数完成。

### 文件监听

```javascript
const server = jse.serve({ port: 3000 }, (req) => new Response("initial"));

// Watch handler file -- edits are picked up automatically
await server.hot("./handler.mjs");
```

`handler.mjs`：

```javascript
export default (req) => {
  return Response.json({ status: "live", version: 2 });
};
```

编辑文件并保存，服务器会在约 50ms 内完成热加载。无需重启，无需重新绑定端口，不会丢失连接。日志显示：

```
[INFO] [hot] reloaded ./handler.mjs (v2)
```

### 程序化重载

```javascript
const server = jse.serve({ port: 3000 }, handlerV1);

// Later -- deploy new code without restarting
server.reload(handlerV2);

// Check version
console.log(server.version);  // increments on each reload
```

### 工作原理

hyper HTTP 服务器运行在专用的 Rust 线程池（thread pool）上。JS 处理函数是 serve 事件循环中的可变函数引用。`reload()` 以原子方式替换引用。已经分发给旧处理函数的请求会正常完成；新请求立即使用新的处理函数。

### 生产部署模式

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

## 17. 包管理

Malia 包含一个内置的 npm 兼容包管理器。无需单独安装 Node.js。

### npm 和 npx 命令

安装 malia 时，会在 `~/.malia/bin` 中创建 `npm` 和 `npx` 命令。它们会路由到 malia 的内置包管理器：

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

`malia install` / `jse install` 命令功能完全相同：

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

### 工作原理

1. 如果有外部包管理器可用（npm、yarn、pnpm——通过锁文件检测），malia 会委托给它以获得完整的锁文件支持。
2. 如果未找到包管理器，malia 的内置安装器会处理：从 npm 注册中心获取包元数据，解析 semver 范围，下载并解压 tarball，并安装子依赖。
3. 全局安装到 `~/.malia/lib/node_modules/`，二进制链接在 `~/.malia/bin/`。

### 私有注册中心

设置 `NPM_REGISTRY` 以指向私有注册中心：

```sh
NPM_REGISTRY=https://registry.internal.com jse install
```

### 从 Node.js 迁移

如果你之前使用 Node.js 和 npm：

1. 安装 malia（安装器会在系统没有 npm 时创建 `npm`/`npx` 垫片，或设置 `MALIA_INSTALL_SHIMS=1` 以始终创建）
2. 现有的 `package.json` 和 `node_modules` 可以直接使用
3. `npm install`、`npm run`、`npm test` 均可正常工作
4. 可选择卸载 Node.js——malia 提供你所需的一切

---

## 18. 并发控制

### 带并发控制的并行 map

Node 的 `Promise.all(items.map(fn))` 会一次性全部触发。Malia 提供有界并行：

```javascript
// Process 1000 items, 20 at a time
const results = await malia.parallel.map(items, async (item) => {
  const res = await fetch(`/api/${item.id}`);
  return res.json();
}, { concurrency: 20 });
```

### 互斥锁（Mutex）和信号量（Semaphore）

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

### 带退避的重试

```javascript
const data = await malia.retry(async () => {
  const res = await fetch("https://flaky-api.example.com/data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}, { attempts: 3, delay: 200, backoff: 2 });
```

### 可复用线程池

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

## 19. 定时任务调度

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

## 20. 安全

### 安全中间件

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

### 安全扫描

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

## 21. 开发者工具

### 项目健康检查

```sh
malia doctor
```

检查项：package.json 有效性、node_modules 是否存在、锁文件、.gitignore 规则、.env 中的敏感密钥、系统信息。

### 静态文件服务器

```sh
malia serve .                    # serve current directory on port 3000
malia serve ./public --port 8080 # custom port
```

功能：目录列表、自动 `index.html`、MIME 类型、ETag 缓存、304 Not Modified、路径遍历保护。

### 环境检查

```sh
malia env
```

显示从 `.env` 文件解析的所有环境变量（附带来源）、配置文件中的环境设置以及运行时变量。敏感值（密码、令牌、密钥）会自动屏蔽。

### 清理

```sh
malia clean       # remove node_modules, .cache, dist, build
malia clean --all # also clear global download cache
```

### 自我更新

```sh
malia upgrade     # check latest version, show install command
```

---

## 22. 部署

### 生成部署文件

```sh
malia deploy              # generates all three
malia deploy docker       # Dockerfile + .dockerignore only
malia deploy compose      # docker-compose.yml only
malia deploy systemd      # <app-name>.service only
```

生成的 Dockerfile 在最小化的 Ubuntu 基础镜像中安装 malia，先复制 `package.json`（用于层缓存），安装依赖，然后复制代码。它设置 `NODE_ENV=production` 并暴露 `PORT` 环境变量中的端口。

### 使用 Docker 部署

```sh
malia deploy
docker compose up -d      # build and start
docker compose logs -f    # watch logs
docker compose down       # stop
```

### 使用 systemd 部署

```sh
malia deploy systemd
sudo cp my-app.service /etc/systemd/system/
sudo systemctl enable --now my-app
sudo journalctl -u my-app -f   # watch logs
```

---

## 23. 性能分析

```sh
malia profile server.js              # profile for 10 seconds (default)
malia profile server.js --duration 30  # profile for 30 seconds
```

输出内容包括：
- 按 CPU 时间排名的前 20 个函数（附文件:行号引用）
- 完整的 `.cpuprofile` 文件，可在 Chrome DevTools 中使用
- 内存使用情况（RSS、已用堆、总堆）

在 Chrome DevTools 中分析：
1. 打开 `chrome://inspect`
2. 点击"Open dedicated DevTools for Node"
3. 进入 Performance 标签页 -> Load profile -> 选择 `.cpuprofile` 文件

---

## 24. 数据库迁移

### 创建迁移

```sh
malia migrate create add_users_table
```

这将创建 `migrations/<timestamp>_add_users_table.up.sql` 和 `migrations/<timestamp>_add_users_table.down.sql`。

### 编写 SQL

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

### 运行迁移

```sh
malia migrate up       # apply all pending migrations
malia migrate down     # roll back the last applied migration
malia migrate status   # show [x] applied, [ ] pending
```

迁移记录存储在 `.malia-migrations.db` 中（自动创建）。迁移运行器使用内置的 SQLite 引擎。

---

## 25. 环境变量加密

### 加密 .env 以安全存入 git

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

### CI/CD 工作流

```sh
# In your CI environment, set MALIA_ENV_KEY as a secret
export MALIA_ENV_KEY=<64-char-hex>
malia env-encrypt decrypt    # restores .env from .env.encrypted
malia run --allow-all app.js # .env auto-loaded at startup
```

加密使用 AES-256-GCM，每次加密使用随机的 12 字节 nonce。密钥为 32 字节（64 个十六进制字符）。加密文件包含 `nonce (12 bytes) + 密文 + GCM tag (16 bytes)`。

### .gitignore

```
.env
.env.local
.env.*.local
# DO commit:
# .env.encrypted
```

---

## 26. 发布/订阅

### 基本发布/订阅（Pub/Sub）

```javascript
const bus = malia.pubsub();

bus.subscribe("orders", (order) => {
  console.log("New order:", order.id);
});

bus.publish("orders", { id: 123, total: 49.99 });
```

### 模式匹配

```javascript
bus.subscribe("events:*", (msg, topic) => {
  // Matches events:login, events:logout, events:purchase, etc.
  console.log(`[${topic}]`, msg);
});

bus.publish("events:login", { userId: 1 });
bus.publish("events:purchase", { amount: 99 });
```

### 消息历史（为后加入者重放）

```javascript
const bus = malia.pubsub({ history: 100 });

bus.publish("chat:room1", { user: "Alice", text: "hello" });
bus.publish("chat:room1", { user: "Bob", text: "hi" });

// New subscriber immediately receives the 2 messages above
bus.subscribe("chat:room1", (msg) => {
  console.log(msg.user + ":", msg.text);
});
```

### 异步模式

```javascript
// Wait for a single event
const { message } = await bus.once("ready");

// Async iterator (consume events as a stream)
for await (const { message, topic } of bus.listen("events:*")) {
  await processEvent(message);
}
```

### WebSocket 广播示例

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

## 27. 缓存

### 带 TTL 的 LRU 缓存

```javascript
const cache = malia.cache({ max: 1000, ttl: 60000 }); // 1000 entries, 60s TTL

cache.set("session:abc", { userId: 1, role: "admin" });
const session = cache.get("session:abc");

// Per-key TTL overrides
cache.set("temp", "value", { ttl: 5000 });  // expires in 5 seconds
```

### Cache-aside 模式

最常见的缓存模式：先查缓存，未命中时计算，然后存储结果。`getOrSet` 在一次调用中完成，并自动去重。

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

### 图片和文件缓存

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

### 函数记忆化

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

### 缓存与 HTTP 服务器

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

### 缓存统计与监控

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
