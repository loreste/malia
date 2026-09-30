// node:assert. Deep equality follows Node's comparison rules (Map/Set
// contents, Dates, RegExps, typed arrays, boxed primitives, prototypes in
// strict mode, cycles); failure messages follow Node's wording without the
// line diff.
const { inspect } = __jse;

class AssertionError extends Error {
  constructor(options = {}) {
    const { message, actual, expected, operator } = options;
    super(message !== undefined ? String(message) : generatedMessage(actual, expected, operator));
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    this.generatedMessage = message === undefined;
  }
}

const DESCRIPTIONS = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
};

function generatedMessage(actual, expected, operator) {
  const a = inspect(actual);
  const e = inspect(expected);
  if (operator === "==" || operator === "!=") return `${a} ${operator} ${e}`;
  if (operator === "notStrictEqual" || operator === "notDeepStrictEqual" || operator === "notDeepEqual") {
    return `${DESCRIPTIONS[operator]}\n\n${a}\n`;
  }
  if (operator === "strictEqual" && typeof actual !== "object" && typeof expected !== "object") {
    return `${DESCRIPTIONS.strictEqual}\n\n${a} !== ${e}\n`;
  }
  if (DESCRIPTIONS[operator]) return `${DESCRIPTIONS[operator]}\n+ actual - expected\n\n+ ${a}\n- ${e}`;
  return `${a} ${operator} ${e}`;
}

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;
  throw new AssertionError(obj);
}

// ---- Deep equality -------------------------------------------------------

const core = globalThis.Deno?.core;
const tagOf = (v) => Object.prototype.toString.call(v);
const isBoxed = (v) => core?.isBoxedPrimitive?.(v) ?? false;

function isDeepEqual(a, b, strict, memos) {
  if (a === b) return a !== 0 || !strict || Object.is(a, b);
  if (strict) {
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      return Object.is(a, b);
    }
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  } else {
    if (a === null || typeof a !== "object") {
      if (b === null || typeof b !== "object") {
        // eslint-disable-next-line eqeqeq
        return a == b || (Number.isNaN(a) && Number.isNaN(b));
      }
      return false;
    }
    if (b === null || typeof b !== "object") return false;
  }

  const tag = tagOf(a);
  if (tag !== tagOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (a instanceof Date) {
    if (!(b instanceof Date) || a.getTime() !== b.getTime()) return false;
  } else if (a instanceof RegExp) {
    if (!(b instanceof RegExp) || a.source !== b.source || a.flags !== b.flags || a.lastIndex !== b.lastIndex) return false;
  } else if (a instanceof Error) {
    if (!(b instanceof Error) || a.message !== b.message || a.name !== b.name) return false;
  } else if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b)) return false;
    if (!strict && (a instanceof Float32Array || a instanceof Float64Array)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    } else if (!bytesEqual(a, b)) {
      return false;
    }
  } else if (a instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer)) {
    if (!bytesEqual(new Uint8Array(a), new Uint8Array(b))) return false;
  } else if (isBoxed(a)) {
    if (!isBoxed(b) || !Object.is(a.valueOf(), b.valueOf())) return false;
  } else if (a instanceof WeakMap || a instanceof WeakSet || a instanceof Promise) {
    return false; // only identical instances are equal (checked above)
  }

  // Cycle detection: a pair already under comparison is assumed equal.
  if (memos === undefined) memos = { a: new Map(), b: new Map(), position: 0 };
  const seenA = memos.a.get(a);
  if (seenA !== undefined) {
    const seenB = memos.b.get(b);
    if (seenB !== undefined) return seenA === seenB;
  }
  memos.position++;
  memos.a.set(a, memos.position);
  memos.b.set(b, memos.position);
  try {
    return compareContents(a, b, strict, memos);
  } finally {
    memos.a.delete(a);
    memos.b.delete(b);
  }
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength);
  const y = new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function ownKeys(obj, strict) {
  const keys = Object.keys(obj);
  if (strict) {
    for (const sym of Object.getOwnPropertySymbols(obj)) {
      if (Object.prototype.propertyIsEnumerable.call(obj, sym)) keys.push(sym);
    }
  }
  return keys;
}

function compareContents(a, b, strict, memos) {
  const isTypedArray = ArrayBuffer.isView(a);
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
  }
  // Typed array elements were compared already; skip index keys.
  const filter = isTypedArray ? (k) => typeof k === "symbol" || !/^\d+$/.test(k) : () => true;
  const keysA = ownKeys(a, strict).filter(filter);
  const keysB = ownKeys(b, strict).filter(filter);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
  }

  if (a instanceof Set) {
    if (!(b instanceof Set) || !setEquiv(a, b, strict, memos)) return false;
  } else if (a instanceof Map) {
    if (!(b instanceof Map) || !mapEquiv(a, b, strict, memos)) return false;
  }

  for (const key of keysA) {
    if (!isDeepEqual(a[key], b[key], strict, memos)) return false;
  }
  return true;
}

function setEquiv(a, b, strict, memos) {
  if (a.size !== b.size) return false;
  let pending = null;
  for (const val of a) {
    if (typeof val === "object" && val !== null) {
      (pending ??= []).push(val);
    } else if (!b.has(val)) {
      if (strict) return false;
      // Loose mode: a primitive may equal a different primitive in b.
      (pending ??= []).push(val);
    }
  }
  if (pending === null) return true;
  const candidates = [];
  for (const val of b) {
    if ((typeof val === "object" && val !== null) || (!strict && !a.has(val))) candidates.push(val);
  }
  for (const val of pending) {
    const idx = candidates.findIndex((c) => isDeepEqual(val, c, strict, memos));
    if (idx === -1) return false;
    candidates.splice(idx, 1);
  }
  return candidates.length === 0;
}

function mapEquiv(a, b, strict, memos) {
  if (a.size !== b.size) return false;
  let pending = null;
  for (const [key, val] of a) {
    if (typeof key === "object" && key !== null) {
      (pending ??= []).push([key, val]);
    } else if (b.has(key) && isDeepEqual(val, b.get(key), strict, memos)) {
      continue;
    } else if (strict || !b.has(key)) {
      if (strict) return false;
      (pending ??= []).push([key, val]);
    } else {
      return false;
    }
  }
  if (pending === null) return true;
  const candidates = [];
  for (const entry of b) {
    const [key] = entry;
    if ((typeof key === "object" && key !== null) || (!strict && !a.has(key))) candidates.push(entry);
  }
  for (const [key, val] of pending) {
    const idx = candidates.findIndex(([k, v]) => isDeepEqual(key, k, strict, memos) && isDeepEqual(val, v, strict, memos));
    if (idx === -1) return false;
    candidates.splice(idx, 1);
  }
  return candidates.length === 0;
}

// ---- Assertions ------------------------------------------------------------

function ok(...args) {
  const [value, message] = args;
  if (!value) {
    innerFail({
      actual: value,
      expected: true,
      message: args.length === 0
        ? "No value argument passed to `assert.ok()`"
        : message ?? `The expression evaluated to a falsy value:\n\n  assert.ok(${inspect(value)})\n`,
      operator: "==",
    });
  }
}

function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (!(actual == expected || (Number.isNaN(actual) && Number.isNaN(expected)))) {
    innerFail({ actual, expected, message, operator: "==" });
  }
}

function notEqual(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "!=" });
  }
}

function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) innerFail({ actual, expected, message, operator: "strictEqual" });
}

function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) innerFail({ actual, expected, message, operator: "notStrictEqual" });
}

function deepEqual(actual, expected, message) {
  if (!isDeepEqual(actual, expected, false)) innerFail({ actual, expected, message, operator: "deepEqual" });
}

function notDeepEqual(actual, expected, message) {
  if (isDeepEqual(actual, expected, false)) innerFail({ actual, expected, message, operator: "notDeepEqual" });
}

function deepStrictEqual(actual, expected, message) {
  if (!isDeepEqual(actual, expected, true)) innerFail({ actual, expected, message, operator: "deepStrictEqual" });
}

function notDeepStrictEqual(actual, expected, message) {
  if (isDeepEqual(actual, expected, true)) innerFail({ actual, expected, message, operator: "notDeepStrictEqual" });
}

function fail(message = "Failed") {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, operator: "fail" });
}

// Validate a thrown/rejected error against `expected`, as Node does: a class
// (instanceof), a RegExp (tested against String(err)), a validation
// function (must return true), or an object whose keys must deep-equal.
function checkError(actual, expected, message, fnName) {
  if (expected === undefined) return;
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && actual instanceof expected) return;
    if (Error.isPrototypeOf(expected) || expected === Error) {
      const received = actual?.constructor?.name ?? inspect(actual);
      innerFail({
        actual,
        expected,
        message: message ?? `The error is expected to be an instance of "${expected.name}". Received "${received}"`,
        operator: fnName,
      });
    }
    const res = expected.call({}, actual);
    if (res !== true) {
      innerFail({
        actual,
        expected,
        message: message ?? `The ${expected.name ? `"${expected.name}" ` : ""}validation function is expected to return "true". Received ${inspect(res)}`,
        operator: fnName,
      });
    }
    return;
  }
  if (expected instanceof RegExp) {
    if (expected.test(String(actual))) return;
    innerFail({
      actual,
      expected,
      message: message ?? `The input did not match the regular expression ${inspect(expected)}. Input:\n\n${inspect(String(actual))}\n`,
      operator: fnName,
    });
  }
  if (typeof expected === "object" && expected !== null) {
    const keys = Object.keys(expected);
    if (expected instanceof Error) keys.push("name", "message");
    for (const key of keys) {
      const want = expected[key];
      const got = actual?.[key];
      const matches = want instanceof RegExp && typeof got === "string" ? want.test(got) : isDeepEqual(got, want, true);
      if (!matches) {
        innerFail({
          actual,
          expected,
          message: message ?? `Expected values to be strictly deep-equal:\n+ actual - expected\n\n  Comparison {\n+   ${key}: ${inspect(got)}\n-   ${key}: ${inspect(want)}\n  }`,
          operator: fnName,
        });
      }
    }
    return;
  }
  throw __jse.invalidArgType("error", "function or an instance of Error, RegExp, or Object", expected);
}

const NO_EXCEPTION = Symbol("no exception");

function splitExpected(expected, message) {
  if (typeof expected === "string") return [undefined, expected];
  return [expected, message];
}

function throws(fn, expected, message) {
  if (typeof fn !== "function") throw __jse.invalidArgType("fn", "function", fn);
  [expected, message] = splitExpected(expected, message);
  let error = NO_EXCEPTION;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  if (error === NO_EXCEPTION) {
    const name = expected?.name ? ` (${expected.name})` : "";
    innerFail({ actual: undefined, expected, message: `Missing expected exception${name}${message ? `: ${message}` : "."}`, operator: "throws" });
  }
  checkError(error, expected, message, "throws");
}

function doesNotThrow(fn, expected, message) {
  [expected, message] = splitExpected(expected, message);
  try {
    fn();
  } catch (err) {
    if (typeof expected === "function" && !(expected.prototype !== undefined && err instanceof expected)) throw err;
    innerFail({
      actual: err,
      expected,
      message: `Got unwanted exception${message ? `: ${message}` : "."}\nActual message: "${err?.message}"`,
      operator: "doesNotThrow",
    });
  }
}

async function waitFor(promiseFn) {
  const p = typeof promiseFn === "function" ? promiseFn() : promiseFn;
  if (typeof p?.then !== "function") {
    throw __jse.invalidArgType("promiseFn", "function or an instance of Promise", promiseFn);
  }
  return p;
}

async function rejects(promiseFn, expected, message) {
  [expected, message] = splitExpected(expected, message);
  let error = NO_EXCEPTION;
  try {
    await waitFor(promiseFn);
  } catch (err) {
    error = err;
  }
  if (error === NO_EXCEPTION) {
    const name = expected?.name ? ` (${expected.name})` : "";
    innerFail({ actual: undefined, expected, message: `Missing expected rejection${name}${message ? `: ${message}` : "."}`, operator: "rejects" });
  }
  checkError(error, expected, message, "rejects");
}

async function doesNotReject(promiseFn, expected, message) {
  [expected, message] = splitExpected(expected, message);
  try {
    await waitFor(promiseFn);
  } catch (err) {
    if (typeof expected === "function" && !(expected.prototype !== undefined && err instanceof expected)) throw err;
    innerFail({
      actual: err,
      expected,
      message: `Got unwanted rejection${message ? `: ${message}` : "."}\nActual message: "${err?.message}"`,
      operator: "doesNotReject",
    });
  }
}

function ifError(err) {
  if (err === null || err === undefined) return;
  let message = "ifError got unwanted exception: ";
  message += typeof err?.message === "string" && err.message !== "" ? err.message : inspect(err);
  const newErr = new AssertionError({ actual: err, expected: null, operator: "ifError", message });
  newErr.origStack = err?.stack;
  throw newErr;
}

function matchImpl(string, regexp, message, fnName, shouldMatch) {
  if (!(regexp instanceof RegExp)) throw __jse.invalidArgType("regexp", "an instance of RegExp", regexp);
  if (typeof string !== "string" || regexp.test(string) !== shouldMatch) {
    if (message instanceof Error) throw message;
    const generated = typeof string !== "string"
      ? `The "string" argument must be of type string. Received type ${typeof string} (${inspect(string)})`
      : `The input ${shouldMatch ? "did not match" : "was expected to not match"} the regular expression ${inspect(regexp)}. Input:\n\n${inspect(string)}\n`;
    innerFail({ actual: string, expected: regexp, message: message ?? generated, operator: fnName });
  }
}

function match(string, regexp, message) {
  matchImpl(string, regexp, message, "match", true);
}

function doesNotMatch(string, regexp, message) {
  matchImpl(string, regexp, message, "doesNotMatch", false);
}

const common = {
  ok,
  fail,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  strictEqual,
  notStrictEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  AssertionError,
};

function assert(...args) {
  ok(...args);
}
Object.assign(assert, common, { equal, notEqual, deepEqual, notDeepEqual });

// assert.strict: the loose comparisons map to their strict versions.
function strict(...args) {
  ok(...args);
}
Object.assign(strict, common, {
  equal: strictEqual,
  notEqual: notStrictEqual,
  deepEqual: deepStrictEqual,
  notDeepEqual: notDeepStrictEqual,
});
assert.strict = strict;
strict.strict = strict;

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
  strict,
  isDeepEqual as __isDeepEqual,
};
export default assert;
