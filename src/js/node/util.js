// node:util shim
import types from "node:util/types";
import { __isDeepEqual } from "node:assert";

const { format, formatWithOptions, inspect } = __jse;

function promisify(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, value) => (err ? reject(err) : resolve(value)));
    });
  };
}

function callbackify(fn) {
  return function (...args) {
    const cb = args.pop();
    if (typeof cb !== "function") throw new TypeError("The last argument must be of type function");
    Promise.resolve(fn.apply(this, args))
      .then((res) => cb(null, res))
      .catch((err) => cb(err));
  };
}

function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

function deprecate(fn, msg) {
  let warned = false;
  return function (...args) {
    if (!warned) {
      warned = true;
      console.warn(msg);
    }
    return fn.apply(this, args);
  };
}

function isDeepStrictEqual(a, b) {
  return __isDeepEqual(a, b, true);
}

function debuglog(set) {
  const env = (process.env.NODE_DEBUG || "").toUpperCase();
  const enabled = env.split(",").includes(set.toUpperCase());
  if (enabled) {
    return (...args) => console.error(`${set.toUpperCase()} ${process.pid}:`, ...args);
  }
  return () => {};
}

const TextEncoder = globalThis.TextEncoder;
const TextDecoder = globalThis.TextDecoder;

export {
  format,
  formatWithOptions,
  inspect,
  promisify,
  callbackify,
  inherits,
  deprecate,
  isDeepStrictEqual,
  debuglog,
  types,
  TextEncoder,
  TextDecoder,
};

export default {
  format,
  formatWithOptions,
  inspect,
  promisify,
  callbackify,
  inherits,
  deprecate,
  isDeepStrictEqual,
  debuglog,
  types,
  TextEncoder,
  TextDecoder,
};
