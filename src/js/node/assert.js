// node:assert shim
class AssertionError extends Error {
  constructor(options = {}) {
    super(options.message || "assertion failed");
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
  }
}

function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEq(a[k], b[k]));
}

function ok(value, message) {
  if (!value) throw new AssertionError({ message: message || "expected value to be truthy", actual: value, expected: true, operator: "==" });
}

function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) throw new AssertionError({ message, actual, expected, operator: "==" });
}

function notEqual(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) throw new AssertionError({ message, actual, expected, operator: "!=" });
}

function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) throw new AssertionError({ message, actual, expected, operator: "strictEqual" });
}

function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) throw new AssertionError({ message, actual, expected, operator: "notStrictEqual" });
}

function deepEqual(actual, expected, message) {
  if (!deepEq(actual, expected)) throw new AssertionError({ message, actual, expected, operator: "deepEqual" });
}

function notDeepEqual(actual, expected, message) {
  if (deepEq(actual, expected)) throw new AssertionError({ message, actual, expected, operator: "notDeepEqual" });
}

function deepStrictEqual(actual, expected, message) {
  if (!deepEq(actual, expected)) throw new AssertionError({ message, actual, expected, operator: "deepStrictEqual" });
}

function notDeepStrictEqual(actual, expected, message) {
  if (deepEq(actual, expected)) throw new AssertionError({ message, actual, expected, operator: "notDeepStrictEqual" });
}

function fail(message) {
  throw new AssertionError({ message: message || "Failed" });
}

function throws(fn, message) {
  try {
    fn();
  } catch (_) {
    return;
  }
  throw new AssertionError({ message: message || "Missing expected exception" });
}

function doesNotThrow(fn, message) {
  try {
    fn();
  } catch (err) {
    throw new AssertionError({ message: message || `Got unwanted exception: ${err?.message || err}` });
  }
}

async function rejects(asyncFn, message) {
  const p = typeof asyncFn === "function" ? asyncFn() : asyncFn;
  try {
    await p;
  } catch (_) {
    return;
  }
  throw new AssertionError({ message: message || "Missing expected rejection" });
}

async function doesNotReject(asyncFn, message) {
  const p = typeof asyncFn === "function" ? asyncFn() : asyncFn;
  try {
    await p;
  } catch (err) {
    throw new AssertionError({ message: message || `Got unwanted rejection: ${err?.message || err}` });
  }
}

function ifError(err) {
  if (err !== null && err !== undefined) {
    throw err;
  }
}

function match(string, regexp, message) {
  if (!(regexp instanceof RegExp)) {
    throw new TypeError("The \"regexp\" argument must be an instance of RegExp");
  }
  if (!regexp.test(String(string))) {
    throw new AssertionError({
      message: message || `The input did not match the regular expression ${regexp}. Input: '${string}'`,
      actual: string,
      expected: regexp,
      operator: "match",
    });
  }
}

function doesNotMatch(string, regexp, message) {
  if (!(regexp instanceof RegExp)) {
    throw new TypeError("The \"regexp\" argument must be an instance of RegExp");
  }
  if (regexp.test(String(string))) {
    throw new AssertionError({
      message: message || `The input was expected to not match the regular expression ${regexp}. Input: '${string}'`,
      actual: string,
      expected: regexp,
      operator: "doesNotMatch",
    });
  }
}

function assert(value, message) {
  ok(value, message);
}

Object.assign(assert, {
  ok,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  fail,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  AssertionError,
  strict: assert,
});

export {
  ok,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  fail,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  AssertionError,
};
export default assert;
