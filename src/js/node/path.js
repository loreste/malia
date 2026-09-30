// node:path shim (posix; win32 is aliased to posix).
const sep = "/";
const delimiter = ":";

function isAbsolute(p) {
  return p.startsWith("/");
}

function normalizeArray(parts, allowAboveRoot) {
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") {
        out.pop();
      } else if (allowAboveRoot) {
        out.push("..");
      }
    } else {
      out.push(part);
    }
  }
  return out;
}

function normalize(p) {
  p = String(p);
  if (p === "") return ".";
  const absolute = isAbsolute(p);
  const trailing = p.length > 1 && p.endsWith("/");
  let parts = normalizeArray(p.split("/"), !absolute);
  let out = parts.join("/");
  if (absolute) out = "/" + out;
  if (out === "") out = absolute ? "/" : ".";
  if (trailing && out !== "/") out += "/";
  return out;
}

function join(...args) {
  const parts = args.filter((a) => a !== undefined && a !== null && String(a) !== "");
  if (parts.length === 0) return ".";
  return normalize(parts.join("/"));
}

function resolve(...args) {
  let resolved = "";
  let absolute = false;
  for (let i = args.length - 1; i >= -1 && !absolute; i--) {
    const part = i >= 0 ? String(args[i]) : process.cwd();
    if (part === "") continue;
    resolved = part + "/" + resolved;
    absolute = part.startsWith("/");
  }
  resolved = normalizeArray(resolved.split("/"), !absolute).join("/");
  return (absolute ? "/" : "") + resolved || ".";
}

function dirname(p) {
  p = String(p);
  if (p === "") return ".";
  const hasRoot = p.startsWith("/");
  const parts = p.split("/").filter((x) => x !== "");
  if (parts.length === 0) return hasRoot ? "/" : ".";
  const end = parts.slice(0, -1).join("/");
  return (hasRoot ? "/" : "") + end || (hasRoot ? "/" : ".");
}

function basename(p, ext) {
  p = String(p);
  const parts = p.split("/").filter((x) => x !== "");
  let base = parts.length ? parts[parts.length - 1] : "";
  if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
  return base;
}

function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

function relative(from, to) {
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";
  const fromParts = from.split("/").filter((x) => x !== "");
  const toParts = to.split("/").filter((x) => x !== "");
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const ups = fromParts.length - common;
  const out = [...new Array(ups).fill(".."), ...toParts.slice(common)];
  return out.join("/") || ".";
}

function parse(p) {
  const dir = dirname(p);
  const base = basename(p);
  const ext = extname(p);
  return { root: isAbsolute(p) ? "/" : "", dir, base, ext, name: base.slice(0, base.length - ext.length) };
}

function format(obj) {
  const dir = obj.dir || obj.root || "";
  const base = obj.base || (obj.name || "") + (obj.ext || "");
  if (!dir) return base;
  return dir === "/" ? "/" + base : dir + "/" + base;
}

const posix = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse, format };
posix.posix = posix;
posix.win32 = posix; // windows paths are not specially handled

export { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse, format, posix };
export const win32 = posix;
export default posix;
