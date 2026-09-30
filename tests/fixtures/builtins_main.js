// Node builtin shims fixture.
import fs from "node:fs";
import { join, dirname, basename } from "node:path";
import { EventEmitter } from "node:events";
import { Buffer as B } from "node:buffer";
import os from "node:os";
import util from "node:util";
import assert from "node:assert";

if (join("a", "b", "..", "c") !== "a/c") throw new Error("path.join");
if (dirname("/x/y/z.txt") !== "/x/y") throw new Error("path.dirname");
if (basename("/x/y/z.txt", ".txt") !== "z") throw new Error("path.basename");

const tmp = join(os.tmpdir(), "jse_builtins_test.txt");
fs.writeFileSync(tmp, "hello fs");
if (fs.readFileSync(tmp, "utf8") !== "hello fs") throw new Error("fs sync");
const bytes = fs.readFileSync(tmp);
if (!B.isBuffer(bytes) || bytes.toString("utf8") !== "hello fs") throw new Error("fs buffer");
await fs.promises.writeFile(tmp, "async fs");
if ((await fs.promises.readFile(tmp, "utf8")) !== "async fs") throw new Error("fs promises");

const ee = new EventEmitter();
let n = 0;
ee.once("tick", () => n++);
ee.emit("tick");
ee.emit("tick");
if (n !== 1) throw new Error("EventEmitter.once");

if (B.from("jse", "utf8").toString("base64") !== "anNl") throw new Error("Buffer base64");
if (B.from("anNl", "base64").toString("utf8") !== "jse") throw new Error("Buffer b64 decode");
if (util.format("%s=%d", "x", 42) !== "x=42") throw new Error("util.format");

assert.strictEqual(1, 1);
assert.deepStrictEqual({ a: [1] }, { a: [1] });

process.nextTick(() => console.log("nextTick ran"));
console.log("BUILTINS: PASS");
