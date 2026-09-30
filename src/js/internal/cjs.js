// Helpers injected into every wrapped CommonJS module.
const cjsCache = new Map();

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
  const mod = { exports: {} };
  cjsCache.set(url, mod);

  const req = __makeRequire(url, modules, urls);
  const filename = __filenameOf(url);
  const dirname = __dirnameOf(url);

  try {
    bodyFn.call(mod.exports, mod, mod.exports, req, filename, dirname);
  } catch (err) {
    cjsCache.delete(url);
    throw err;
  }

  return mod.exports;
}

export function __makeRequire(parentUrl, modules, urls) {
  function require(spec) {
    if (Object.prototype.hasOwnProperty.call(urls, spec)) {
      const targetUrl = urls[spec];
      if (targetUrl === "jse:internal/cjs-missing") {
        throw new Error("Cannot find module '" + spec + "' required from " + parentUrl);
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
    throw new Error(
      "Cannot find module '" + spec + "' required from " + parentUrl +
        " (only static literal require() calls are supported)",
    );
  }
  require.resolve = (spec) => {
    if (Object.prototype.hasOwnProperty.call(urls, spec)) return urls[spec];
    throw new Error("Cannot find module '" + spec + "'");
  };
  require.cache = cjsCache;
  return require;
}

export function __filenameOf(url) {
  return decodeURIComponent(String(url).replace(/^file:\/\//, ""));
}

export function __dirnameOf(url) {
  const filename = __filenameOf(url);
  const idx = filename.lastIndexOf("/");
  return idx <= 0 ? "/" : filename.slice(0, idx);
}
