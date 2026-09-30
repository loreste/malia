// Async fs and zlib must leave the event loop free to run timers. WorkerPool
// defaults to os.availableParallelism() and runs jobs on real OS threads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

function assert(cond, what) {
  if (!cond) throw new Error(what);
}

function ticksDuring(work) {
  return new Promise((resolve, reject) => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    const start = performance.now();
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          clearInterval(timer);
          resolve({ ticks, elapsed: performance.now() - start, value });
        },
        (err) => {
          clearInterval(timer);
          reject(err);
        },
      );
  });
}

// A fast disk can finish under 15ms with zero ticks. Only a slow call that
// also froze the loop is a failure.
function assertNotStalled(label, sample) {
  if (sample.elapsed > 15 && sample.ticks === 0) {
    throw new Error(`${label} stalled the event loop for ${sample.elapsed.toFixed(1)}ms`);
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jse-cio-"));
try {
  const sub = path.join(dir, "sub");
  await fs.promises.mkdir(sub, { recursive: true });
  const note = path.join(sub, "n.txt");
  await fs.promises.writeFile(note, "abc");
  await fs.promises.appendFile(note, "d");
  const names = await fs.promises.readdir(sub);
  assert(names.includes("n.txt"), `readdir ${names}`);
  const typed = await new Promise((resolve, reject) => {
    fs.readdir(sub, { withFileTypes: true }, (err, entries) => (err ? reject(err) : resolve(entries)));
  });
  const ent = typed.find((entry) => entry.name === "n.txt");
  assert(ent && ent.isFile(), "dirent");
  const st = await fs.promises.stat(note);
  assert(st.isFile() && st.size === 4, `stat ${st.size}`);
  assert((await fs.promises.lstat(note)).isFile(), "lstat");
  await fs.promises.chmod(note, 0o644);
  await fs.promises.access(note, fs.constants.R_OK);
  const link = path.join(sub, "l");
  await fs.promises.symlink("n.txt", link);
  assert((await fs.promises.readlink(link)) === "n.txt", "readlink");
  assert((await fs.promises.realpath(link)).endsWith("n.txt"), "realpath");
  const copy = path.join(dir, "c.txt");
  await fs.promises.copyFile(note, copy);
  const renamed = path.join(dir, "r.txt");
  await fs.promises.rename(copy, renamed);
  assert((await fs.promises.readFile(renamed, "utf8")) === "abcd", "rename");
  await fs.promises.truncate(renamed, 2);
  assert((await fs.promises.readFile(renamed)).length === 2, "truncate");
  await fs.promises.unlink(link);
  await fs.promises.rm(sub, { recursive: true, force: true });
  const nested = await fs.promises.mkdtemp(path.join(dir, "inner-"));
  await fs.promises.rmdir(nested);

  const file = path.join(dir, "blob.bin");
  const size = 8 * 1024 * 1024;
  const blob = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) blob[i] = i & 255;
  fs.writeFileSync(file, blob);

  const read = await ticksDuring(() => fs.promises.readFile(file));
  assert(read.value.length === size, `read length ${read.value.length}`);
  assert(read.value[0] === blob[0] && read.value[4096] === blob[4096], "read bytes");
  assertNotStalled("readFile", read);

  const streamed = await ticksDuring(() => collect(fs.createReadStream(file)));
  assert(streamed.value.length === size, `stream length ${streamed.value.length}`);
  assert(streamed.value[4096] === blob[4096] && streamed.value[size - 1] === blob[size - 1], "stream bytes");
  assertNotStalled("createReadStream", streamed);

  const outPath = path.join(dir, "out.bin");
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outPath);
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.write(blob.subarray(0, 3));
    stream.end(blob.subarray(3, 6));
  });
  assert((await fs.promises.readFile(outPath)).equals(blob.subarray(0, 6)), "write stream");

  const payload = Buffer.alloc(1024 * 1024);
  crypto.randomFillSync(payload);
  const gz = await ticksDuring(
    () =>
      new Promise((resolve, reject) => {
        zlib.gzip(payload, (err, out) => (err ? reject(err) : resolve(out)));
      }),
  );
  assertNotStalled("gzip", gz);
  assert(zlib.gunzipSync(gz.value).equals(payload), "gzip roundtrip");
  const gzPromise = await zlib.gzip(Buffer.from("hi"));
  assert(zlib.gunzipSync(gzPromise).toString() === "hi", "gzip promise");

  const chunks = [];
  await pipeline(
    fs.createReadStream(file, { start: 0, end: 63 }),
    zlib.createGzip(),
    zlib.createGunzip(),
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  );
  const round = Buffer.concat(chunks);
  assert(round.equals(blob.subarray(0, 64)), `gzip stream ${round.length}`);

  const n = os.availableParallelism();
  assert(n >= 1, `availableParallelism ${n}`);
  const workerUrl = import.meta.url.replace(/[^/]*$/, "fib_worker.js");
  const pool = new WorkerPool(workerUrl);
  assert(pool.size === n, `pool size ${pool.size} != ${n}`);
  const [a, b] = await Promise.all([pool.run(10), pool.run(11)]);
  pool.close();
  assert(a === 55 && b === 89, `fib ${a} ${b}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("CONCURRENCY_IO: PASS");
