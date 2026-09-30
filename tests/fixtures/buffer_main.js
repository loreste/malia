// Buffer fixture: view semantics, from(arraybuffer, offset, length), encodings.
function assertEq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// subarray/slice return live Buffer views.
const b = Buffer.from("hello world");
const sub = b.subarray(0, 5);
if (!Buffer.isBuffer(sub)) throw new Error("subarray not a Buffer");
sub[0] = 72; // 'H'
assertEq(b.toString(), "Hello world", "subarray shares memory");
const sl = b.slice(6);
if (!Buffer.isBuffer(sl)) throw new Error("slice not a Buffer");
assertEq(sl.toString(), "world", "slice view");

// from(arraybuffer, offset, length).
const ab = new ArrayBuffer(8);
const view = new Uint8Array(ab);
view.set([10, 20, 30, 40, 50, 60, 70, 80]);
const b2 = Buffer.from(ab, 2, 3);
assertEq([...b2], [30, 40, 50], "from(ab, off, len)");
b2[0] = 99;
assertEq(view[2], 99, "from(ab) shares memory");

// Encodings round-trip.
assertEq(Buffer.from("aGVsbG8=", "base64").toString(), "hello", "from base64");
assertEq(Buffer.from("68656c6c6f", "hex").toString(), "hello", "from hex");
assertEq(Buffer.from("héllo").toString("base64"), Buffer.from("héllo", "utf8").toString("base64"), "utf8 base64");
assertEq(Buffer.from("café", "latin1").toString("latin1"), "café", "latin1");
if (!Buffer.isEncoding("hex") || Buffer.isEncoding("rot13")) throw new Error("isEncoding");

// concat.
const c = Buffer.concat([Buffer.from("ab"), Buffer.from("cd"), new Uint8Array([101])]);
assertEq(c.toString(), "abcde", "concat");
assertEq(Buffer.concat([Buffer.from("abcd")], 2).toString(), "ab", "concat with length");

// write + byteLength.
const w = Buffer.alloc(8);
const n = w.write("hi");
assertEq(n, 2, "write return");
assertEq(w.subarray(0, 2).toString(), "hi", "write content");
assertEq(Buffer.byteLength("é"), 2, "byteLength utf8");

console.log("BUFFER: PASS");
