"use strict";
// Destroying a compression stream while its final flush is in flight (a client
// that leaves while a gzip response finishes) must not crash the process.
const assert = require("assert");
const zlib = require("zlib");

(async () => {
  for (const make of [zlib.createGzip, zlib.createDeflate, zlib.createBrotliCompress]) {
    const s = make();
    s.on("error", () => {});
    s.on("data", () => {});
    s.write("x".repeat(10000));
    s.end();
    setImmediate(() => s.destroy());
    await new Promise((r) => setTimeout(r, 50));
    const t = make();
    t.on("error", () => {});
    t.destroy();
    t.write("late");
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(true);
  console.log("ok");
})();
