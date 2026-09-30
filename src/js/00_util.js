// Internal utilities: value inspection and printf-style formatting.
"use strict";

((globalThis) => {
  // util.inspect, following Node's algorithm closely enough that console.log
  // output matches for common values: depth limit, class names, symbol keys,
  // quoting rules, <ref *n> cycles, array grouping, and line breaking.
  const CUSTOM = Symbol.for("nodejs.util.inspect.custom");
  const DEFAULTS = {
    depth: 2,
    breakLength: 80,
    compact: 3,
    maxArrayLength: 100,
    maxStringLength: 10000,
    sorted: false,
    getters: false,
    customInspect: true,
    showHidden: false,
    colors: false,
  };
  const IDENT_RE = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
  const ESCAPES = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f", "\v": "\\v", "\\": "\\\\" };

  function inspect(value, opts) {
    // Legacy signature: inspect(value, showHidden, depth, colors).
    const options = typeof opts === "object" && opts !== null ? opts : { depth: arguments[2] };
    const ctx = { ...DEFAULTS, seen: [], circular: new Map(), indentationLvl: 0, currentDepth: 0 };
    for (const key of Object.keys(DEFAULTS)) {
      if (options[key] !== undefined) ctx[key] = options[key];
    }
    if (ctx.depth === null) ctx.depth = Infinity;
    if (ctx.compact === false) ctx.compact = 0;
    return formatValue(ctx, value, 0);
  }
  inspect.custom = CUSTOM;
  inspect.defaultOptions = DEFAULTS;

  function strEscape(str) {
    let quote = "'";
    if (str.includes("'")) {
      if (!str.includes('"')) quote = '"';
      else if (!str.includes("`") && !str.includes("${")) quote = "`";
    }
    let out = "";
    for (const ch of str) {
      if (ch === quote) out += "\\" + ch;
      else if (ESCAPES[ch]) out += ESCAPES[ch];
      else if (ch < " " || ch === "\x7f") out += "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase();
      else out += ch;
    }
    return quote + out + quote;
  }

  function formatPrimitive(ctx, value) {
    switch (typeof value) {
      case "string": {
        const trailer = value.length > ctx.maxStringLength
          ? `... ${value.length - ctx.maxStringLength} more character${value.length - ctx.maxStringLength > 1 ? "s" : ""}`
          : "";
        return strEscape(trailer ? value.slice(0, ctx.maxStringLength) : value) + trailer;
      }
      case "number":
        return Object.is(value, -0) ? "-0" : String(value);
      case "bigint":
        return `${value}n`;
      case "boolean":
      case "undefined":
        return String(value);
      case "symbol":
        return value.toString();
    }
    return "null";
  }

  function formatKey(key) {
    if (typeof key === "symbol") return key.toString();
    return IDENT_RE.test(key) ? key : strEscape(key);
  }

  function constructorName(obj) {
    let proto = obj;
    while (proto !== null) {
      const desc = Object.getOwnPropertyDescriptor(proto, "constructor");
      if (desc && typeof desc.value === "function" && desc.value.name !== "") return desc.value.name;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  // "Foo", "[Foo: null prototype]", plus a [Symbol.toStringTag] if it differs.
  function prefix(name, tag, fallback, size) {
    const sizeStr = size === undefined ? "" : `(${size})`;
    if (name === null) {
      return tag && tag !== fallback
        ? `[${fallback}${sizeStr}: null prototype] [${tag}] `
        : `[${fallback}${sizeStr}: null prototype] `;
    }
    return tag && tag !== name ? `${name}${sizeStr} [${tag}] ` : `${name}${sizeStr} `;
  }

  function formatValue(ctx, value, recurseTimes, typedArray) {
    if (typeof value !== "object" && typeof value !== "function") {
      return formatPrimitive(ctx, value);
    }
    if (value === null) return "null";

    if (ctx.customInspect) {
      const custom = value[CUSTOM];
      if (typeof custom === "function" && custom !== inspect) {
        const depth = ctx.depth - recurseTimes;
        const ret = custom.call(value, depth, { ...ctx, depth, stylize: (s) => s }, inspect);
        if (ret !== value) {
          if (typeof ret !== "string") return formatValue(ctx, ret, recurseTimes);
          return ret.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
        }
      }
    }

    if (ctx.seen.includes(value)) {
      let index = ctx.circular.get(value);
      if (index === undefined) {
        index = ctx.circular.size + 1;
        ctx.circular.set(value, index);
      }
      return `[Circular *${index}]`;
    }
    return formatRaw(ctx, value, recurseTimes, typedArray);
  }

  function getKeys(value, showHidden) {
    const keys = showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value);
    for (const sym of Object.getOwnPropertySymbols(value)) {
      if (showHidden || Object.prototype.propertyIsEnumerable.call(value, sym)) keys.push(sym);
    }
    return keys;
  }

  function formatRaw(ctx, value, recurseTimes, typedArray) {
    const core = globalThis.Deno?.core;
    let keys;
    const name = constructorName(value);
    let tag = value[Symbol.toStringTag];
    // An own enumerable tag is printed as a property; don't repeat it.
    if (typeof tag !== "string" || (tag !== "" && Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag))) {
      tag = "";
    }
    let base = "";
    let formatter = formatObjectEntries;
    let braces;
    let noIterator = true;
    let extrasArray = false;

    if (Array.isArray(value)) {
      keys = getKeys(value, ctx.showHidden).filter((k) => typeof k === "symbol" || !isIndex(k));
      const pre = name !== "Array" || tag !== "" ? prefix(name, tag, "Array", value.length) : "";
      braces = [`${pre}[`, "]"];
      if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
      extrasArray = true;
      formatter = formatArray;
      noIterator = false;
    } else if (value instanceof Set || core?.isSet?.(value)) {
      keys = getKeys(value, ctx.showHidden);
      const pre = prefix(name, tag, "Set", value.size);
      if (value.size === 0 && keys.length === 0) return `${pre}{}`;
      braces = [`${pre}{`, "}"];
      formatter = formatSet;
      noIterator = false;
    } else if (value instanceof Map || core?.isMap?.(value)) {
      keys = getKeys(value, ctx.showHidden);
      const pre = prefix(name, tag, "Map", value.size);
      if (value.size === 0 && keys.length === 0) return `${pre}{}`;
      braces = [`${pre}{`, "}"];
      formatter = formatMap;
      noIterator = false;
    } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      keys = getKeys(value, ctx.showHidden).filter((k) => typeof k === "symbol" || !isIndex(k));
      const fallback = tag || "TypedArray";
      braces = [`${prefix(name, tag, fallback, value.length)}[`, "]"];
      if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
      extrasArray = true;
      formatter = formatTypedArray;
      noIterator = false;
    }

    if (noIterator) {
      keys = getKeys(value, ctx.showHidden);
      braces = ["{", "}"];
      if (name === "Object" && tag === "") {
        if (core?.isArgumentsObject?.(value)) braces[0] = "[Arguments] {";
        else if (keys.length === 0) return "{}";
      } else if (typeof value === "function") {
        base = formatFunction(value, name, tag);
        if (keys.length === 0) return base;
      } else if (value instanceof RegExp) {
        base = RegExp.prototype.toString.call(value);
        if (keys.length === 0) return base;
      } else if (value instanceof Date) {
        base = Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
        if (keys.length === 0) return base;
      } else if (value instanceof Error) {
        base = formatError(value);
        keys = keys.filter((k) => k !== "stack" && k !== "message");
        if (keys.length === 0) return base.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
      } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        const bytes = [...new Uint8Array(value, 0, Math.min(value.byteLength, 50))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        const more = value.byteLength > 50 ? ` ... ${value.byteLength - 50} more byte${value.byteLength - 50 > 1 ? "s" : ""}` : "";
        keys.unshift("byteLength");
        braces[0] = `${prefix(name, tag, "ArrayBuffer")}{`;
        formatter = () => [`[Uint8Contents]: <${bytes}${more}>`];
      } else if (value instanceof DataView) {
        braces[0] = `${prefix(name, tag, "DataView")}{`;
        keys.unshift("byteLength", "byteOffset", "buffer");
      } else if (value instanceof Promise || core?.isPromise?.(value)) {
        braces[0] = `${prefix(name, tag, "Promise")}{`;
        formatter = formatPromise;
      } else if (value instanceof WeakSet || value instanceof WeakMap) {
        return `${prefix(name, tag, value instanceof WeakSet ? "WeakSet" : "WeakMap")}{ <items unknown> }`;
      } else if (value instanceof WeakRef) {
        braces[0] = `${prefix(name, tag, "WeakRef")}{`;
        formatter = (c, v, r) => [formatValue(c, v.deref(), r)];
      } else if (core?.isBoxedPrimitive?.(value)) {
        const prim = value.valueOf();
        const type = typeof prim === "bigint" ? "BigInt" : typeof prim === "symbol" ? "Symbol" : name;
        base = `[${type}: ${formatPrimitive(ctx, prim)}]`;
        if (typeof prim === "string") keys = keys.filter((k) => typeof k === "symbol" || !isIndex(k));
        if (keys.length === 0) return base;
      } else if (name === null) {
        braces[0] = `${prefix(name, tag, "Object")}{`;
        if (keys.length === 0) return `${braces[0]}}`;
      } else {
        braces[0] = `${prefix(name, tag, "Object")}{`;
        if (keys.length === 0) return `${braces[0]}}`;
      }
    }

    if (recurseTimes > ctx.depth && ctx.depth !== Infinity) {
      const shown = name === null ? "Object: null prototype" : tag && tag !== name ? `${name} [${tag}]` : name || tag || "Object";
      return Array.isArray(value) ? "[Array]" : `[${shown}]`;
    }

    recurseTimes += 1;
    ctx.seen.push(value);
    ctx.currentDepth = recurseTimes;
    let output;
    try {
      output = formatter(ctx, value, recurseTimes);
      for (const key of keys) {
        output.push(formatProperty(ctx, value, recurseTimes, key, extrasArray));
      }
      if (ctx.sorted) {
        const compare = typeof ctx.sorted === "function" ? ctx.sorted : undefined;
        if (!extrasArray) output.sort(compare);
        else if (keys.length > 1) output.push(...output.splice(output.length - keys.length).sort(compare));
      }
    } finally {
      ctx.seen.pop();
    }

    const index = ctx.circular.get(value);
    if (index !== undefined) {
      const reference = `<ref *${index}>`;
      if (base === "") braces[0] = `${reference} ${braces[0]}`;
      else base = `${reference} ${base}`;
    }
    return reduceToSingleString(ctx, output, base, braces, extrasArray, recurseTimes, value);
  }

  function isIndex(key) {
    return typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
  }

  function formatFunction(fn, name, tag) {
    const src = Function.prototype.toString.call(fn);
    if (src.startsWith("class") && /^class\s*[\w$]*\s*(extends|\{)/.test(src)) {
      let out = `[class ${fn.name || "(anonymous)"}`;
      const superName = Object.getPrototypeOf(fn)?.name;
      if (superName) out += ` extends ${superName}`;
      return out + "]";
    }
    let type = "Function";
    if (tag === "AsyncFunction" || tag === "GeneratorFunction" || tag === "AsyncGeneratorFunction") type = tag;
    let out = `[${type}`;
    out += fn.name ? `: ${fn.name}]` : " (anonymous)]";
    if (name === null) out += " [null prototype]";
    return out;
  }

  function formatError(err) {
    const stack = typeof err.stack === "string" ? err.stack : Error.prototype.toString.call(err);
    const cause = err.cause !== undefined && Object.prototype.hasOwnProperty.call(err, "cause")
      ? `\n  [cause]: ${inspect(err.cause).replaceAll("\n", "\n  ")}`
      : "";
    return stack.includes("\n    at ") || !cause ? stack + cause : `[${stack}]${cause}`;
  }

  function formatObjectEntries() {
    return [];
  }

  function formatPromise(ctx, value, recurseTimes) {
    const details = globalThis.Deno?.core?.getPromiseDetails?.(value);
    if (!details || details[0] === 0) return ["<pending>"];
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, details[1], recurseTimes);
    ctx.indentationLvl -= 2;
    return [details[0] === 2 ? `<rejected> ${str}` : str];
  }

  function formatArray(ctx, value, recurseTimes) {
    const len = value.length;
    const max = Math.min(ctx.maxArrayLength, len);
    const output = [];
    let holes = 0;
    for (let i = 0; i < len && output.length < max; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        holes++;
        continue;
      }
      if (holes > 0) {
        output.push(`<${holes} empty item${holes > 1 ? "s" : ""}>`);
        holes = 0;
        if (output.length >= max) break;
      }
      output.push(formatProperty(ctx, value, recurseTimes, i, true));
    }
    if (holes > 0 && output.length < max) output.push(`<${holes} empty item${holes > 1 ? "s" : ""}>`);
    const remaining = len - max;
    if (remaining > 0 && output.length >= max) output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
    return output;
  }

  function formatTypedArray(ctx, value) {
    const max = Math.min(ctx.maxArrayLength, value.length);
    const output = [];
    for (let i = 0; i < max; i++) output.push(formatPrimitive(ctx, value[i]));
    const remaining = value.length - max;
    if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? "s" : ""}`);
    return output;
  }

  function formatSet(ctx, value, recurseTimes) {
    ctx.indentationLvl += 2;
    const output = [];
    for (const v of value) output.push(formatValue(ctx, v, recurseTimes));
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatMap(ctx, value, recurseTimes) {
    ctx.indentationLvl += 2;
    const output = [];
    for (const [k, v] of value) {
      output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`);
    }
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatProperty(ctx, value, recurseTimes, key, isArrayEntry) {
    // Keys without an own descriptor are prototype getters surfaced on
    // purpose (ArrayBuffer byteLength, ...): shown like hidden properties.
    const desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key], enumerable: false };
    let str;
    if (desc.value !== undefined || !("get" in desc || "set" in desc)) {
      const diff = ctx.compact === true && !isArrayEntry ? 3 : 2;
      ctx.indentationLvl += diff;
      str = formatValue(ctx, desc.value, recurseTimes);
      ctx.indentationLvl -= diff;
    } else if (desc.get !== undefined) {
      str = desc.set !== undefined ? "[Getter/Setter]" : "[Getter]";
      if (ctx.getters) {
        try {
          str = `${str.slice(0, -1)}: ${formatValue(ctx, desc.get.call(value), recurseTimes)}]`;
        } catch (err) {
          str = `${str.slice(0, -1)}: <Inspection threw (${err.message})>]`;
        }
      }
    } else {
      str = desc.set !== undefined ? "[Setter]" : "undefined";
    }
    if (isArrayEntry && typeof key === "number") return str;
    const name = desc.enumerable === false ? `[${formatKey(key)}]` : formatKey(key);
    return `${name}: ${str}`;
  }

  function isBelowBreakLength(ctx, output, start, base) {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength) return false;
    for (const entry of output) {
      totalLength += entry.length;
      if (totalLength > ctx.breakLength) return false;
    }
    return base === "" || !base.includes("\n");
  }

  function reduceToSingleString(ctx, output, base, braces, extrasArray, recurseTimes, value) {
    if (ctx.compact >= 1) {
      const entries = output.length;
      if (extrasArray && entries > 6) output = groupArrayElements(ctx, output, value);
      if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
        const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joined = output.join(", ");
          if (!joined.includes("\n")) {
            return `${base ? `${base} ` : ""}${braces[0]} ${joined} ${braces[1]}`;
          }
        }
      }
    }
    const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
  }

  // Lay out long arrays of short entries in aligned columns (Node's
  // groupArrayElements).
  function groupArrayElements(ctx, output, value) {
    let totalLength = 0;
    let maxLength = 0;
    let outputLength = output.length;
    if (ctx.maxArrayLength < output.length) outputLength--;
    const separatorSpace = 2;
    const dataLen = new Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const len = output[i].length;
      dataLen[i] = len;
      totalLength += len + separatorSpace;
      if (maxLength < len) maxLength = len;
    }
    const actualMax = maxLength + separatorSpace;
    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
      const averageBias = Math.sqrt(actualMax - totalLength / output.length);
      const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
      const columns = Math.min(
        Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
        Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
        ctx.compact * 4,
        15,
      );
      if (columns <= 1) return output;
      const tmp = [];
      const maxLineLength = [];
      for (let i = 0; i < columns; i++) {
        let lineLength = 0;
        for (let j = i; j < output.length; j += columns) {
          if (dataLen[j] > lineLength) lineLength = dataLen[j];
        }
        maxLineLength.push(lineLength + separatorSpace);
      }
      let padStart = true;
      if (value !== undefined) {
        for (let i = 0; i < output.length; i++) {
          if (typeof value[i] !== "number" && typeof value[i] !== "bigint") {
            padStart = false;
            break;
          }
        }
      }
      for (let i = 0; i < outputLength; i += columns) {
        const max = Math.min(i + columns, outputLength);
        let str = "";
        let j = i;
        for (; j < max - 1; j++) {
          const cell = `${output[j]}, `;
          str += padStart ? cell.padStart(maxLineLength[j - i], " ") : cell.padEnd(maxLineLength[j - i], " ");
        }
        str += padStart ? output[j].padStart(maxLineLength[j - i] - separatorSpace, " ") : output[j];
        tmp.push(str);
      }
      if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);
      output = tmp;
    }
    return output;
  }

  // Node's ERR_INVALID_ARG_TYPE message: `... Received type number (5)`.
  function describeReceived(value) {
    if (value === null || value === undefined) return String(value);
    switch (typeof value) {
      case "bigint":
        return `type bigint (${value}n)`;
      case "number":
        return `type number (${formatPrimitive(DEFAULTS, value)})`;
      case "boolean":
        return `type boolean (${value})`;
      case "symbol":
        return `type symbol (${String(value)})`;
      case "function":
        return `function ${value.name}`;
      case "object":
        return value.constructor && "name" in value.constructor
          ? `an instance of ${value.constructor.name}`
          : inspect(value, { depth: -1 });
      case "string": {
        const s = value.length > 28 ? `${value.slice(0, 25)}...` : value;
        return s.includes("'") ? `type string (${JSON.stringify(s)})` : `type string ('${s}')`;
      }
    }
    return String(value);
  }

  function invalidArgType(name, expected, value) {
    const what = name.includes(".") ? "property" : "argument";
    const err = new TypeError(`The "${name}" ${what} must be of type ${expected}. Received ${describeReceived(value)}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    return err;
  }

  function formatNumber(fn, value) {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol") return "NaN";
    return formatPrimitive(DEFAULTS, fn(value));
  }

  // util.format: printf-style %s %d %i %f %j %o %O %c %%, remaining
  // arguments appended (strings as-is, everything else inspected).
  function format(...args) {
    return formatWithOptions(undefined, ...args);
  }

  function formatWithOptions(inspectOptions, ...args) {
    const first = args[0];
    let a = 0;
    let str = "";
    let join = "";
    if (typeof first === "string") {
      if (args.length === 1) return first;
      let lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first.charCodeAt(i) !== 37) continue; // '%'
        const next = first[i + 1];
        if (next === "%") {
          str += first.slice(lastPos, i) + "%";
          lastPos = i + 2;
          i++;
          continue;
        }
        if (a + 1 === args.length) continue;
        let piece;
        const arg = args[a + 1];
        switch (next) {
          case "s":
            if (typeof arg === "number") piece = formatPrimitive(DEFAULTS, arg);
            else if (typeof arg === "bigint") piece = `${arg}n`;
            else if (typeof arg === "object" && arg !== null) piece = inspect(arg, { ...inspectOptions, depth: 0, compact: 3 });
            else piece = String(arg);
            break;
          case "j":
            try {
              piece = JSON.stringify(arg);
            } catch (err) {
              if (!String(err?.message).includes("circular")) throw err;
              piece = "[Circular]";
            }
            break;
          case "d":
            piece = typeof arg === "object" && arg !== null ? "NaN" : formatNumber(Number, arg);
            break;
          case "i":
            piece = typeof arg === "object" && arg !== null ? "NaN" : formatNumber(parseInt, arg);
            break;
          case "f":
            piece = typeof arg === "symbol" ? "NaN" : formatPrimitive(DEFAULTS, parseFloat(arg));
            break;
          case "o":
            piece = inspect(arg, { ...inspectOptions, showHidden: true, depth: 4 });
            break;
          case "O":
            piece = inspect(arg, inspectOptions);
            break;
          case "c":
            piece = "";
            break;
          default:
            continue;
        }
        str += first.slice(lastPos, i) + piece;
        lastPos = i + 2;
        i++;
        a++;
      }
      if (lastPos !== 0) {
        a++;
        join = " ";
        if (lastPos < first.length) str += first.slice(lastPos);
      }
    }
    while (a < args.length) {
      const value = args[a];
      str += join + (typeof value === "string" ? value : inspect(value, inspectOptions));
      join = " ";
      a++;
    }
    return str;
  }

  globalThis.__jse = {
    inspect,
    format,
    formatWithOptions,
    invalidArgType,
    // V8 structured-clone (binary) helpers used for worker/channel messages.
    serialize: (value) =>
      Deno.core.ops.op_serialize(value, undefined, undefined, false, undefined),
    deserialize: (bytes) =>
      Deno.core.ops.op_deserialize(bytes, undefined, undefined, undefined, false),
  };
})(globalThis);
