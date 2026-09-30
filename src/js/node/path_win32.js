// node:path/win32 shim
import path from "node:path";

const {
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
  posix,
  win32,
} = path;

export {
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
  posix,
  win32,
};

export default win32;
