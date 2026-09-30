// Regressions for core-module behavior checked against Node: Buffer
// encodings and integer I/O, path.win32, util.inspect/format, events, and
// assert deep equality.
import assert from "node:assert";
import path from "node:path";
import util from "node:util";
import { EventEmitter, once } from "node:events";

const eq = assert.strictEqual;

// ---- Buffer -------------------------------------------------------------------
eq(Buffer.from("hello?>").toString("base64url"), "aGVsbG8_Pg");
eq(Buffer.from("aGVsbG8_Pg", "base64url").toString(), "hello?>");
eq(Buffer.from("zz11", "hex").length, 0);
eq(Buffer.alloc(5).fill("ab").toString(), "ababa");
eq(Buffer.alloc(4, "xy").toString(), "xyxy");
eq(Buffer.from([1, 2, 3]).readUIntBE(0, 3), 0x010203);
eq(Buffer.from([0xff, 0xff, 0xff]).readIntLE(0, 3), -1);
eq(Buffer.from([0x81]).readInt8(0), -127);
assert.throws(() => Buffer.alloc(1).writeInt8(200), { code: "ERR_OUT_OF_RANGE" });
assert.throws(() => Buffer.alloc(2).readUInt32LE(0), { code: "ERR_BUFFER_OUT_OF_BOUNDS" });
const w = Buffer.alloc(8);
w.writeDoubleBE(1.5);
eq(w.toString("hex"), "3ff8000000000000");
eq(w.readDoubleBE(0), 1.5);
eq(util.inspect(Buffer.from("hi")), "<Buffer 68 69>");
assert.throws(() => atob("###"), { name: "InvalidCharacterError", code: 5 });
assert.throws(() => btoa("€"), { name: "InvalidCharacterError" });

// ---- path.win32 -----------------------------------------------------------------
eq(path.win32.join("C:\\a", "..\\b"), "C:\\b");
eq(path.win32.parse("C:\\a\\b.txt").root, "C:\\");
eq(path.win32.isAbsolute("C:\\x"), true);
eq(path.posix.join("/a/b", "../c", "./d/"), "/a/c/d/");

// ---- util -------------------------------------------------------------------------
eq(util.format("%d %s", 1.5, "x"), "1.5 x");
eq(util.inspect({ a: { b: { c: { d: 1 } } } }), "{ a: { b: { c: [Object] } } }");
eq(util.inspect(new (class Foo { constructor() { this.x = 1; } })()), "Foo { x: 1 }");
eq(util.inspect("it's"), `"it's"`);
eq(util.inspect(["a"]), "[ 'a' ]");
const circular = { a: 1 };
circular.self = circular;
eq(util.inspect(circular), "<ref *1> { a: 1, self: [Circular *1] }");
eq(util.inspect(Promise.resolve(2)), "Promise { 2 }");

// ---- events -----------------------------------------------------------------------
assert.throws(() => new EventEmitter().emit("error", "boom"), { code: "ERR_UNHANDLED_ERROR" });
{
  const e = new EventEmitter();
  setTimeout(() => e.emit("v", 1, 2), 1);
  assert.deepStrictEqual(await once(e, "v"), [1, 2]);
  eq(e.listenerCount("error"), 0);
}
{
  const e = new EventEmitter();
  const added = [];
  e.on("newListener", (name) => added.push(name));
  e.on("x", () => {});
  assert.deepStrictEqual(added, ["x"]);
  e.once("y", () => {});
  eq(e.rawListeners("y")[0].listener !== undefined, true);
}

// ---- assert -------------------------------------------------------------------------
assert.throws(() => assert.deepStrictEqual(new Map([[1, 2]]), new Map()), { code: "ERR_ASSERTION" });
assert.throws(() => assert.deepStrictEqual(new Set([1]), new Set([2])), { code: "ERR_ASSERTION" });
assert.throws(() => assert.deepStrictEqual(new Date(0), new Date(1)), { code: "ERR_ASSERTION" });
assert.throws(() => assert.strict.equal(1, "1"), { code: "ERR_ASSERTION" });
assert.throws(() => assert.throws(() => { throw new RangeError("x"); }, TypeError), { code: "ERR_ASSERTION" });
assert.deepStrictEqual(new Set([{ a: 1 }, { b: 2 }]), new Set([{ b: 2 }, { a: 1 }]));
eq(util.isDeepStrictEqual(new Map([[1, 1]]), new Map()), false);

console.log("node_core_compat: ok");
