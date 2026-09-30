// node:fs/promises re-exports the promise forms from node:fs.
import { promises } from "node:fs";

export const {
  readFile,
  writeFile,
  appendFile,
  stat,
  lstat,
  readdir,
  mkdir,
  rm,
  unlink,
  rmdir,
  rename,
  copyFile,
  realpath,
  access,
  chmod,
  truncate,
  symlink,
  readlink,
  mkdtemp,
  utimes,
  link,
  cp,
  opendir,
  open,
  constants,
} = promises;

export default promises;
