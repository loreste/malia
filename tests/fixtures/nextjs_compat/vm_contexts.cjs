"use strict";
// node:vm contexts as Next.js uses them (evalManifest): code runs with the
// sandbox object as its global; writes land on the sandbox.
const assert = require("assert");
const vm = require("vm");

const ctx = { process: { env: { NEXT_DEPLOYMENT_ID: "d1" } } };
vm.runInNewContext(
  'globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};' +
  'globalThis.__RSC_MANIFEST["/login/page"] = { id: process.env.NEXT_DEPLOYMENT_ID };' +
  'globalThis.__noSelf = typeof self; var topLevel = 2; implicit = 3;',
  ctx,
);
assert.strictEqual(ctx.__RSC_MANIFEST["/login/page"].id, "d1");
assert.strictEqual(ctx.__noSelf, "undefined", "no self global inside a vm context");
assert.strictEqual(ctx.topLevel, 2);
assert.strictEqual(ctx.implicit, 3);
assert.strictEqual(globalThis.__RSC_MANIFEST, undefined, "nothing leaks to the real global");
assert.strictEqual(typeof globalThis.topLevel, "undefined");

// Persistent context across runs; the result value is returned; builtins exist.
const c2 = vm.createContext({ n: 1 });
assert.strictEqual(vm.isContext(c2), true);
assert.strictEqual(vm.runInContext("n += 1; n * 10", c2), 20);
assert.strictEqual(c2.n, 2);
assert.strictEqual(vm.runInContext("JSON.stringify([n, typeof Object])", c2), '[2,"function"]');
const script = new vm.Script("n + 100");
assert.strictEqual(script.runInContext(c2), 102);
assert.strictEqual(script.runInNewContext({ n: 5 }), 105);

// Errors propagate with their type.
assert.throws(() => vm.runInNewContext("throw new RangeError('r')", {}), (e) => e.name === "RangeError" && e.message === "r");
assert.throws(() => vm.runInNewContext("(", {}), (e) => e.name === "SyntaxError");

console.log("VM CONTEXTS: PASS");
