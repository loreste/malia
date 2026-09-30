// Internal utilities: value inspection and printf-style formatting.
"use strict";

((globalThis) => {
  const seen = new Set();

  function inspect(value, depth) {
    if (depth === undefined) depth = 4;
    return inspectInner(value, depth, false);
  }

  function inspectInner(value, depth, nested) {
    if (value === null) return "null";
    switch (typeof value) {
      case "undefined":
        return "undefined";
      case "string":
        return nested ? JSON.stringify(value) : value;
      case "number":
      case "boolean":
        return String(value);
      case "bigint":
        return String(value) + "n";
      case "symbol":
        return value.toString();
      case "function":
        return "[Function" + (value.name ? ": " + value.name : " (anonymous)") + "]";
    }
    if (value instanceof Error) {
      return value.stack || String(value);
    }
    if (seen.has(value)) return "[Circular]";
    if (depth <= 0) return Array.isArray(value) ? "[Array]" : "[Object]";

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = value.map((v) => inspectInner(v, depth - 1, true));
        return "[ " + items.join(", ") + " ]";
      }
      if (ArrayBuffer.isView(value)) {
        const name = value.constructor.name;
        const items = Array.prototype.slice.call(value, 0, 64).join(", ");
        return name + "(" + value.length + ") [ " + items + (value.length > 64 ? ", ..." : "") + " ]";
      }
      if (value instanceof ArrayBuffer) {
        return "ArrayBuffer { byteLength: " + value.byteLength + " }";
      }
      if (value instanceof Map) {
        const items = [];
        for (const [k, v] of value) {
          items.push(inspectInner(k, depth - 1, true) + " => " + inspectInner(v, depth - 1, true));
        }
        return "Map(" + value.size + ") { " + items.join(", ") + " }";
      }
      if (value instanceof Set) {
        const items = [];
        for (const v of value) items.push(inspectInner(v, depth - 1, true));
        return "Set(" + value.size + ") { " + items.join(", ") + " }";
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof RegExp) {
        return value.toString();
      }
      if (value instanceof Promise) {
        return "Promise { <pending> }";
      }
      const keys = Object.keys(value);
      if (keys.length === 0) {
        const tag = Object.prototype.toString.call(value);
        return tag === "[object Object]" ? "{}" : tag.replace(/^\[object (.*)\]$/, "$1 {}");
      }
      const parts = keys.map((k) => k + ": " + inspectInner(value[k], depth - 1, true));
      return "{ " + parts.join(", ") + " }";
    } finally {
      seen.delete(value);
    }
  }

  function format(...args) {
    if (args.length === 0) return "";
    const first = args[0];
    if (typeof first !== "string") {
      return args.map((a) => inspect(a)).join(" ");
    }
    let i = 1;
    const out = first.replace(/%[sdifjoO%]/g, (token) => {
      if (token === "%%") return "%";
      if (i >= args.length) return token;
      const arg = args[i++];
      switch (token) {
        case "%s":
          return String(arg);
        case "%d":
        case "%i":
          return String(parseInt(arg, 10));
        case "%f":
          return String(parseFloat(arg));
        case "%j":
          try {
            return JSON.stringify(arg);
          } catch {
            return "[Circular]";
          }
        case "%o":
        case "%O":
          return inspect(arg);
        default:
          return token;
      }
    });
    const rest = args.slice(i).map((a) => inspect(a));
    return [out, ...rest].join(" ");
  }

  globalThis.__jse = {
    inspect,
    format,
    // V8 structured-clone (binary) helpers used for worker/channel messages.
    serialize: (value) =>
      Deno.core.ops.op_serialize(value, undefined, undefined, false, undefined),
    deserialize: (bytes) =>
      Deno.core.ops.op_deserialize(bytes, undefined, undefined, undefined, false),
  };
})(globalThis);
