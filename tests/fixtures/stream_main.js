// node:stream fixture: Readable/Writable/Transform basics, pipe and pipeline.
import { Readable, Writable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

// 1. Readable push + flowing 'data' + 'end'.
{
  const r = new Readable();
  r.push("a");
  r.push("b");
  r.push(null);
  const chunks = [];
  let ended = false;
  r.on("data", (c) => chunks.push(c));
  await new Promise((resolve) => r.on("end", () => { ended = true; resolve(); }));
  assertEq(chunks.join(""), "ab", "readable data");
  if (!ended) throw new Error("readable end not emitted");
}

// 2. Readable with _read pulling.
{
  let n = 0;
  const r = new Readable({
    read() {
      n += 1;
      this.push(n <= 3 ? `x${n}` : null);
    },
  });
  let out = "";
  for await (const chunk of r) out += chunk;
  assertEq(out, "x1x2x3", "readable _read + asyncIterator");
}

// 3. Writable write/end/finish.
{
  const written = [];
  const w = new Writable({
    write(chunk, encoding, cb) {
      written.push(chunk);
      cb();
    },
  });
  w.write("one");
  w.write("two");
  await new Promise((resolve) => w.end(resolve));
  assertEq(written.join(","), "one,two", "writable writes");
  if (!w.writableFinished) throw new Error("writableFinished");
}

// 4. pipe through a Transform.
{
  const upper = new Transform({
    transform(chunk, encoding, cb) {
      cb(null, String(chunk).toUpperCase());
    },
  });
  const src = Readable.from(["foo", "bar"]);
  const collected = [];
  const sink = new Writable({
    write(chunk, encoding, cb) {
      collected.push(chunk);
      cb();
    },
  });
  src.pipe(upper).pipe(sink);
  await new Promise((resolve, reject) => {
    sink.on("finish", resolve);
    sink.on("error", reject);
    upper.on("error", reject);
  });
  assertEq(collected.join(""), "FOOBAR", "pipe through transform");
}

// 5. pipeline() as a promise + error propagation.
{
  const src = Readable.from([1, 2, 3]);
  const double = new Transform({
    objectMode: true,
    transform(chunk, encoding, cb) {
      cb(null, chunk * 2);
    },
  });
  const out = [];
  const sink = new Writable({
    objectMode: true,
    write(chunk, encoding, cb) {
      out.push(chunk);
      cb();
    },
  });
  await pipeline(src, double, sink);
  assertEq(out.join(","), "2,4,6", "pipeline");

  const boom = new Transform({
    transform(chunk, encoding, cb) {
      cb(new Error("boom"));
    },
  });
  let failed = null;
  try {
    await pipeline(Readable.from(["x"]), boom, new Writable({ write(c, e, cb2) { cb2(); } }));
  } catch (err) {
    failed = err;
  }
  assertEq(failed?.message, "boom", "pipeline error propagation");
}

console.log("STREAM: PASS");
