// Node-compat slice: fs, net, http(s) client, zlib, dns, crypto, os, tty,
// streams, child_process stdio, worker_threads, module, process, Buffer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import dns from "node:dns";
import { lookup } from "node:dns/promises";
import crypto from "node:crypto";
import tty from "node:tty";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire, isBuiltin } from "node:module";
import { Worker, isMainThread, threadId, MessageChannel, MessagePort, BroadcastChannel, SHARE_ENV } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function assert(cond, what) {
  if (!cond) throw new Error(what);
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function finishWrite(stream, text) {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(text);
  });
}

const marker = path.join(os.tmpdir(), "jse-node-compat-before-exit");
try { fs.unlinkSync(marker); } catch { /* absent */ }
process.on("beforeExit", () => {
  fs.writeFileSync(marker, "ok");
});



// process
let saw = false;
process.on("test-evt", () => { saw = true; });
process.emit("test-evt");
assert(saw, "process.on/emit");
assert(process.pid > 0, `pid ${process.pid}`);
assert(process.ppid > 0, `ppid ${process.ppid}`);
assert(typeof process.hrtime.bigint() === "bigint", "hrtime.bigint");
assert(process.versions.node === "26.0.0", `versions.node ${process.versions.node}`);
assert(process.uptime() >= 0, "uptime");
const mem = process.memoryUsage();
assert(mem.heapUsed > 0, `heapUsed ${mem.heapUsed}`);
assert(mem.rss > 0, `rss ${mem.rss}`);
assert(typeof process.stdout.isTTY === "boolean", "stdout.isTTY");
assert(typeof process.stderr.isTTY === "boolean", "stderr.isTTY");
assert(global === globalThis, "global");

// Buffer
assert(Buffer.isEncoding("ascii") && Buffer.isEncoding("utf16le"), "isEncoding");
assert(Buffer.from("ABC", "ascii").toString("hex") === "414243", "ascii");
assert(Buffer.from("hi", "utf16le").toString("utf16le") === "hi", "utf16le");
const hay = Buffer.from("abcabc");
assert(hay.indexOf("bc") === 1, "indexOf");
assert(hay.lastIndexOf("bc") === 4, "lastIndexOf");
assert(hay.includes("ca"), "includes");
const copied = Buffer.alloc(4);
assert(hay.copy(copied, 1, 0, 2) === 2, "copy length");
assert(copied.toString() === "\0ab\0", "copy bytes");
assert(Buffer.compare(Buffer.from("a"), Buffer.from("b")) === -1, "compare");
const swapped = Buffer.from([0x01, 0x02, 0x03, 0x04]);
swapped.swap16();
assert([...swapped].join(",") === "2,1,4,3", "swap16");
swapped.swap32();
assert([...swapped].join(",") === "3,4,1,2", "swap32");
const nums = Buffer.alloc(4);
assert(nums.writeUInt32LE(0x04030201) === 4, "writeUInt32LE");
assert(nums.readUInt32LE() === 0x04030201, "readUInt32LE");
assert(nums.readUInt16BE(2) === 0x0304, "readUInt16BE");

// events
assert(EventEmitter.defaultMaxListeners === 10, "defaultMaxListeners");
const ee = new EventEmitter();
const order = [];
ee.prependOnceListener("e", () => order.push("pre"));
ee.on("e", () => order.push("on"));
ee.emit("e");
ee.emit("e");
assert(order.join(",") === "pre,on,on", `prependOnce ${order}`);

// os / tty
assert(os.totalmem() > 0, "totalmem");
assert(os.freemem() > 0, "freemem");
assert(os.hostname().length > 0, "hostname");
assert(os.type().length > 0, "os.type");
assert(os.devNull === "/dev/null", "devNull");
assert(os.endianness() === "LE" || os.endianness() === "BE", "endianness");
const cpu = os.cpus()[0];
assert(cpu && cpu.times && typeof cpu.times.idle === "number", "cpus.times");
assert(typeof os.userInfo().uid === "number", "userInfo");
assert(os.networkInterfaces() && typeof os.networkInterfaces() === "object", "networkInterfaces");
assert(typeof tty.isatty(1) === "boolean", "isatty");

// crypto
const key = Buffer.alloc(20, 0x0b);
const mac = crypto.createHmac("sha256", key).update("Hi There").digest("hex");
assert(
  mac === "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  `hmac ${mac}`,
);
const uuid = crypto.randomUUID();
assert(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
  `uuid ${uuid}`,
);
const filled = crypto.randomFillSync(Buffer.alloc(16));
assert(filled.length === 16, "randomFillSync");

// zlib
const raw = Buffer.from("hello zlib hello zlib hello zlib");
const gz = zlib.gzipSync(raw);
assert(gz[0] === 0x1f && gz[1] === 0x8b, "gzip magic");
assert(zlib.gunzipSync(gz).equals(raw), "gunzip");
assert(zlib.inflateSync(zlib.deflateSync(raw)).equals(raw), "deflate");
assert(zlib.inflateRawSync(zlib.deflateRawSync(raw)).equals(raw), "deflateRaw");
const emptyGz = zlib.gzipSync(Buffer.alloc(0));
assert(emptyGz[0] === 0x1f && emptyGz[1] === 0x8b, "empty gzip");
const br = zlib.brotliCompressSync(raw);
assert(br.length > 0, "brotliCompressSync length");
assert(zlib.brotliDecompressSync(br).equals(raw), "brotliDecompressSync");
const asyncBr = await new Promise((res, rej) => {
  zlib.brotliCompress(raw, (err, out) => err ? rej(err) : res(out));
});
const asyncDebr = await new Promise((res, rej) => {
  zlib.brotliDecompress(asyncBr, (err, out) => err ? rej(err) : res(out));
});
assert(asyncDebr.equals(raw), "brotli async roundtrip");

// streams
let duplexGot = "";
const duplex = new Duplex({
  read() {
    this.push(Buffer.from("duplex"));
    this.push(null);
  },
  write(chunk, _enc, cb) {
    duplexGot = Buffer.from(chunk).toString();
    cb();
  },
});
const duplexOut = await collect(duplex);
await new Promise((resolve, reject) => {
  duplex.on("error", reject);
  duplex.on("finish", resolve);
  duplex.end("in");
});
assert(duplexOut.toString() === "duplex", `duplex read ${duplexOut}`);
assert(duplexGot === "in", `duplex write ${duplexGot}`);

const passed = [];
await pipeline(
  Readable.from(["ab", "cd"]),
  new PassThrough(),
  new Writable({
    write(chunk, _enc, cb) {
      passed.push(Buffer.from(chunk).toString());
      cb();
    },
  }),
);
assert(passed.join("") === "abcd", `pipeline ${passed}`);

// fs
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jse-fs-"));
try {
  const nested = path.join(dir, "sub", "a");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, "f.txt");
  fs.writeFileSync(file, "hello-fs");
  fs.appendFileSync(file, "!");
  assert(fs.readdirSync(path.join(dir, "sub")).includes("a"), "readdir");
  const ent = fs.readdirSync(path.join(dir, "sub"), { withFileTypes: true }).find((e) => e.name === "a");
  assert(ent && ent.isDirectory(), "dirent");
  const st = fs.statSync(file);
  assert(st.isFile() && st.size === 9, `stat size ${st.size}`);
  const link = path.join(nested, "link");
  fs.symlinkSync("f.txt", link);
  assert(fs.lstatSync(link).isSymbolicLink(), "lstat symlink");
  assert(fs.statSync(link).isFile(), "stat follows symlink");
  assert(fs.readlinkSync(link) === "f.txt", "readlink");
  fs.chmodSync(file, 0o644);
  fs.accessSync(file, fs.constants.R_OK);
  assert(fs.realpathSync(link).endsWith("f.txt"), "realpath");
  const copy = path.join(dir, "copy.txt");
  fs.copyFileSync(file, copy);
  fs.renameSync(copy, path.join(dir, "renamed.txt"));
  assert(fs.readFileSync(path.join(dir, "renamed.txt"), "utf8") === "hello-fs!", "rename");
  const partial = await collect(fs.createReadStream(file, { start: 1, end: 4 }));
  assert(partial.toString() === "ello", `read stream ${partial}`);
  const outPath = path.join(dir, "out.txt");
  await finishWrite(fs.createWriteStream(outPath), "streamed");
  await finishWrite(fs.createWriteStream(outPath, { flags: "a" }), "!");
  assert(await fs.promises.readFile(outPath, "utf8") === "streamed!", "write stream");
  const viaCb = await new Promise((resolve, reject) => {
    fs.readFile(file, "utf8", (err, data) => (err ? reject(err) : resolve(data)));
  });
  assert(viaCb === "hello-fs!", "readFile callback");
  const require = createRequire(import.meta.url);
  const pkgPath = path.join(dir, "pkg.json");
  fs.writeFileSync(pkgPath, JSON.stringify({ name: "jse-pkg", ok: true }));
  const pkg = require(pkgPath);
  assert(pkg.name === "jse-pkg" && pkg.ok === true, "createRequire json");
  assert(isBuiltin("fs") && isBuiltin("node:zlib"), "isBuiltin");
  // File descriptor sync ops
  const fdPath = path.join(dir, "fd_test.txt");
  const fd = fs.openSync(fdPath, "w+");
  assert(typeof fd === "number" && fd >= 0, `openSync fd ${fd}`);
  const written = fs.writeSync(fd, Buffer.from("hello world fd"));
  assert(written === 14, `writeSync bytes ${written}`);
  fs.fsyncSync(fd);
  const fst = fs.fstatSync(fd);
  assert(fst.size === 14, `fstatSync size ${fst.size}`);

  // read back with readSync at position 0
  const readBuf = Buffer.alloc(5);
  const nRead = fs.readSync(fd, readBuf, 0, 5, 0);
  assert(nRead === 5 && readBuf.toString() === "hello", `readSync ${readBuf.toString()}`);

  // ftruncateSync
  fs.ftruncateSync(fd, 5);
  assert(fs.fstatSync(fd).size === 5, "ftruncateSync");
  fs.closeSync(fd);

  // fs.promises.open -> FileHandle
  const fhPath = path.join(dir, "fh_test.txt");
  const fh = await fs.promises.open(fhPath, "w+");
  assert(typeof fh.fd === "number" && fh.fd >= 0, "filehandle fd");
  const { bytesWritten: fhWritten } = await fh.write(Buffer.from("filehandle data"));
  assert(fhWritten === 15, `fh.write ${fhWritten}`);
  await fh.sync();
  const fhStat = await fh.stat();
  assert(fhStat.size === 15, `fh.stat ${fhStat.size}`);
  const fhBuf = Buffer.alloc(4);
  const { bytesRead: fhRead } = await fh.read(fhBuf, 0, 4, 0);
  assert(fhRead === 4 && fhBuf.toString() === "file", `fh.read ${fhBuf.toString()}`);
  await fh.truncate(4);
  assert((await fh.stat()).size === 4, "fh.truncate");
  await fh.close();

  // fs.watchFile & unwatchFile
  const watchFilePath = path.join(dir, "watched_file.txt");
  fs.writeFileSync(watchFilePath, "initial");
  let watchFileNotified = false;
  const wfListener = (curr, prev) => {
    watchFileNotified = true;
  };
  fs.watchFile(watchFilePath, { interval: 50 }, wfListener);
  // Modify file
  await new Promise((r) => setTimeout(r, 60));
  fs.appendFileSync(watchFilePath, " updated");
  await new Promise((r) => setTimeout(r, 150));
  assert(watchFileNotified, "watchFile notification");
  fs.unwatchFile(watchFilePath, wfListener);

  // fs.watch
  const watchedPath = path.join(dir, "watched_dir");
  fs.mkdirSync(watchedPath);
  let watchEvent = null;
  const watcher = fs.watch(watchedPath, { interval: 50 }, (eventType, filename) => {
    watchEvent = { eventType, filename };
  });
  await new Promise((r) => setTimeout(r, 60));
  fs.writeFileSync(path.join(watchedPath, "new_file.txt"), "watch test");
  await new Promise((r) => setTimeout(r, 150));
  assert(watchEvent !== null, "fs.watch event fired");
  watcher.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// dns
const resolved = await lookup("localhost");
assert(
  resolved.address === "127.0.0.1" || resolved.address === "::1",
  `dns ${resolved.address}`,
);
assert(resolved.family === 4 || resolved.family === 6, `dns family ${resolved.family}`);
const dnsCb = await new Promise((resolve, reject) => {
  dns.lookup("localhost", (err, address) => (err ? reject(err) : resolve(address)));
});
assert(dnsCb === "127.0.0.1" || dnsCb === "::1", `dns cb ${dnsCb}`);

const aRecords = await dns.promises.resolve4("localhost");
assert(Array.isArray(aRecords) && aRecords.includes("127.0.0.1"), `dns resolve4: ${JSON.stringify(aRecords)}`);
const aRecordsTtl = await dns.promises.resolve4("localhost", { ttl: true });
assert(Array.isArray(aRecordsTtl) && aRecordsTtl[0].address === "127.0.0.1" && aRecordsTtl[0].ttl > 0, "dns resolve4 ttl");
const aaaaRecords = await dns.promises.resolve6("localhost");
assert(Array.isArray(aaaaRecords) && aaaaRecords.includes("::1"), `dns resolve6: ${JSON.stringify(aaaaRecords)}`);

const srvHttp = await dns.promises.lookupService("127.0.0.1", 80);
assert(srvHttp.hostname === "localhost" && srvHttp.service === "http", `lookupService 80: ${JSON.stringify(srvHttp)}`);
const srvSsh = await dns.promises.lookupService("127.0.0.1", 22);
assert(srvSsh.hostname === "localhost" && srvSsh.service === "ssh", `lookupService 22: ${JSON.stringify(srvSsh)}`);


// net echo
const netServer = net.createServer((sock) => {
  sock.on("data", (chunk) => sock.end(chunk));
});
await new Promise((resolve, reject) => {
  netServer.once("error", reject);
  netServer.listen(0, "127.0.0.1", resolve);
});
const netPort = netServer.address().port;
const echoed = await new Promise((resolve, reject) => {
  const sock = net.connect({ host: "127.0.0.1", port: netPort }, () => sock.write("ping"));
  const chunks = [];
  sock.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  sock.on("end", () => resolve(Buffer.concat(chunks).toString()));
  sock.on("error", reject);
});
assert(echoed === "ping", `net echo ${echoed}`);
netServer.close();

// http client
const httpServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    res.writeHead(201, { "x-echo": body });
    res.end(`pong:${body}`);
  });
});
await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
const httpPort = httpServer.address().port;
const httpBody = await new Promise((resolve, reject) => {
  const req = http.request(
    { hostname: "127.0.0.1", port: httpPort, path: "/hi", method: "POST" },
    (res) => {
      assert(res.statusCode === 201, `http status ${res.statusCode}`);
      assert(res.headers["x-echo"] === "abc", `http header ${res.headers["x-echo"]}`);
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    },
  );
  req.on("error", reject);
  req.end("abc");
});
assert(httpBody === "pong:abc", `http body ${httpBody}`);
httpServer.close();

// https client (self-signed fixture cert)
const here = path.dirname(fileURLToPath(import.meta.url));
const httpsServer = https.createServer(
  { cert: path.join(here, "tls_cert.pem"), key: path.join(here, "tls_key.pem") },
  (_req, res) => res.end("secure"),
);
await new Promise((resolve, reject) => {
  httpsServer.once("error", reject);
  httpsServer.listen(0, "127.0.0.1", resolve);
});
const httpsPort = httpsServer.address().port;
const secure = await new Promise((resolve, reject) => {
  https.get(
    { hostname: "127.0.0.1", port: httpsPort, rejectUnauthorized: false, path: "/" },
    (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    },
  ).on("error", reject);
});
assert(secure === "secure", `https ${secure}`);
httpsServer.close();

// child_process stdio
const quiet = spawn("/bin/echo", ["nope"], { stdio: "ignore" });
assert(quiet.stdout === null && quiet.stderr === null && quiet.stdin === null, "stdio ignore");
await new Promise((resolve) => quiet.on("close", resolve));

const child = spawn("/bin/sh", ["-c", "cat"], { stdio: ["pipe", "pipe", "ignore"] });
assert(child.stderr === null, "stderr ignore");
let closed = false;
const childText = await new Promise((resolve, reject) => {
  const chunks = [];
  child.stdout.on("data", (chunk) => {
    assert(!closed, "stdout data arrived after close");
    chunks.push(Buffer.from(chunk));
  });
  child.stdout.on("end", () => resolve(Buffer.concat(chunks).toString()));
  child.on("close", () => { closed = true; });
  child.on("error", reject);
  child.stdin.end("hello-child");
});
assert(childText === "hello-child", `child stdout ${JSON.stringify(childText)}`);

// worker_threads
assert(isMainThread && threadId === 0, "main thread");
const worker = new Worker(new URL("./wt_worker.js", import.meta.url), { workerData: { n: 7 } });
const msg = await new Promise((resolve, reject) => {
  worker.on("message", resolve);
  worker.on("error", reject);
});
assert(msg && msg.echo && msg.echo.n === 7, `workerData ${JSON.stringify(msg)}`);
worker.terminate();

// MessageChannel & MessagePort
assert(typeof MessageChannel === "function", "MessageChannel function");
assert(typeof MessagePort === "function", "MessagePort function");
assert(typeof SHARE_ENV === "symbol", "SHARE_ENV symbol");
const { port1, port2 } = new MessageChannel();
const mcMsg = await new Promise((resolve) => {
  port2.on("message", resolve);
  port1.postMessage({ hello: "worker_threads" });
});
assert(mcMsg && mcMsg.hello === "worker_threads", `mcMsg ${JSON.stringify(mcMsg)}`);
port1.close();
port2.close();

// BroadcastChannel
assert(typeof BroadcastChannel === "function", "BroadcastChannel function");
const bc1 = new BroadcastChannel("test-channel");
const bc2 = new BroadcastChannel("test-channel");
const bcMsg = await new Promise((resolve) => {
  bc2.on("message", resolve);
  bc1.postMessage({ broadcast: "data" });
});
assert(bcMsg && bcMsg.broadcast === "data", `bcMsg ${JSON.stringify(bcMsg)}`);
bc1.close();
bc2.close();

console.log("NODE_COMPAT: PASS");

