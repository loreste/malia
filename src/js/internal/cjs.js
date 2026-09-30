// Helpers injected into every wrapped CommonJS module.
export function __makeRequire(parentUrl, modules, urls) {
  function require(spec) {
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
  require.cache = {};
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
