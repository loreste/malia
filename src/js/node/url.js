// node:url shim: re-exports the URL/URLSearchParams globals plus basic
// fileURLToPath/pathToFileURL helpers.
const { URL, URLSearchParams } = globalThis;

function fileURLToPath(input) {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.protocol !== "file:") {
    throw new TypeError("The URL must be of scheme file:");
  }
  return decodeURIComponent(url.pathname);
}

function pathToFileURL(path) {
  let p = String(path).replaceAll("\\", "/");
  if (!p.startsWith("/")) p = "/" + p;
  const encoded = p
    .split("/")
    .map((seg) => encodeURIComponent(seg).replaceAll("%3A", ":"))
    .join("/");
  return new URL("file://" + encoded);
}

export { URL, URLSearchParams, fileURLToPath, pathToFileURL };
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL };
