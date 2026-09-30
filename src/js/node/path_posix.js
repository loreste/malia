// node:path/posix
import { posix } from "node:path";

export const {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
  format,
  toNamespacedPath,
  matchesGlob,
  win32,
} = posix;
export { posix };
export default posix;
