// node:crypto fixture: known hash vectors, streaming update, randomBytes,
// timingSafeEqual.
import { createHash, randomBytes, timingSafeEqual, getHashes } from "node:crypto";

function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

assertEq(createHash("sha256").update("abc").digest("hex"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256");
assertEq(createHash("sha1").update("abc").digest("hex"),
  "a9993e364706816aba3e25717850c26c9cd0d89d", "sha1");
assertEq(createHash("md5").update("abc").digest("hex"),
  "900150983cd24fb0d6963f7d28e17f72", "md5");
assertEq(createHash("sha512").update("abc").digest("hex"),
  "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  "sha512");

// Streaming updates equal one-shot.
const h = createHash("sha256");
h.update("a").update("b").update("c");
assertEq(h.digest("hex"), createHash("sha256").update("abc").digest("hex"), "streaming");

// Buffer input + Buffer digest output.
const bufDigest = createHash("md5").update(Buffer.from("abc")).digest();
if (!Buffer.isBuffer(bufDigest) || bufDigest.length !== 16) throw new Error("md5 buffer digest");

// digest() twice throws.
let threw = false;
try {
  bufDigest && createHash("sha1").update("x").digest().length && h.digest();
} catch {
  threw = true;
}
if (!threw) throw new Error("second digest() did not throw");

// randomBytes.
const r1 = randomBytes(32);
const r2 = randomBytes(32);
assertEq(r1.length, 32, "randomBytes length");
if (r1.equals(r2)) throw new Error("randomBytes not random");
if (!Buffer.isBuffer(r1)) throw new Error("randomBytes not a Buffer");

// timingSafeEqual.
if (!timingSafeEqual(Buffer.from("secret"), Buffer.from("secret"))) throw new Error("tse equal");
if (timingSafeEqual(Buffer.from("secret"), Buffer.from("secreu"))) throw new Error("tse inequal");
threw = false;
try {
  timingSafeEqual(Buffer.from("a"), Buffer.from("ab"));
} catch {
  threw = true;
}
if (!threw) throw new Error("tse length mismatch did not throw");

if (!getHashes().includes("sha256")) throw new Error("getHashes");

console.log("CRYPTO: PASS");
