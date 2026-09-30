// Tests for Node.js compatibility improvements:
// 1. process.stdin is a readable stream with .on("data") support
// 2. process.stdout/stderr have writable stream methods
// 3. process.cpuUsage() returns real values
// 4. console.table works
// 5. console.count/countReset work
// 6. console.timeLog works
// 7. Error.captureStackTrace exists (V8 native)

import assert from "node:assert";

// ---- process.stdin is a readable stream ----
{
  assert.ok(process.stdin, "process.stdin must exist");
  assert.strictEqual(typeof process.stdin.on, "function", "stdin.on must be a function");
  assert.strictEqual(typeof process.stdin.resume, "function", "stdin.resume must be a function");
  assert.strictEqual(typeof process.stdin.pause, "function", "stdin.pause must be a function");
  assert.strictEqual(typeof process.stdin.pipe, "function", "stdin.pipe must be a function");
  assert.strictEqual(typeof process.stdin.destroy, "function", "stdin.destroy must be a function");
  assert.strictEqual(process.stdin.fd, 0, "stdin.fd must be 0");
  assert.strictEqual(process.stdin.readable, true, "stdin.readable must be true");
}
console.log("PASS: process.stdin is a readable stream");

// ---- process.stdout/stderr have writable stream methods ----
{
  for (const name of ["stdout", "stderr"]) {
    const s = process[name];
    assert.ok(s, `process.${name} must exist`);
    assert.strictEqual(typeof s.write, "function", `${name}.write`);
    assert.strictEqual(typeof s.end, "function", `${name}.end`);
    assert.strictEqual(typeof s.on, "function", `${name}.on`);
    assert.strictEqual(typeof s.once, "function", `${name}.once`);
    assert.strictEqual(typeof s.emit, "function", `${name}.emit`);
    assert.strictEqual(s.writable, true, `${name}.writable`);
  }
}
console.log("PASS: process.stdout/stderr are writable streams");

// ---- process.cpuUsage() ----
{
  const usage = process.cpuUsage();
  assert.ok(typeof usage.user === "number", "cpuUsage.user must be a number");
  assert.ok(typeof usage.system === "number", "cpuUsage.system must be a number");
  assert.ok(usage.user >= 0, "cpuUsage.user must be non-negative");

  // Relative usage
  const prev = process.cpuUsage();
  // Do some work
  let sum = 0;
  for (let i = 0; i < 1000000; i++) sum += i;
  const diff = process.cpuUsage(prev);
  assert.ok(diff.user >= 0, "relative cpuUsage.user must be non-negative");
}
console.log("PASS: process.cpuUsage()");

// ---- console.table ----
{
  // Should not throw
  console.table([{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]);
  console.table({ a: 1, b: 2 });
  console.table([1, 2, 3]);
}
console.log("PASS: console.table");

// ---- console.count/countReset ----
{
  // Should not throw
  console.count("test");
  console.count("test");
  console.countReset("test");
  console.count("test"); // should be 1 again
}
console.log("PASS: console.count/countReset");

// ---- console.timeLog ----
{
  console.time("benchmark");
  let sum = 0;
  for (let i = 0; i < 100000; i++) sum += i;
  console.timeLog("benchmark", "halfway");
  console.timeEnd("benchmark");
}
console.log("PASS: console.timeLog");

// ---- Error.captureStackTrace ----
{
  assert.strictEqual(typeof Error.captureStackTrace, "function",
    "Error.captureStackTrace must exist (V8 native)");

  class CustomError extends Error {
    constructor(message) {
      super(message);
      this.name = "CustomError";
      Error.captureStackTrace(this, CustomError);
    }
  }
  const err = new CustomError("test");
  assert.ok(err.stack, "custom error must have stack");
  assert.strictEqual(err.name, "CustomError", "custom error name");
}
console.log("PASS: Error.captureStackTrace");

// ---- Error.stackTraceLimit ----
{
  assert.strictEqual(typeof Error.stackTraceLimit, "number",
    "Error.stackTraceLimit must be a number");
}
console.log("PASS: Error.stackTraceLimit");

console.log("ALL NODE COMPAT IMPROVEMENT TESTS PASSED");
