// CJS interop fixture: a CJS module requiring relative CJS, JSON, and
// builtins; imported from ESM with default-export interop.
import cjs, { sum, jsonAnswer, base, filename, dirname, fired } from "./cjs/mod.cjs";
import { add } from "./cjs/other.cjs";

if (cjs.sum !== 3) throw new Error("relative require failed");
if (cjs.jsonAnswer !== 42) throw new Error("json require failed");
if (cjs.base !== "mod.cjs") throw new Error("builtin require failed");
if (typeof cjs.filename !== "string" || !cjs.filename.endsWith("mod.cjs")) {
  throw new Error("__filename failed");
}

// Named imports destructuring verification
if (sum !== 3) throw new Error("named import sum failed: " + sum);
if (jsonAnswer !== 42) throw new Error("named import jsonAnswer failed: " + jsonAnswer);
if (base !== "mod.cjs") throw new Error("named import base failed: " + base);
if (filename !== cjs.filename) throw new Error("named import filename mismatch");
if (dirname !== cjs.dirname) throw new Error("named import dirname mismatch");
if (fired !== 9) throw new Error("named import fired failed: " + fired);
if (add(10, 20) !== 30) throw new Error("named import add failed: " + add(10, 20));

console.log("CJS INTEROP: PASS");
