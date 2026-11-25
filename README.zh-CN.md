[English](README.md) | **中文**

# Malia

使用 Rust 构建的 JavaScript 和 TypeScript 运行时（Runtime）。与 Node 使用相同的
V8 引擎，可运行 npm 包，并自带包管理器。HTTP 由 hyper 在专用线程池（Thread Pool）
上处理，这也是速度提升的来源——你的 JS 仍然运行在 V8 上，与 Node 相同。

**实际更快的部分（经独立验证）：**

- **启动速度：快约 2.4 倍** -- V8 堆快照（Heap Snapshot），无引导开销。经独立测试
  确认（中位数 9.5ms 对比 23ms）。
- **Worker 创建速度：快约 2.5 倍** -- 隔离区（Isolate）复用，非 fork。首条消息
  在约 3.6ms 内到达，Node 约需 9ms。
- **连接建立：持平** -- hyper 处理每请求新连接的速度与 Node 的 libuv 相当。

**取决于硬件的部分：**

- **HTTP 长连接吞吐量** -- 我们的线程池架构受益于多核。在 2 核机器上，Node 的
  单线程事件循环（Event Loop）在长连接工作负载下可能更快，因为没有跨线程通道
  开销。在 4 核以上的机器上，线程池有空间发挥。请在目标硬件上进行基准测试。
- **内存** -- 在相同的 JS 工作负载下，堆大小相同（相同的 V8）。常驻内存集
  （RSS）略低（约 5-10%），因为进程更精简。更大的节省来自使用 malia 特有功能
  （KV 存储、堆外缓存）替代 JS 对象。

**相同的部分：** CPU 密集型 JavaScript 以相同速度运行——使用的是相同的 V8 引擎。
Malia 不会让你的 JS 更快，它让周围的基础设施（启动、HTTP、Worker）更快。

**原生插件（N-API）：** `.node` 文件通过 `dlopen` 加载，提供完整的 N-API 函数表
（149 个函数，Node-API v1 至 v9）。使用 `node-addon-api` 或原生 N-API 的插件可以
创建值、访问属性、调用函数、处理错误、管理引用、创建缓冲区（Buffer）以及运行异步
工作。已通过一个执行核心 API 表面的 C 插件测试。某些复杂插件可能仍会遇到未实现的
边缘情况——如果你发现了，请提交 issue。

**无需单独安装的功能：**

- 包管理器（`npm install`、`npx`、锁文件、发布）
- `.env` 加载（启动时自动加载）
- 定时任务（`malia.cron("*/5 * * * *", fn)`）
- 并发控制（`malia.parallel.map`、互斥锁（Mutex）、信号量（Semaphore））
- 带 TTL 的 LRU 缓存（`malia.cache`）
- 发布/订阅（`malia.pubsub`）
- 安全头、速率限制、CORS（`jse.secure`、`jse.rateLimit`、`jse.cors`）
- 安全扫描（`malia scan`、`malia secrets`、`malia sbom`）
- 部署脚手架（`malia deploy` -> Dockerfile、systemd）
- CPU 性能分析（`malia profile`）
- 数据库迁移（`malia migrate`）
- 加密环境变量文件（`malia env-encrypt`）
- Redis 客户端（`malia.redis`）——无需 ioredis
- S3 客户端（`malia.s3`）——无需 @aws-sdk
- Shell 脚本（`malia.$`）——标记模板，替代 zx/execa
- YAML/TOML 解析（`malia.yaml`、`malia.toml`）
- 打包器（`malia bundle`）、格式化器（`malia fmt`）、代码检查（`malia lint`）
- SQLite、KV 存储、任务队列、路由器、追踪、结构化日志
- TypeScript（加载时转译，磁盘缓存）

**与 Node 的架构差异：**

- HTTP 服务器运行在 hyper（Rust）的独立线程池上，不在 JS 事件循环上
- Worker 拥有真正的操作系统线程和独立的 V8 隔离区
- 权限默认拒绝（类似 Deno，不同于 Node）
- 有界通道（`chan()`）支持背压（Backpressure），用于异步协调
- 热重载（Hot Reload）在运行中的服务器上替换处理器，无需重启

`jse.*` 全局变量是 `malia.*` 的别名，用于向后兼容。新代码应使用 `malia.*`。

常见任务指南请参阅 [docs/HOWTO.md](docs/HOWTO.md)。

## 安装

提供 macOS、Linux 和 Windows 的预编译二进制文件。无需安装 Rust 或构建工具。

**macOS / Linux（一行命令）**

```sh
curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh
```

安装 `malia`、`jse`、`npm`、`npx` 和 `node` 到 `~/.malia/bin` 并添加到 `PATH`。
`npm`、`npx` 和 `node` 命令内置于 malia——无需单独安装 Node.js。

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

软件包将 `malia` 和 `jse` 安装到 `/usr/bin`。

**Windows**

```powershell
irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex
```

**手动下载**

归档文件和 `SHA256SUMS` 附在每个
[GitHub 发布页](https://github.com/loreste/malia/releases)中；推送 `v*`
标签会触发构建（`.github/workflows/release.yml`）：

| 平台 | 归档文件 |
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

Linux glibc 构建（归档文件、.deb、.rpm）需要 glibc 2.28 或更高版本：RHEL/Alma/Rocky 8+、
Debian 10+、Ubuntu 20.04+。musl 构建无 glibc 要求。

发布流程：在 `Cargo.toml` 中设置版本号，运行 `scripts/version.py sync`（npm 包），
然后推送匹配的 `v<version>` 标签；版本不匹配时发布会被拒绝。

**从源码编译**

```sh
cargo build --release
```

生成 `target/release/malia` 和 `target/release/jse`。`build.rs` 会将 `src/ops.rs`
再次编译以生成启动快照（Startup Snapshot），因此首次构建会编译 `deno_core` 及其
依赖两次。

## 用法

```sh
malia run examples/hello.ts                     # 运行 TypeScript 文件
malia run --allow-net examples/server.js        # HTTP 服务器
malia eval --allow-all 'console.log(6*7)'       # 作为 ES 模块执行代码片段
malia                                           # REPL（支持顶层 await）

malia compile examples/hello.ts -o dist/hello   # 宿主平台入口源码嵌入
malia compile --wasm examples/hello.ts -o app.wasm
malia run app.wasm
```

### 命令

| 命令 | 描述 |
|---|---|
| `malia` | 运行项目配置中的入口点（参见[配置](#配置)）；如未找到则打开 REPL |
| `malia run <file\|dir>` | 运行 `.js`、`.mjs`、`.cjs`、`.ts`、`.mts`、`.cts`、`.tsx`、`.jsx` 或 `.wasm` 文件。`--watch` 在文件变更时重启；`--wasm` 选择 Wasm 相关运行时选项；JavaScript 仍在 V8 中运行 |
| `malia eval <code>` | 作为 ES 模块执行代码片段 |
| `malia repl` | 启动 REPL |
| `malia init [--toml]` | 创建项目配置文件 |
| `malia dev` | 运行入口点并在文件变更时重启 |
| `malia start` | 运行入口点；配置了 `cluster` 时 fork 集群 Worker |
| `malia test` | 运行测试（`node:test`，TAP 输出） |
| `malia install` / `add` / `i` | 从 npm 注册表安装包（内置或委托给 npm/yarn/pnpm） |
| `malia install -g <pkg>` | 全局安装包到 `~/.malia/bin` |
| `malia uninstall` / `rm` | 从 `node_modules` 和 `package.json` 中移除包 |
| `malia list` / `ls` | 列出已安装的包 |
| `malia outdated` | 显示有更新版本的包 |
| `malia audit` | 检查已安装包的已知漏洞 |
| `malia link [dir]` | 将本地包通过符号链接添加到 `node_modules` 或全局 |
| `malia x <bin>` | 运行 `node_modules/.bin` 中的二进制文件，回退到 npx |
| `malia npm <args>` | 将参数透传给 npm |
| `malia config [show\|get <key>]` | 打印解析后的配置 |
| `malia compile <file>` | 将源码嵌入运行时二进制文件。`--wasm` 将源码包装在 Wasm 容器中（仍需 malia 运行——这是打包，不是 JS 到 Wasm 的编译） |
| `malia build` | 将配置的入口源码嵌入宿主运行时 |
| `malia bench <file>` | 运行文件并打印墙钟时间 |
| `malia serve [dir]` | 即时静态文件服务器，支持目录列表、ETag、MIME 类型 |
| `malia doctor` | 诊断项目健康状况：依赖、锁文件、配置、安全检查 |
| `malia clean [--all]` | 移除 `node_modules`、缓存、临时文件；`--all` 清除全局缓存 |
| `malia upgrade` | 检查并安装最新 malia 版本 |
| `malia env` | 显示从 `.env` 文件和配置中解析的环境变量 |
| `malia scan [path]` | 扫描源代码中的安全漏洞 |
| `malia secrets [path]` | 查找泄露的 API 密钥、令牌和凭据 |
| `malia permissions <file>` | 在运行脚本之前显示其所需的权限 |
| `malia sbom` | 生成 CycloneDX SBOM 用于合规审计 |
| `malia deps [--tree] [--licenses]` | 依赖树，包含大小和许可证分析 |
| `malia deploy [docker\|compose\|systemd\|all]` | 生成生产环境部署文件 |
| `malia profile <file>` | 使用 V8 inspector 进行 CPU 性能分析，生成热点函数报告 |
| `malia migrate [create\|up\|down\|status]` | 数据库迁移运行器，使用 SQLite 追踪状态 |
| `malia env-encrypt [encrypt\|decrypt]` | 使用 AES-256-GCM 加密 `.env` 文件 |
| `malia fmt [files]` | 使用 dprint 格式化源代码文件（首次使用时自动下载）。`--check` 用于 CI |
| `malia lint [files]` | 使用 oxlint 检查源代码文件（首次使用时自动下载）。`--fix` 自动修复 |
| `malia bundle <file>` | 将 ES 模块打包为单个文件。解析相对导入 |
| `malia verify` | 验证运行时二进制文件的完整性，对比已发布的 SHA-256 校验和 |
| `malia <script>` | 运行配置文件或 `package.json` 中定义的脚本 |

### 包管理

Malia 内置包管理器。无需单独安装 npm 或 Node.js。安装 malia 时会自动创建 `npm`
和 `npx` 命令，并路由到内置安装器。

```sh
# 以下命令开箱即用，无需 Node.js：
npm install express            # 安装包
npm install -g http-server     # 全局安装
npm uninstall lodash           # 移除包
npm init -y                    # 创建 package.json
npm ls                         # 列出已安装的包
npm run dev                    # 运行脚本
npm test                       # 运行测试
npx cowsay hello               # 执行包的二进制文件

# 或使用 malia 等效命令：
malia install express
malia install -g http-server
malia uninstall lodash
malia list
```

内置包管理器支持完整的 npm 工作流：锁文件生成（`package-lock.json` v3）、语义化
版本解析、对等依赖（Peer Dependencies）、可选依赖、捆绑依赖、下载缓存
（`~/.malia/cache`）以及 `.npmrc` 认证用于私有注册表。生命周期脚本
（`postinstall`）默认禁用以确保安全——设置 `MALIA_SCRIPTS=1` 以启用。

如果检测到外部包管理器（npm、yarn、pnpm）的锁文件，malia 会委托给它。否则由
内置安装器处理一切。

支持全部 25 个 npm 命令：`install`、`uninstall`、`update`、`list`、`outdated`、
`audit`、`init`、`link`、`pack`、`publish`、`prune`、`dedupe`、`rebuild`、
`cache`、`config`、`info`、`fund`、`whoami`、`prefix`、`root`、`exec`、`run`、
`test`、`start`、`version`。

```sh
NPM_REGISTRY=https://registry.internal.com malia install   # 私有注册表
MALIA_INSTALL_SHIMS=1 # 即使系统版本存在也创建 npm/npx/node 垫片
```

### Node 兼容标志

`-r/--require`、`--import`、`-e/--eval`、`-p/--print`、`-c/--check`、
`-i/--interactive`、`-v/--version`、`--no-warnings`、`--max-old-space-size`、
`--inspect[=host:port]`、`--inspect-brk[=host:port]`
以及 `--enable-source-maps` 均已支持。`NODE_OPTIONS` 中的标志也会被读取。
`process.version` 为 `v26.12.0`，通过 `node` 符号链接调用时，`--version` 打印相同值。

### 调试

```sh
malia --inspect run app.js              # 在 127.0.0.1:9229 启动调试器
malia --inspect-brk run app.js          # 在第一行暂停
malia --inspect=0.0.0.0:9230 run app.js # 自定义主机/端口
```

在 Chrome 中打开 `chrome://inspect` 或连接 VS Code 调试器
（`"type": "node"` 启动配置）。运行时会在 stderr 上打印 WebSocket URL。
断点、单步执行、控制台、堆快照和 CPU 性能分析均通过 V8 内置 inspector 工作。

## 权限

`malia run` 默认拒绝所有能力。REPL 无限制运行。按类别授予访问权限：

```sh
malia run --allow-read script.js                  # 所有文件系统读取
malia run --allow-read=/tmp,/data script.js       # 仅限这些路径下的读取
malia run --allow-write=/tmp script.js            # 文件系统写入
malia run --allow-net script.js                   # fetch、jse.serve、node:http
malia run --allow-net=api.example.com script.js   # 仅限这些主机
malia run --allow-run=node,git script.js          # 仅限这些可执行文件
malia run --allow-env script.js                   # 环境变量
malia run --allow-all script.js                   # 所有权限
```

被拒绝的调用会抛出 `PermissionDenied: <kind> access to <what>, run again
with <flag>`。未使用 `--allow-env` 时，`process.env` 为空而非抛出异常。模块导入
不受检查（与 Deno 相同）。检查适用于运行时文件系统操作（包括 SQLite 数据库）、
fetch（每次重定向跳转）、serve、WebSocket、child_process 和 env 操作。Worker
继承进程权限。

路径列表在解析 `..` 和符号链接后进行比较，包括目标尚不存在的符号链接。
`--allow-run` 条目通过 `PATH` 解析为可执行文件，只有当实际运行的程序（在子进程的
`PATH` 和 `cwd` 中查找）匹配时才允许生成子进程。

## 配置

运行时按顺序查找：`malia.json`、`malia.toml`、`malia.config.json`、`jse.json`、
`jse.toml`、`jse.config.json`，然后回退到 `package.json`。JSON 配置文件支持注释
和尾随逗号。

```jsonc
{
  "name": "my-app",
  "version": "1.0.0",
  "entry": "src/index.ts",
  // ${VAR:-default} 会被展开
  "env": {
    "PORT": "3000",
    "API_URL": "http://localhost:${PORT:-3000}/v1"
  },
  // "all"、"strict" 或包含 read/write/net 列表的对象
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

等效的 `jse.toml`：

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

## 架构

```
┌──────────────────────────── malia 进程 ───────────────────────────────┐
│                                                                        │
│  CLI (clap)                                                            │
│    malia run <file> ─┐                                                 │
│    malia eval <code> ┼──► 多线程 tokio 运行时（监督者）                │
│    malia (REPL)     ─┘        │ spawn_blocking                         │
│                               ▼                                        │
│              主 OS 线程 + 单线程 tokio 运行时                          │
│                             │                                          │
│                    ┌────────▼─────────┐      ops (op2)                 │
│                    │ JsRuntime (V8    │ ──► op_sleep / op_read_file…   │
│                    │  isolate #0)     │ ──► op_chan_* (tokio mpsc)     │
│                    │  + 启动快照      │ ──► op_worker_*                │
│                    │  + 模块加载器    │ ──► op_crypto_* / op_url_*     │
│                    └────────┬─────────┘ ──► op_fetch (reqwest+rustls)  │
│                             │ new Worker(path) / WorkerPool            │
│        ┌────────────────────┼────────────────────┐                     │
│        ▼                    ▼                    ▼                     │
│  worker 线程          worker 线程          worker 线程                 │
│  单线程运行时         单线程运行时         单线程运行时                │
│  JsRuntime (V8 #1)    JsRuntime (V8 #2)    JsRuntime (V8 #3)  ...      │
│        └────────────────────┼────────────────────┘                     │
│        postMessage/onmessage 使用 V8 结构化克隆二进制数据              │
│                                                                        │
│  ModuleLoader: ESM │ TS 转译 (deno_ast/SWC, 磁盘缓存) │               │
│  CJS 包装 │ npm 解析 (node_modules 向上查找, exports/main, JSON)       │
└────────────────────────────────────────────────────────────────────────┘
```

- **执行引擎**：V8 15.0（`v8` crate 150.4），来自 `deno_core` 0.412。
- **启动快照**：`src/js/` 中的 JS 引导程序（console、process、Buffer、定时器、
  通道、Worker、WorkerPool、URL、fetch 等）由 `build.rs` 序列化为 V8 堆快照，
  并在启动时反序列化。
- **事件循环**：`deno_core` 的事件循环在 tokio 上轮询。V8 隔离区是 `!Send` 的，
  因此每个隔离区（主线程和每个 Worker）运行在自己的 OS 线程上，拥有独立的单线程
  tokio 运行时。
- **阻塞工作**：异步文件系统调用、文件流和 zlib 运行在 tokio 的阻塞线程池上。
  `*Sync` API 运行在隔离区线程上。
- **定时器**：`setTimeout`/`setInterval`/`sleep` 使用 JS 端的截止时间桶最小堆
  （`src/js/02_timers.js`），配合单个 `op_sleep_until` 设置为最早截止时间。
- **HTTP 服务器**：hyper 1.x 的 accept 和连接任务运行在独立的多线程 tokio 运行时
  上。请求通过通道批量传递给隔离区。
- **V8 代码缓存**：用户模块的编译字节码存储在磁盘上（`src/cache.rs`），后续运行
  时复用。
- **TypeScript**：仅转译（不做类型检查）。输出缓存在 `$JSE_CACHE_DIR`，未设置时
  使用 `$TMPDIR/jse-tscache-v<version>`。
- **npm / CommonJS**：Node 风格解析（`node_modules` 向上查找、`package.json` 的
  `main`/`exports`/`imports`/`type`、`index.js`、扩展名搜索）。CommonJS 模块被包装
  为 ESM 并导出静态命名导出，因此 `import { get } from "lodash"` 和
  `import lodash from "lodash"` 均可工作。

## 语言和模块支持

| 特性 | 状态 |
|---|---|
| ECMAScript | V8 15.0 支持的所有特性，包括 ES2024 和 ES2025（`Promise.withResolvers`、`Object.groupBy`、`RegExp.escape`、`Promise.try`、`Float16Array`、Set 方法、迭代器辅助方法）。参见 `tests/fixtures/es_features.js` |
| Import attributes | `with { type: "json" }`。不支持 `text` 和 `bytes` |
| TypeScript | `.ts`、`.mts`、`.cts`、`.tsx`、`.jsx` 转译；`.cts` 作为 CommonJS 加载；`tsconfig.json` 的 `paths` 和 `baseUrl`；ECMA 装饰器 |
| ESM | 静态和动态导入、顶层 await、`import.meta` |
| CommonJS | `.cjs` 以及没有 `"type": "module"` 的包中的 `.js`；`module`、`exports`、`require`、`__filename`、`__dirname` |
| npm | 裸标识符；`exports` 条件 `import`/`require`/`node`/`default` 和子路径模式；`imports`（`#…`）；`NODE_PATH` |
| WebAssembly | `import m from "./m.wasm"`、`require("./m.wasm")`、`WebAssembly.compileStreaming`/`instantiateStreaming`、WASI Preview 1（`node:wasi`） |

## 运行时 API

| API | 描述 |
|---|---|
| `fetch`、`Request`、`Response`、`Headers` | reqwest + rustls。解码 gzip、deflate 和 Brotli 响应；`redirect` 可为 `follow`、`manual` 或 `error`。响应体支持流式（`response.body` 可异步迭代且有 `getReader()`）。`clone()` 仅适用于未消费的响应（已消费的按 WHATWG 规范抛出 `TypeError`）。请求体支持：字符串、`URLSearchParams`、`Blob`、`FormData`、`ArrayBuffer`/类型化数组，以及流式（分块）`ReadableStream`/异步可迭代对象。中止信号清理底层连接 |
| `jse.serve(options, handler)` | Deno 风格的 HTTP 服务器。处理器返回 `Response` 或其 Promise。支持长连接、完整和分块响应体、TLS、大文件上传的请求体流式传输、可配置的超时/限制。`server.reload(fn)` 零停机热替换处理器；`server.hot(path)` 监视文件并在变更时重载。正确的错误码：408 超时、413 负载过大、502 网关错误、503 服务不可用、504 网关超时 |
| `WebSocket`、`jse.upgradeWebSocket(req)` | WebSocket 客户端和服务器升级。`binaryType` 可为 `nodebuffer`、`arraybuffer` 或 `blob` |
| `chan(capacity?)` | 通道，支持 `send`/`recv`/`close`/`for await`，基于 tokio mpsc。有界通道施加背压 |
| `Worker`、`WorkerPool` | 每个 Worker 一个 OS 线程和 V8 隔离区。消息使用 V8 结构化克隆。`new WorkerPool(path, { size })` 默认为 `cpus - 1`（为主线程留出空间）。`pool.run(arg)`、`pool.map(items)`、`pool.stream(arg)`（异步可迭代）、`pool.close()`。支持 `{ signal }` 取消和 `{ timeoutMs }` 超时 |
| `structuredClone` | V8 值序列化器 |
| `URL`、`URLSearchParams` | `URL` 通过 `url` crate 实现；`URLSearchParams` 在 JS 中实现 |
| `jse.Router` | 支持 `:param` 和通配符路由的路由器；`router.static()` 提供带 ETag 和 304 处理的文件服务 |
| `jse.kv` | 进程内键值存储，存放在 V8 堆外。版本控制、比较并交换、计数器、TTL |
| `jse.sql` | 通过标记模板的嵌入式 SQLite；`jse.sql.open(path)` 返回 `Database` |
| `jse.queue` | 基于 SQLite 的任务队列：`push`、带租约的 `pop`、`ack`、`nack`、通过 `dead` 实现死信队列 |
| `jse.trace` | Span、W3C `traceparent` 注入/提取、OTLP JSON 导出。`autoInstrument()` 包装 `fetch()` 自动创建 span；`instrumentedHandler(fn)` 包装 serve 处理器进行入站请求追踪和追踪上下文传播 |
| `jse.log` | 结构化日志（文本或 JSON）。通过 `JSE_LOG`、`JSE_LOG_FORMAT`、`JSE_HTTP_LOG` 配置 |
| `jse.onShutdown`、`jse.healthCheck`、`jse.metrics` | SIGTERM/SIGINT 关闭钩子、健康检查处理器、Prometheus 格式指标 |
| `jse.optimizer` | 设置 V8 Wasm 分层编译标志，在空闲轮次和请求批次间触发 V8 内存压缩 |
| `malia.ai` | 内置 AI 工具包。自动检测本地 Ollama/vLLM/LM Studio。`malia.ai("prompt")` 一次性对话，`ai.stream("prompt")` 流式输出，`ai.embed("text")` 获取向量，`AI.similarity(a, b)` 余弦距离。对话记忆、系统提示、可配置模型。无需 npm 包 |
| `malia.parallel` | 受控并行度的并发执行。`parallel.map(items, fn, {concurrency})`、`parallel.filter`、`parallel.each`、`parallel.reduce`、`parallel.pool`、`parallel.pipeline`、`parallel.race`、`parallel.any`。参见[并发控制](#并发控制-maliaparallel) |
| `malia.mutex`、`malia.semaphore` | 异步互斥锁和计数信号量，用于保护共享状态 |
| `malia.cron` | 内置定时任务调度器。5/6 字段表达式、范围、步进、日/月名称。`cron.every("5m", fn)`、`cron.daily()`、`cron.weekly()`。参见[定时任务调度器](#定时任务调度器-maliacron) |
| `malia.retry` | 指数退避重试：`retry(fn, {attempts, delay, backoff})` |
| `malia.timeout` | 截止时间强制：`timeout(promise, ms)` |
| `malia.batch` | 分块处理：`batch(items, size, fn)` |
| `malia.debounce`、`malia.throttle` | 函数速率限制工具 |
| `jse.secure` | 安全头中间件：HSTS、noSniff、frameOptions、CSP、COOP、CORP、referrer 策略 |
| `jse.rateLimit` | 按 IP 速率限制，带 `Retry-After` 和 `X-RateLimit` 响应头 |
| `jse.cors` | CORS 中间件，支持预检请求、可配置来源/方法/凭据 |
| `malia.pubsub` | 进程内发布/订阅：`subscribe(pattern, fn)`、`publish(topic, msg)`、模式匹配（`events:*`）、为后加入者提供消息历史、`once()` Promise、异步迭代器 |
| `malia.cache` | 带 TTL 的 LRU 缓存、大小限制、`getOrSet(key, fn)` 缓存旁路模式（自动去重）、`cache.memoize(fn)`、批量操作、命中/未命中统计、`onEvict` 回调。替代 `lru-cache`（每周 1 亿下载） |
| `malia.redis(url?)` | 内置 Redis 客户端：GET、SET、DEL、MGET、MSET、INCR、EXPIRE、TTL、列表、哈希、集合、发布/订阅、管道。连接池。替代 `ioredis`（每周 1300 万下载） |
| `malia.s3(options)` | 内置 S3 客户端：GET、PUT、DELETE、预签名 URL。SigV4 签名。兼容 AWS S3、R2、MinIO。替代 `@aws-sdk/client-s3` |
| `malia.$\`cmd\`` | Shell 脚本：标记模板字面量，支持插值、转义、管道。`$.nothrow` 为不抛出异常的变体。替代 `zx`、`execa`、`shelljs` |
| `malia.yaml` | YAML 解析/序列化。替代 `js-yaml`（每周 7000 万下载） |
| `malia.toml` | TOML 解析/序列化。内置，无需额外包 |

Web 全局变量：`self`、`window`、`global`、`navigator`、`DOMException`、
`btoa`、`atob`、`crypto.getRandomValues`、`crypto.randomUUID`、
`crypto.subtle`（见下文）、`CryptoKey`、`EventTarget`、`Event`、`CustomEvent`、
`MessageEvent`、`CloseEvent`、`ErrorEvent`、`AbortController`、
`AbortSignal`（`abort`、`timeout`、`any`）、`Blob`、`File`、`FormData`、
`MessageChannel`、`BroadcastChannel`、`TextEncoder`/`TextDecoder`（utf-8、utf-16le、latin1；
`fatal`、`ignoreBOM`、`stream`），以及 WHATWG 流（`ReadableStream`、
`WritableStream`、`TransformStream`、`TextEncoderStream`、`TextDecoderStream`、
`CompressionStream`、`DecompressionStream`）。

`crypto.subtle` 支持 `digest`、`generateKey`、`importKey`/`exportKey`
（raw、pkcs8、spki、jwk）、`sign`/`verify`（HMAC、RSASSA-PKCS1-v1_5、RSA-PSS、
ECDSA、Ed25519）、`encrypt`/`decrypt`（AES-GCM、AES-CBC、AES-CTR、RSA-OAEP）、
`deriveBits`/`deriveKey`（PBKDF2、HKDF）和 `wrapKey`/`unwrapKey`。

`setTimeout`/`setInterval` 返回 `Timeout` 对象（`ref`、`unref`、`hasRef`、
`refresh`）；`setImmediate` 在 I/O 之后、后续定时器之前运行。
`sleep(ms)` 返回 Promise；`sleep(ms, { signal })` 可通过 `AbortSignal` 取消。

## AI 工具包（`malia.ai`）

内置 AI，零配置。自动检测本地大语言模型（LLM）和云服务提供商。本地模型无需 npm 包、
无需 API 密钥。

```javascript
// 一行代码——自动检测 Ollama、vLLM、LM Studio 或 llama.cpp
const reply = await malia.ai("What is quantum computing?");

// 流式输出
const ai = malia.ai({ model: "llama3", system: "Be concise" });
for await (const token of ai.stream("Explain gravity")) {
  process.stdout.write(token);
}

// 前沿模型——从模型名称和环境变量自动检测提供商
const ai = malia.ai("gpt-4o");              // 使用 OPENAI_API_KEY
const ai = malia.ai("claude-sonnet-4-20250514");     // 使用 ANTHROPIC_API_KEY
const ai = malia.ai("gemini-2.0-flash");    // 使用 GOOGLE_API_KEY
const ai = malia.ai("grok-3");              // 使用 XAI_API_KEY
const ai = malia.ai("mistral-large-latest");// 使用 MISTRAL_API_KEY

// 嵌入向量 + 相似度
const vec = await ai.embed("search query");
const score = malia.ai.similarity(vecA, vecB);

// 对话记忆
const ai = malia.ai({ system: "You are a helpful assistant" });
await ai.chat("My name is Alice");
await ai.chat("What is my name?");  // 记住了："Alice"
ai.clear();  // 重置对话
```

支持的提供商：OpenAI、Anthropic（原生 Messages API）、Google Gemini、Mistral、
Groq、DeepSeek、Together、Fireworks、Perplexity、xAI，以及任何 OpenAI 兼容端点
（Ollama、vLLM、LM Studio、llama.cpp）。

## 热模块替换

在运行中的服务器上零停机代码替换。HTTP 套接字保持打开，长连接持续，正在处理的
请求使用旧处理器完成。无需重启，无需重新绑定端口，无丢弃请求。

```javascript
// 监视处理器文件——编辑会被自动捕获
const server = jse.serve({ port: 3000 }, initialHandler);
await server.hot("./handler.mjs");  // 监视文件，变更时重载

// 或通过编程方式替换
server.reload(newHandler);  // 即时，零停机
```

工作原理：hyper HTTP 服务器运行在独立的线程池上。JS 处理器是一个可变引用——
`reload()` 原子性地替换它。新请求立即使用新处理器；正在处理的请求使用其开始时
活跃的处理器完成。

## 并发控制（`malia.parallel`）

`Promise.all(urls.map(fetch))` 会同时发出所有请求。如果你有 1000 个 URL，
那就是 1000 个并发连接。`malia.parallel.map` 允许你设置并发限制。

```javascript
// 获取 100 个 URL，每次 10 个（而非同时 100 个）
const data = await malia.parallel.map(urls, url => fetch(url).then(r => r.json()), {
  concurrency: 10
});

// 并发过滤
const live = await malia.parallel.filter(hosts, async h => {
  try { await fetch(h); return true; } catch { return false; }
}, { concurrency: 20 });

// 异步互斥锁——保护共享状态
const lock = malia.mutex();
await lock.run(async () => { /* 临界区 */ });

// 信号量——限制并发访问
const sem = malia.semaphore(5);
await sem.run(async () => { /* 最多 5 个并发 */ });

// 指数退避重试
const result = await malia.retry(() => fetch(url), {
  attempts: 3, delay: 100, backoff: 2
});

// 截止时间强制
await malia.timeout(fetch(url), 5000, "API call timed out");

// 可复用的并发执行器
const pool = malia.parallel.pool(url => fetch(url).then(r => r.json()), {
  concurrency: 5
});
const data = await pool.submit("https://api.example.com/data");
```

另外可用：`malia.parallel.each`、`malia.parallel.reduce`、
`malia.parallel.race`、`malia.parallel.any`、`malia.parallel.pipeline`、
`malia.batch`、`malia.debounce`、`malia.throttle`。

## 定时任务调度器（`malia.cron`）

内置定时任务，无需 npm 包。支持 5 字段（分钟级）和 6 字段（秒级）表达式、范围、
步进、日/月名称。

```javascript
malia.cron("*/5 * * * *", () => console.log("every 5 minutes"));
malia.cron("0 9 * * MON-FRI", () => sendDailyReport());
malia.cron("*/30 * * * * *", () => checkHealth());  // 每 30 秒

// 简写辅助方法
malia.cron.every("10s", fn);   // 每 10 秒
malia.cron.every("5m", fn);    // 每 5 分钟
malia.cron.daily(9, 0, fn);    // 每天 9:00
malia.cron.weekly(1, 8, fn);   // 每周一 8:00

// 任务控制
const job = malia.cron("0 * * * *", handler);
job.stop();                    // 暂停
job.start();                   // 恢复
job.trigger();                 // 立即触发
console.log(job.runCount);     // 已执行次数
```

## 安全

Malia 默认拒绝文件系统、网络和子进程访问。你需要在每次运行时显式授予权限。

**默认拒绝权限**（参见[权限](#权限)）：脚本在没有显式标志的情况下无法读取文件、
访问网络或生成进程。

**内置安全中间件**（替代 `helmet` + `express-rate-limit` + `cors`）：

```javascript
// 安全头：HSTS、X-Content-Type-Options、X-Frame-Options、CSP、COOP、CORP
const server = jse.serve({ port: 3000 }, jse.secure(handler));

// 速率限制：按 IP，带 Retry-After 和 X-RateLimit 响应头
const server = jse.serve({ port: 3000 }, jse.rateLimit(handler, {
  window: 60000, max: 100
}));

// CORS：可配置来源、方法、凭据、预检请求
const server = jse.serve({ port: 3000 }, jse.cors(handler, {
  origin: "https://app.example.com"
}));

// 组合使用：
jse.serve({ port: 3000 }, jse.secure(jse.rateLimit(jse.cors(handler))));
```

**相比 Node.js 的安全加固：**

- `setTimeout("string")` 被阻止（基于 eval 的代码注入）
- 包的 `postinstall` 脚本默认禁用（供应链防御）
- Tarball 解压拒绝符号链接和路径遍历
- 防止 HTTP 请求走私（冲突的 CL+TE 头按 RFC 7230 解析）
- 热重载限制在项目目录内

**安全工程师的 CLI 工具：**

```sh
malia scan .              # 静态分析：30+ 种漏洞模式（XSS、注入、密钥泄露、TLS 绕过）
malia secrets .           # 检测泄露的 API 密钥：AWS、GitHub、Stripe、OpenAI、Slack、SSH、JWT
malia permissions app.js  # 在运行脚本之前显示其所需权限
malia sbom                # 生成 CycloneDX 1.5 SBOM 用于合规
malia deps --licenses     # 所有依赖的许可证审计
malia audit               # 检查 npm 咨询数据库的已知 CVE
```

## 开发者和系统管理员工具

```sh
malia doctor              # 检查项目健康：依赖、锁文件、配置、.gitignore、密钥
malia serve .             # 即时静态文件服务器：目录列表、ETag、MIME 类型
malia clean               # 移除 node_modules、.cache、dist、build、锁文件
malia clean --all         # 同时清除全局下载缓存
malia upgrade             # 检查更新，显示安装命令
malia env                 # 显示解析后的环境变量（密钥自动遮蔽）
```

**自动 `.env` 加载**：malia 在启动时加载 `.env`、`.env.local`、`.env.<NODE_ENV>`、
`.env.<NODE_ENV>.local`。无需 `dotenv` 包。已存在的环境变量优先。

## 部署

从项目配置生成生产就绪的部署文件：

```sh
malia deploy              # 生成 Dockerfile、docker-compose.yml、systemd 服务文件
malia deploy docker       # 仅 Dockerfile
malia deploy systemd      # 仅 .service 文件
```

生成的 Dockerfile 使用最小化 Ubuntu 基础镜像，安装 malia，复制代码，并以
`--allow-all` 运行。docker-compose.yml 包含健康检查和重启策略。systemd 服务
文件可直接用于 `systemctl enable --now`。

## 性能分析

```sh
malia profile app.js              # 10 秒 CPU 分析（默认）
malia profile app.js --duration 30  # 30 秒分析
```

输出按 CPU 时间排名的热点函数，并保存 `.cpuprofile` 文件，可在 Chrome DevTools
（Performance 标签页）中加载。同时报告 RSS 和堆内存。

## 数据库迁移

```sh
malia migrate create add_users    # 创建带时间戳的 up/down SQL 文件
malia migrate up                  # 应用待处理的迁移
malia migrate down                # 回滚最后一次迁移
malia migrate status              # 显示已应用的迁移
```

迁移在本地 SQLite 数据库（`.malia-migrations.db`）中追踪。每次迁移是 `migrations/`
目录中一对 `.up.sql` 和 `.down.sql` 文件。

## 环境变量加密

```sh
malia env-encrypt encrypt           # .env -> .env.encrypted (AES-256-GCM)
malia env-encrypt decrypt           # .env.encrypted -> .env
malia env-encrypt encrypt --key=... # 使用指定密钥
```

可安全地将 `.env.encrypted` 提交到 git。在 CI/CD 环境中设置 `MALIA_ENV_KEY`
或传递 `--key`。未指定密钥时会自动生成并打印。

## 发布/订阅（`malia.pubsub`）

用于实时应用的进程内发布/订阅。无需 Redis、socket.io 或 npm 包。

```javascript
const bus = malia.pubsub({ history: 50 });  // 保留最近 50 条消息

// 使用模式匹配订阅
bus.subscribe("events:*", (msg, topic) => {
  console.log(topic, msg);
});

bus.publish("events:user.login", { userId: 123 });
bus.publish("events:order.created", { orderId: 456 });

// 后加入者获取消息历史
bus.subscribe("events:*", (msg) => { /* 接收重放的消息 */ });

// 异步：等待单条消息
const { message } = await bus.once("shutdown");

// 异步迭代器
for await (const { message, topic } of bus.listen("events:*")) {
  await processEvent(message);
}

// 清理
const unsub = bus.subscribe("topic", fn);
unsub();  // 移除此订阅
bus.clear();  // 移除所有订阅和历史
```

## 缓存（`malia.cache`）

带 TTL 的 LRU 缓存、基于大小的驱逐，以及每个生产应用都需要的缓存旁路模式。
替代 `lru-cache`（每周 1 亿下载）。

```javascript
// 基本缓存
const cache = malia.cache({ max: 1000, ttl: 60000 });
cache.set("user:123", userData);
const user = cache.get("user:123");  // 命中

// 缓存旁路：未命中时获取，命中时从缓存返回
const user = await cache.getOrSet("user:123", async () => {
  return await db.query("SELECT * FROM users WHERE id = 123");
}, { ttl: 30000 });

// 图片/Buffer 缓存，按字节大小限制
const images = malia.cache({
  max: 500,
  maxSize: 50 * 1024 * 1024,  // 50 MB
  sizeOf: (buf) => buf.length,
});
const avatar = await images.getOrSet("avatar:" + id, async () => {
  return Buffer.from(await (await fetch(url)).arrayBuffer());
});

// 记忆化任意异步函数
const getUser = malia.cache.memoize(
  async (id) => await db.getUser(id),
  { max: 500, ttl: 60000 }
);
const user = await getUser(123);  // 首次调用后被缓存

// 自动去重：20 个并发调用同一 key = 仅 1 次计算
const results = await Promise.all(
  userIds.map(id => cache.getOrSet("user:" + id, () => db.getUser(id)))
);
```

功能：LRU 驱逐、按 key 的 TTL、`staleWhileRevalidate`、`onEvict` 回调、
`purge()`、`stats()`（命中、未命中、命中率）、批量操作（`setMany`、`getMany`、
`deleteMany`）、迭代、`forEach`。

## 可替代的 npm 包

以下功能已内置。下载量数据来自 npm，用于说明需求的普遍程度。

| npm 包 | 每周下载量 | Malia 内置替代 |
|---|---|---|
| `dotenv` | 1.6 亿 | 启动时自动加载 `.env` |
| `p-limit` / `p-map` | 2 亿+ | `malia.parallel.map(items, fn, {concurrency})` |
| `p-retry` | 3000 万 | `malia.retry(fn, {attempts, backoff})` |
| `p-timeout` | 3000 万 | `malia.timeout(promise, ms)` |
| `async-mutex` | 500 万 | `malia.mutex()` / `malia.semaphore(n)` |
| `lodash.debounce` | 1500 万 | `malia.debounce(fn, ms)` |
| `lodash.throttle` | 1000 万 | `malia.throttle(fn, ms)` |
| `node-cron` | 400 万 | `malia.cron("*/5 * * * *", fn)` |
| `helmet` | 600 万 | `jse.secure(handler)` |
| `express-rate-limit` | 300 万 | `jse.rateLimit(handler, {max})` |
| `cors` | 1400 万 | `jse.cors(handler, {origin})` |
| `lru-cache` | 1 亿 | `malia.cache({ max, ttl })` |
| `node-cache` | 500 万 | `malia.cache({ max, ttl })` |
| `http-server` / `serve` | 500 万 | `malia serve .` |
| `pm2` / `forever` | 500 万 | `malia deploy systemd` + cluster |
| `snyk` / `npm audit` | - | `malia scan` + `malia secrets` + `malia audit` |
| `dotenv-vault` | 100 万 | `malia env-encrypt` |
| `knex migrate` | 200 万 | `malia migrate` |
| `ioredis` / `redis` | 1300 万 | `malia.redis()` |
| `@aws-sdk/client-s3` | 1000 万 | `malia.s3({ bucket })` |
| `zx` / `execa` / `shelljs` | 3000 万+ | ``malia.$`cmd` `` |
| `js-yaml` | 7000 万 | `malia.yaml.parse()` / `stringify()` |
| `prettier` | 6000 万 | `malia fmt` |
| `eslint` | 5000 万 | `malia lint` |
| `esbuild` / `webpack` | 4000 万+ | `malia bundle` |

## Node 内置模块

| 模块 | 已实现 |
|---|---|
| `assert`、`assert/strict` | `ok`、`equal`、`strictEqual`、`deepEqual`、`deepStrictEqual`（支持 Map/Set/Date/RegExp/类型化数组）、`match`、`doesNotMatch`、`ifError`、`throws`/`rejects` 支持 class、RegExp、对象或函数验证、`strict` |
| `async_hooks` | `AsyncLocalStorage`（上下文通过 V8 的 continuation-preserved `AsyncVariable` 在 `await` 间传播）、`AsyncResource` 支持 `runInAsyncScope` 和 `bind` |
| `buffer` | `Buffer` 基于 `Uint8Array`，4 KB 及以下的分配来自共享的 8 KB 池（与 Node 相同）。编码：utf8、base64、hex、latin1、utf16le、ascii |
| `child_process` | `spawn`、`exec`、`execFile`、其 `*Sync` 形式、带 IPC 的 `fork` |
| `cluster` | `isPrimary`、`isWorker`、`fork`、生命周期事件、IPC。Worker 通过 `SO_REUSEPORT` 共享端口 |
| `console` | `log`、`info`、`warn`、`error`、`debug`、`trace`、`assert`、`time`、`timeEnd`、`timeLog`、`count`、`countReset`、`table`、`dir`、`group`、`groupEnd`、`groupCollapsed`、`clear` |
| `crypto` | `createHash` 和 `hash`（md5、sha1、sha224、sha256、sha384、sha512、sha512-256；`copy()`）、`createHmac`、`randomBytes`、`randomInt`、`randomUUID`、`timingSafeEqual`、`pbkdf2`、`scrypt`、`hkdf`、`hkdfSync`；密码算法 `aes-{128,192,256}-{cbc,ctr}`、`aes-{128,256}-gcm`、`chacha20-poly1305`；`KeyObject`、`createPrivateKey`/`createPublicKey`/`createSecretKey`（PEM、DER、JWK；PKCS#1、PKCS#8、SEC1、SPKI）、`generateKeyPair(Sync)` 支持 RSA、EC（P-256/384/521）、Ed25519；`sign`/`verify`、`createSign`/`createVerify`（RSA PKCS#1 v1.5 和 PSS、ECDSA DER 或 IEEE P1363、Ed25519）；`publicEncrypt`/`privateDecrypt`（OAEP、PKCS#1 v1.5）；`createECDH`（P-256、P-384、P-521、X25519）、`diffieHellman`；`X509Certificate`；`webcrypto` |
| `diagnostics_channel` | `channel`、`subscribe`、`unsubscribe`、`hasSubscribers`、`tracingChannel`（`traceSync`、`tracePromise`、`traceCallback`） |
| `dgram` | UDP 套接字：`createSocket`、`bind`、`send`、`close`、消息事件、发送时自动绑定 |
| `dns`、`dns/promises` | `lookup`、`lookupService`、`resolve4`、`resolve6`、`resolveTxt`、`resolveSrv`、`resolveMx`、`resolveNs`、`resolveCname`、`resolvePtr`、`reverse` |
| `domain` | `create`、`Domain` |
| `events` | `EventEmitter`、`once`、`on`（带 `AbortSignal` 的异步迭代器）、`getEventListeners`、`removeAllListeners`（触发 `removeListener`）、`prependListener`、`prependOnceListener`、`defaultMaxListeners`、`captureRejections`、`errorMonitor`、`setMaxListeners`（静态）、`addAbortListener` |
| `fs`、`fs/promises` | 同步、回调和 Promise API，具有 Node 的错误格式（`code`、`errno`、`syscall`、`path`）：带 `flag`、`mode` 和编码的读写、`stat`（`throwIfNoEntry`）、`readdir`（`recursive`、`withFileTypes`）、`mkdir`、`rm`、`cp`、`copyFile`（`COPYFILE_EXCL`）、`rename`、`link`、`symlink`、`utimes`、`opendir`、文件描述符、`FileHandle`、流、`watch`（通过 notify 使用原生 inotify/kqueue/FSEvents，回退到轮询）、`watchFile`、`glob`/`globSync`（Node 22） |
| `http`、`https` | `createServer`（带选项）、`request`、`get`、`IncomingMessage`（异步可迭代体、`close` 事件）、`ServerResponse`（`_implicitHeader`、`headersSent`、CRLF 验证的 `setHeader`）、`Agent`（`keepAlive` 连接池、`maxFreeSockets`）、`globalAgent`、`STATUS_CODES`、`METHODS`、`validateHeaderName`/`validateHeaderValue`。服务器与 `jse.serve` 共享 hyper 引擎；客户端响应为 `Readable` 流；大于 `maxBodyBytes` 的请求体通过通道流式传输 |
| `http2` | 服务端和客户端；ALPN `h2` 和明文 `h2c`（先验知识） |
| `inspector` | `Session`（通过 WebSocket 连接到运行中的 V8 inspector）、`open`、`close`、`url`。参见[调试](#调试) |
| `module` | `createRequire`、`builtinModules`、`isBuiltin`、`Module`、`Module._resolveFilename`、`Module._load`、`Module._cache`、`Module._nodeModulePaths` |
| `net`、`tls` | TCP、Unix 域套接字和 Windows 命名管道；rustls TLS 客户端。TLS 服务端、套接字升级和未实现的安全选项会显式拒绝；参见兼容性矩阵。 |
| `os` | `cpus`（真实品牌/频率/时间）、`loadavg`、`uptime`、`totalmem`、`freemem`、`networkInterfaces`（MAC 地址）、`userInfo`、`hostname`、`platform`、`arch`、`type`、`release`、`version`、`machine`、`availableParallelism`、`tmpdir`、`homedir`、`endianness`。在容器内报告 cgroup 限制 |
| `path` | Node 实现的移植；`posix` 和 `win32`，以平台变体为默认 |
| `perf_hooks` | `performance.mark`、`performance.measure`、`performance.getEntries`、`PerformanceObserver`（在条目上触发回调）、`monitorEventLoopDelay` |
| `process` | `argv`、`env`（修改传播到子进程）、`cwd`、`chdir`、`nextTick`、`hrtime`、`hrtime.bigint`、`memoryUsage`、`cpuUsage`、`kill`、`exit`、`abort`、`mainModule`、`stdin`（可读流）、`stdout`/`stderr`（带 EPIPE 处理的可写流）、`uncaughtException`/`unhandledRejection`/`SIGTERM`/`SIGINT` 事件、`emitWarning`、`umask`、`report`、`getBuiltinModule`、`allowedNodeEnvironmentFlags`、`features`、`config`、`release`。CJS 模块有 `module.id`、`module.filename`、`module.loaded` 和 `require.cache`（删除可强制重新加载） |
| `punycode`、`querystring`、`readline`、`string_decoder`、`timers`、`tty`、`constants` | 可用 |
| `sqlite` | `DatabaseSync`、`StatementSync`（Node 22 API） |
| `stream`、`stream/promises`、`stream/consumers`、`stream/web` | Node 的流实现（readable-stream 4）：`Readable`、`Writable`、`Duplex`、`Transform`、`PassThrough`、`pipeline`、`finished`、`compose`、背压、`toWeb`/`fromWeb`；consumers；WHATWG 流 |
| `test` | `test`、`describe`、`it`、`before`/`after`/`beforeEach`/`afterEach`、`mock.fn`/`mock.method`/`mock.reset`、TAP 输出 |
| `url` | `URL`、`URLSearchParams`、`fileURLToPath`、`pathToFileURL` |
| `util`、`util/types` | `format`、`inspect`、`promisify`、`callbackify`、`inherits`、`deprecate`、`isDeepStrictEqual`、`parseArgs`、`styleText`、`MIMEType`、`debuglog`、类型谓词 |
| `v8` | `getHeapStatistics`、`serialize`、`deserialize`、`Serializer`、`Deserializer` |
| `vm` | `runInThisContext`、`createContext`/`runInContext`/`runInNewContext` 和 `Script` 在真实 V8 上下文中运行（沙箱属性填充上下文的全局对象；代码定义的全局变量写回）。超时和缓存数据显式拒绝。与 Node 相同，不是安全边界 |
| `wasi` | WASI Preview 1：args、env、clocks、random、stdio、exit |
| `worker_threads` | `Worker`、`isMainThread`、`threadId`、`workerData`、`parentPort`、`MessageChannel`、`BroadcastChannel`（跨线程）、`SHARE_ENV` |
| `ws` | 与 `ws` 包兼容的 `WebSocket` 和 `WebSocketServer` |
| `zlib` | gzip、deflate、raw deflate、Brotli、`unzip`；同步、回调和流形式；CRC-32 |

## 数据库驱动

数据库客户端是普通的 npm 包。`tests/db/drivers.mjs` 对以下每个驱动运行实际服务器
测试；CI 的 `databases` 任务将服务器作为服务容器启动，要求全部通过。

| 数据库 | 包 | 测试内容 |
|---|---|---|
| PostgreSQL 16 | `pg`、`postgres`、`knex`、`drizzle-orm` | SCRAM-SHA-256 认证、参数、`jsonb`、`bytea`、schema builder、ORM 查询 |
| MySQL 8.4 | `mysql2` | `caching_sha2_password` 认证、文本和二进制（预处理）协议、`BLOB` |
| Redis 7 | `ioredis`、`redis` | 命令、管道、发布/订阅、哈希 |
| MongoDB 7 | `mongodb`、`mongoose` | SCRAM-SHA-256 认证、`insertMany`/`find` 支持 BigInt、模型 |
| DynamoDB Local | `@aws-sdk/client-dynamodb` | SigV4 签名、创建/放入/获取/删除 |
| Elasticsearch 8 | `@elastic/elasticsearch` | undici 传输、批量索引、搜索 |
| Cassandra 5 | `cassandra-driver` | 键空间、预处理语句、UUID |
| SQLite | `node:sqlite`、`jse.sql` | 内置，无需原生插件 |

## 框架

我们针对这些框架的特定部分进行测试，而非其全部表面积。如果你在使用 Express 路由
或 React SSR，应该没有问题。如果你深度使用 Next.js ISR 或 Angular Zone.js，
请先测试你的应用。

- **Express 5**：路由、查询解析、中间件、静态文件
- **Fastify 5**：路由注册、通过 `inject()` 进行请求分发
- **React 19**：`renderToString` 服务端渲染
- **Vue 3**：通过 `createSSRApp` + `renderToString` 进行 SSR
- **Svelte 5**：编译器 + 服务端 `render()`
- **Angular**：Signals、DI、rxjs（非 Zone.js 或完整 SSR）
- **Preact**：`preact-render-to-string`
- **Next.js 16**：使用 App Router SSR 的 standalone `next build` 输出

## 容器

- `os.totalmem()`/`os.freemem()` 和默认 Worker 池大小读取 cgroup v1/v2 限制
  （`memory.max`、`memory.limit_in_bytes`、`cpu.max`、`cpu.cfs_quota_us`）。
- 作为 PID 1 时，SIGTERM 和 SIGINT 传递给 `process.on(...)` 处理器和
  `jse.onShutdown` 钩子。没有处理器时进程以 143（SIGTERM）或 130（SIGINT）退出。
- `jse.serve` 和 `node:http` 默认绑定到 `0.0.0.0`。`PORT`、`HOST` 和
  `NODE_ENV` 从环境中读取。

参见仓库根目录的 [Dockerfile](Dockerfile) 和
[docs/HOWTO.md](docs/HOWTO.md#12-container-deployment)。

## 限制

- **原生插件：** 已实现 N-API v1-v9（149 个函数）。大多数使用 `node-addon-api`
  或原生 N-API 的插件应可工作。使用不太常见的 N-API 函数（例如
  `napi_add_finalizer` 边缘情况、带最大队列大小的
  `napi_create_threadsafe_function`）的复杂插件可能会遇到缺口。如果你发现了，
  请提交 issue。
- `Blob` 内容保存在内存中（与 Node 相同）。
- 加密：不支持加密（密码保护）的 PEM 导入/导出，RSA 密钥生成仅支持
  2048/3072/4096/8192 位且指数为 65537，RSA-PSS 盐长度必须等于摘要长度。
- Windows：`node:cluster` Worker 无法共享端口（依赖 `SO_REUSEPORT`），`chmod`
  仅切换只读属性。
- HTTP 服务器中小于 `maxBodyBytes`（默认 10 MB）的请求体收集在内存中；较大的
  请求体通过通道流式传输。`node:http` 客户端支持
  `http.Agent({ keepAlive: true })` 进行连接池。
- 小 Buffer 共享 8 KB slab，因此 `buf.buffer.byteLength` 可能大于 `buf.length`
  （与 Node 相同）。
- 独立可执行文件不进行类型检查；TypeScript 仅转译。

## 开发

```sh
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
```

集成测试在 `tests/integration.rs` 中，测试固件在 `tests/fixtures/` 中。
`tests/cli.rs` 在临时目录中运行 CLI 命令和标志。数据库驱动测试套件需要实际运行
的服务器：

```sh
npm ci --prefix tests/db
JSE_PG_URL=postgres://postgres:secret@127.0.0.1:5432/postgres \
  ./target/debug/jse run --allow-all tests/db/drivers.mjs   # 为每个服务器设置 JSE_* 变量
```

每个服务器的变量列在 `tests/db/drivers.mjs` 文件顶部。

发布构建使用 `opt-level = 3`、fat LTO、`codegen-units = 1` 和剥离符号。
`panic = "unwind"` 保留是因为 V8 和 `deno_core` 在 JS/Rust 边界使用 `catch_unwind`。
`src/` 下的代码不包含 `unsafe` 块；`unsafe` 仅存在于依赖项（`v8`、`deno_core`、`swc`）中。

### 项目结构

```
build.rs          启动快照构建（JsRuntimeForSnapshot 使用 src/ops.rs）
src/main.rs       CLI 和进程级 tokio 运行时
src/lib.rs        库根
src/runtime.rs    JsRuntime 设置（快照、扩展）、驱动器、REPL
src/loader.rs     模块解析（ESM/TS/CJS/npm/JSON）、CJS 包装、V8 代码缓存
src/ts.rs         deno_ast (SWC) 转译和磁盘缓存
src/cache.rs      磁盘缓存辅助工具
src/config.rs     项目配置加载
src/ops.rs        ops：定时器、文件系统、进程、通道、Worker、文本、加密、URL、fetch、HTTP
src/ops_extra.rs  网络、TLS 客户端、zlib、DNS、OS、HMAC、UDP、fs.watch、子进程 stdio（从 ops.rs 包含）
src/pkg.rs        内置 npm 兼容包管理器（安装、发布、审计、SBOM）
src/crypto.rs     非对称密钥、ECDH/X25519、签名、RSA、AES-CBC/CTR
src/serve.rs      jse.serve 和 node:http 的 hyper 服务器
src/inspector_server.rs  V8 inspector WebSocket 服务器（--inspect / --inspect-brk）
src/logger.rs     结构化日志和 HTTP 访问日志
src/panic.rs      panic 钩子和每连接 panic 隔离
src/snapshot.rs   include_bytes! 启动快照
src/worker.rs     Worker 线程宿主
src/js/           引导全局变量，构建到启动快照中
src/js/node/      node: 内置模块
src/js/internal/  CJS 包装辅助工具
examples/         示例程序
tests/            集成测试和测试固件
```
