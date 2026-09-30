// node:path/win32
import { win32 } from "node:path";

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
  posix,
} = win32;
export { win32 };
export default win32;
