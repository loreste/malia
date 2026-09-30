// node:querystring shim: parse/stringify with correct array semantics.
function unescape(str) {
  try {
    return decodeURIComponent(String(str).replaceAll("+", " "));
  } catch {
    return String(str);
  }
}

function escape(str) {
  return encodeURIComponent(String(str));
}

// qs.parse("a=1&a=2&b=") -> { a: ["1", "2"], b: "" }
function parse(str, sep = "&", eq = "=", options = {}) {
  const obj = Object.create(null);
  if (typeof str !== "string" || str === "") return obj;
  const maxKeys = options.maxKeys ?? 1000;
  let keys = 0;
  for (const piece of str.split(sep)) {
    if (piece === "") continue;
    const idx = piece.indexOf(eq);
    const rawKey = idx === -1 ? piece : piece.slice(0, idx);
    const rawValue = idx === -1 ? "" : piece.slice(idx + eq.length);
    const key = unescape(rawKey);
    const value = unescape(rawValue);
    if (maxKeys > 0 && !(key in obj)) {
      keys += 1;
      if (keys > maxKeys) return obj;
    }
    if (key in obj) {
      if (Array.isArray(obj[key])) obj[key].push(value);
      else obj[key] = [obj[key], value];
    } else {
      obj[key] = value;
    }
  }
  return obj;
}

// qs.stringify({ a: ["1", "2"], b: "x", c: null, d: undefined })
//   -> "a=1&a=2&b=x&c="
function stringify(obj, sep = "&", eq = "=", options = {}) {
  if (obj === null || typeof obj !== "object") return "";
  const encode = options.encodeURIComponent ?? escape;
  const parts = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(encode(key) + eq + encode(item ?? ""));
      }
    } else {
      parts.push(encode(key) + eq + encode(value ?? ""));
    }
  }
  return parts.join(sep);
}

export { parse, stringify, escape, unescape };
export const decode = parse;
export const encode = stringify;
export default { parse, stringify, escape, unescape, decode, encode };
