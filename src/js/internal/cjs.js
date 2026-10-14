// Helpers injected into every wrapped CommonJS module.
const cjsCache = new Map();
// Node-compatible cache keyed by absolute filename. Deletions propagate
// to cjsCache so require() reloads the module (hot-reload, test runners).
const cjsCacheObj = new Proxy({}, {
  deleteProperty(target, prop) {
    // Find and remove from cjsCache too.
    for (const [url, mod] of cjsCache) {
      if (mod.filename === prop || url === prop) { cjsCache.delete(url); break; }
    }
    return Reflect.deleteProperty(target, prop);
  },
});

export function __initCjs(url, bodyFn, modules, urls) {
  if (cjsCache.has(url)) {
    return cjsCache.get(url).exports;
  }
  return __execCjs(url, bodyFn, modules, urls);
}

function __execCjs(url, bodyFn, modules, urls) {
  if (cjsCache.has(url)) {
    return cjsCache.get(url).exports;
  }
  const filename = __filenameOf(url);
  // Node sets module.id to "." and process.mainModule only for the entry CJS file.
  const argv1 = typeof globalThis.process === "object" && globalThis.process.argv?.[1];
  const isEntry = argv1 && filename && (filename === argv1 || filename.endsWith(argv1));
  const mod = { exports: {}, id: isEntry ? "." : filename, filename, loaded: false };
  cjsCache.set(url, mod);
  if (filename) cjsCacheObj[filename] = mod;
  if (isEntry) globalThis.process.mainModule = mod;

  const req = __makeRequire(url, modules, urls);
  const dirname = __dirnameOf(url);

  try {
    bodyFn.call(mod.exports, mod, mod.exports, req, filename, dirname);
  } catch (err) {
    cjsCache.delete(url);
    if (filename) delete cjsCacheObj[filename];
    throw err;
  }
  mod.loaded = true;

  return mod.exports;
}

// Builtin lookup for runtime require(), registered (from node:module) by
// modules that contain computed require() calls; see wrap_cjs in loader.rs.
let runtimeBuiltin = null;
export function __registerBuiltins(fn) {
  runtimeBuiltin ??= fn;
}

// require.extensions, shared with Module._extensions (the same object, as in
// Node). Loader hooks such as Next.js's next.config.ts support wrap '.js'.
export function __extensions() {
  const key = Symbol.for("malia.require.extensions");
  if (!globalThis[key]) {
    const compile = (module, filename) => {
      const code = Deno.core.ops.op_read_text_file_sync(filename);
      const dirname = filename.replace(/[/\\][^/\\]*$/, "");
      const req = __makeRequire("file://" + filename, {}, {});
      new Function("exports", "require", "module", "__filename", "__dirname", code)(module.exports, req, module, filename, dirname);
    };
    Object.defineProperty(globalThis, key, {
      value: {
        ".js": compile,
        ".cjs": compile,
        ".json": (module, filename) => {
          module.exports = JSON.parse(Deno.core.ops.op_read_text_file_sync(filename));
        },
        ".node": (_module, filename) => {
          throw Object.assign(new Error("Cannot load native addon " + filename + ": native addons are not supported"), { code: "ERR_DLOPEN_FAILED" });
        },
      },
    });
  }
  return globalThis[key];
}

export function __makeRequire(parentUrl, modules, urls) {
  function require(spec) {
    if (Object.prototype.hasOwnProperty.call(urls, spec)) {
      const targetUrl = urls[spec];
      if (targetUrl === "jse:internal/cjs-missing") {
        throw Object.assign(new Error("Cannot find module '" + spec + "'"), { code: "MODULE_NOT_FOUND" });
      }
      if (cjsCache.has(targetUrl)) {
        return cjsCache.get(targetUrl).exports;
      }
      if (Object.prototype.hasOwnProperty.call(modules, spec)) {
        const ns = modules[spec];
        if (ns && typeof ns.__jse_body === "function") {
          const modMap = typeof ns.__jse_modules === "function" ? ns.__jse_modules() : (ns.__jse_modules || {});
          const urlMap = typeof ns.__jse_urls === "function" ? ns.__jse_urls() : (ns.__jse_urls || {});
          return __execCjs(targetUrl, ns.__jse_body, modMap, urlMap);
        }
        return ns !== null && typeof ns === "object" && "default" in ns ? ns.default : ns;
      }
    }
    if (Object.prototype.hasOwnProperty.call(modules, spec)) {
      const ns = modules[spec];
      return ns !== null && typeof ns === "object" && "default" in ns ? ns.default : ns;
    }
    // Dynamic require: resolve at runtime via the native op, then load by
    // extension (JSON parsed, native addons rejected). Only resolution
    // failures are MODULE_NOT_FOUND; errors from the module body propagate.
    let resolved;
    try {
      resolved = Deno.core.ops.op_require_resolve(spec, __filenameOf(parentUrl));
    } catch {
      throw Object.assign(
        new Error("Cannot find module '" + spec + "' required from " + parentUrl),
        { code: "MODULE_NOT_FOUND" },
      );
    }
    if (resolved.startsWith("node:")) {
      const builtin = runtimeBuiltin && runtimeBuiltin(resolved);
      if (builtin === undefined || builtin === null) {
        throw Object.assign(new Error("Cannot find module '" + spec + "' required from " + parentUrl), { code: "MODULE_NOT_FOUND" });
      }
      return builtin;
    }
    if (cjsCache.has(resolved)) return cjsCache.get(resolved).exports;
    const mod = { exports: {}, id: resolved, filename: resolved, loaded: false };
    cjsCache.set(resolved, mod);
    cjsCacheObj[resolved] = mod;
    const exts = __extensions();
    const dot = resolved.lastIndexOf(".");
    const load = (dot > resolved.lastIndexOf("/") && exts[resolved.slice(dot)]) || exts[".js"];
    try {
      load(mod, resolved);
    } catch (err) {
      cjsCache.delete(resolved);
      delete cjsCacheObj[resolved];
      throw err;
    }
    mod.loaded = true;
    return mod.exports;
  }
  // Like Node: a filesystem path, or the bare name for builtins; specifiers the
  // static scan didn't see (computed paths) resolve at runtime.
  require.resolve = (spec) => {
    if (Object.prototype.hasOwnProperty.call(urls, spec)) {
      const url = String(urls[spec]);
      if (url.startsWith("file://")) return __filenameOf(url);
      if (url.startsWith("node:") || url.startsWith("jse:")) return spec;
      return url;
    }
    try {
      return Deno.core.ops.op_require_resolve(spec, __filenameOf(parentUrl));
    } catch {
      throw Object.assign(new Error("Cannot find module '" + spec + "' required from " + parentUrl), { code: "MODULE_NOT_FOUND" });
    }
  };
  require.cache = cjsCacheObj;
  require.extensions = __extensions();
  return require;
}

// Value of a detected named export. Like Node's CommonJS export detection,
// a non-enumerable getter (e.g. a lazy optional dependency) is not read.
export function __namedExport(exp, key) {
  if (exp === null || (typeof exp !== "object" && typeof exp !== "function")) return undefined;
  const desc = Object.getOwnPropertyDescriptor(exp, key);
  if (desc && desc.get && !desc.enumerable) return undefined;
  return exp[key];
}

export function __filenameOf(url) {
  let p = decodeURIComponent(String(url).replace(/^file:\/\/\//, "/").replace(/^file:\/\//, ""));
  // Windows: /C:/... -> C:/...
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

export function __dirnameOf(url) {
  const filename = __filenameOf(url);
  const idx = filename.lastIndexOf("/");
  return idx <= 0 ? "/" : filename.slice(0, idx);
}
