// node:util shim
import types from "node:util/types";
import { __isDeepEqual } from "node:assert";

const { format, formatWithOptions, inspect } = __jse;

const kCustomPromisify = Symbol.for("nodejs.util.promisify.custom");

// Node's promisify: honors fn[util.promisify.custom] and keeps the
// original's properties.
function promisify(original) {
  if (typeof original !== "function") throw __jse.invalidArgType("original", "function", original);
  const custom = original[kCustomPromisify];
  if (custom !== undefined) {
    if (typeof custom !== "function") {
      throw __jse.invalidArgType("util.promisify.custom", "function", custom);
    }
    return Object.defineProperty(custom, kCustomPromisify, { value: custom, configurable: true });
  }
  function fn(...args) {
    return new Promise((resolve, reject) => {
      Reflect.apply(original, this, [...args, (err, value) => (err ? reject(err) : resolve(value))]);
    });
  }
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperty(fn, kCustomPromisify, { value: fn, configurable: true });
  return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
}
promisify.custom = kCustomPromisify;

function callbackify(fn) {
  return function (...args) {
    const cb = args.pop();
    if (typeof cb !== "function") throw new TypeError("The last argument must be of type function");
    Promise.resolve(fn.apply(this, args))
      .then((res) => cb(null, res))
      .catch((err) => {
        // Node wraps falsy rejection reasons so cb(null) doesn't look like success
        if (!err && err !== false) {
          err = new Error("Promise was rejected with a falsy value");
          err.reason = err;
        }
        cb(err);
      });
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

// Node 18.3+ util.parseArgs
function parseArgs(config = {}) {
  const { args = process.argv.slice(2), options = {}, strict = true, allowPositionals = false, tokens: returnTokens = false } = config;
  const values = {};
  const positionals = [];
  const tokens = [];
  // Initialize defaults
  for (const [name, opt] of Object.entries(options)) {
    if (opt.type === "boolean") values[name] = opt.default ?? false;
    else if (opt.type === "string") values[name] = opt.multiple ? (opt.default ?? []) : (opt.default ?? undefined);
  }
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const name = eqIdx > 0 ? arg.slice(2, eqIdx) : arg.slice(2);
      const opt = options[name];
      if (strict && !opt) throw new Error(`Unknown option: --${name}`);
      if (opt?.type === "boolean") {
        values[name] = true;
        tokens.push({ kind: "option", name, value: true, index: i });
      } else {
        const val = eqIdx > 0 ? arg.slice(eqIdx + 1) : args[++i];
        if (opt?.multiple) { if (!Array.isArray(values[name])) values[name] = []; values[name].push(val); }
        else values[name] = val;
        tokens.push({ kind: "option", name, value: val, index: i });
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Short options
      const letter = arg[1];
      const shortName = Object.entries(options).find(([, o]) => o.short === letter)?.[0];
      if (strict && !shortName) throw new Error(`Unknown option: -${letter}`);
      const opt = shortName ? options[shortName] : null;
      const name = shortName || letter;
      if (opt?.type === "boolean") {
        values[name] = true;
        tokens.push({ kind: "option", name, value: true, index: i });
      } else {
        const val = arg.length > 2 ? arg.slice(2) : args[++i];
        if (opt?.multiple) { if (!Array.isArray(values[name])) values[name] = []; values[name].push(val); }
        else values[name] = val;
        tokens.push({ kind: "option", name, value: val, index: i });
      }
    } else {
      if (strict && !allowPositionals) throw new Error(`Unexpected positional: ${arg}`);
      positionals.push(arg);
      tokens.push({ kind: "positional", value: arg, index: i });
    }
    i++;
  }
  const result = { values, positionals };
  if (returnTokens) result.tokens = tokens;
  return result;
}

// Node 21+ util.styleText
const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m",
  cyan: "\x1b[36m", white: "\x1b[37m", bgRed: "\x1b[41m", bgGreen: "\x1b[42m", bgYellow: "\x1b[43m" };
function styleText(style, text) {
  const code = ANSI[style];
  if (!code) return String(text);
  return `${code}${text}\x1b[0m`;
}

// Node 21+ util.MIMEType (basic)
class MIMEType {
  constructor(input) {
    const str = String(input);
    const semi = str.indexOf(";");
    const base = semi >= 0 ? str.slice(0, semi).trim() : str.trim();
    const slash = base.indexOf("/");
    this.type = slash >= 0 ? base.slice(0, slash) : base;
    this.subtype = slash >= 0 ? base.slice(slash + 1) : "";
    this.params = new MIMEParams(semi >= 0 ? str.slice(semi + 1) : "");
  }
  get essence() { return `${this.type}/${this.subtype}`; }
  toString() { const p = this.params.toString(); return p ? `${this.essence};${p}` : this.essence; }
}
class MIMEParams {
  #map = new Map();
  constructor(str) { for (const part of str.split(";")) { const [k, v] = part.split("=").map(s => s.trim()); if (k) this.#map.set(k, v || ""); } }
  get(name) { return this.#map.get(name) ?? null; }
  set(name, value) { this.#map.set(name, value); }
  has(name) { return this.#map.has(name); }
  delete(name) { return this.#map.delete(name); }
  toString() { const parts = []; this.#map.forEach((v, k) => parts.push(`${k}=${v}`)); return parts.join("; "); }
  [Symbol.iterator]() { return this.#map[Symbol.iterator](); }
  entries() { return this.#map.entries(); }
  keys() { return this.#map.keys(); }
  values() { return this.#map.values(); }
}

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
  parseArgs,
  styleText,
  MIMEType,
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
  parseArgs,
  styleText,
  MIMEType,
};
