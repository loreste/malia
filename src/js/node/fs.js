// node:fs shim: sync ops plus callback/promise wrappers, pull-based streams.
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import path from "node:path";

const ops = Deno.core.ops;

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(data, encoding) {
  if (typeof data === "string") return Buffer.from(data, encoding ?? "utf8");
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data ?? 0);
}

function encodingOf(options) {
  if (typeof options === "string") return options;
  if (options && typeof options === "object" && typeof options.encoding === "string") return options.encoding;
  return undefined;
}

function callbackize(fn) {
  return function (...args) {
    let cb;
    if (typeof args[args.length - 1] === "function") cb = args.pop();
    const promise = new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          resolve(fn(...args));
        } catch (err) {
          reject(err);
        }
      });
    });
    if (!cb) return promise;
    promise.then(
      (value) => queueMicrotask(() => cb(null, value)),
      (err) => queueMicrotask(() => cb(err)),
    );
  };
}

function flagOf(options, fallback) {
  return (options && typeof options === "object" && options.flag) || fallback;
}

function modeOf(options) {
  return (options && typeof options === "object" && options.mode) || 0o666;
}

// Buffer.toString for every encoding except the utf8 fast path.
function decode(bytes, encoding) {
  return encoding === "buffer" ? asBuffer(bytes) : asBuffer(bytes).toString(encoding);
}

const isUtf8 = (encoding) => encoding === "utf8" || encoding === "utf-8";

export class Stats {}
export class Dirent {
  constructor(name, entry, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this._entry = entry;
  }
  isFile() {
    return this._entry.is_file;
  }
  isDirectory() {
    return this._entry.is_dir;
  }
  isSymbolicLink() {
    return this._entry.is_symlink;
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

function makeStat(raw) {
  const atime = raw.atime_ms ?? raw.mtime_ms;
  const birth = raw.birthtime_ms ?? raw.ctime_ms;
  return Object.assign(Object.create(Stats.prototype), {
    size: raw.size,
    ino: raw.ino,
    mode: raw.mode ?? 0,
    uid: raw.uid ?? 0,
    gid: raw.gid ?? 0,
    nlink: raw.nlink ?? 1,
    dev: raw.dev ?? 0,
    rdev: raw.rdev ?? 0,
    blksize: raw.blksize ?? 0,
    blocks: raw.blocks ?? 0,
    mtime: new Date(raw.mtime_ms),
    mtimeMs: raw.mtime_ms,
    ctime: new Date(raw.ctime_ms),
    ctimeMs: raw.ctime_ms,
    atime: new Date(atime),
    atimeMs: atime,
    birthtime: new Date(birth),
    birthtimeMs: birth,
    isFile: () => raw.is_file,
    isDirectory: () => raw.is_dir,
    isSymbolicLink: () => !!raw.is_symlink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  });
}

function dirent(entry, parentPath) {
  return new Dirent(entry.name, entry, parentPath);
}

export function readFileSync(path, options) {
  const encoding = encodingOf(options);
  const p = String(path);
  if (encoding && isUtf8(encoding)) return ops.op_read_text_file_sync(p);
  const bytes = ops.op_read_file_bytes_sync(p);
  return encoding ? decode(bytes, encoding) : asBuffer(bytes);
}

// Writes through a file descriptor so any open flag (a, wx, a+, ...) works.
function writeAllSync(p, bytes, flag, mode) {
  const fd = openSync(p, flag, mode);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  } finally {
    closeSync(fd);
  }
}

export function writeFileSync(path, data, options) {
  const p = String(path);
  const flag = flagOf(options, "w");
  const encoding = encodingOf(options);
  if (flag !== "w") return writeAllSync(p, toBytes(data, encoding), flag, modeOf(options));
  if (typeof data === "string" && (!encoding || isUtf8(encoding))) ops.op_write_text_file_sync(p, data);
  else ops.op_write_file_bytes_sync(p, toBytes(data, encoding));
}

export function appendFileSync(path, data, options) {
  const flag = flagOf(options, "a");
  if (flag !== "a") return writeAllSync(String(path), toBytes(data, encodingOf(options)), flag, modeOf(options));
  ops.op_append_bytes_sync(String(path), toBytes(data, encodingOf(options)));
}

export function existsSync(path) {
  try {
    return ops.op_exists_sync(String(path));
  } catch {
    return false;
  }
}

function statOrUndefined(fn, path, options) {
  try {
    return makeStat(fn(String(path)));
  } catch (err) {
    if (options?.throwIfNoEntry === false && (err.code === "ENOENT" || err.code === "ENOTDIR")) return undefined;
    throw err;
  }
}

export function statSync(path, options) {
  return statOrUndefined(ops.op_stat_sync, path, options);
}

export function lstatSync(path, options) {
  return statOrUndefined(ops.op_lstat_sync, path, options);
}

function listDir(read, dir, options) {
  const root = String(dir);
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of read(current)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (options?.withFileTypes) out.push(dirent(entry, current));
      else out.push(options?.encoding === "buffer" ? Buffer.from(rel) : rel);
      if (options?.recursive && entry.is_dir) walk(`${current}/${entry.name}`, rel);
    }
  };
  walk(root, "");
  return out;
}

export function readdirSync(path, options) {
  return listDir(ops.op_readdir_sync, path, typeof options === "string" ? { encoding: options } : options);
}

// Returns the first directory created (recursive) or undefined, as Node does.
function firstMissingDir(p) {
  let first;
  for (let dir = path.resolve(p); !existsSync(dir); dir = path.dirname(dir)) {
    first = dir;
    if (dir === path.dirname(dir)) break;
  }
  return first;
}

export function mkdirSync(p, options) {
  const recursive = !!(options && typeof options === "object" && options.recursive);
  const first = recursive ? firstMissingDir(String(p)) : undefined;
  ops.op_mkdir_sync(String(p), recursive);
  return first;
}

class SystemError extends Error {
  get name() {
    return "SystemError";
  }
}

function isDirError(p) {
  const err = new SystemError(`Path is a directory: rm returned EISDIR (is a directory) ${p}`);
  err.code = "ERR_FS_EISDIR";
  err.errno = 21;
  err.syscall = "rm";
  err.path = p;
  return err;
}

export function rmSync(path, options = {}) {
  const p = String(path);
  if (!options.recursive && statOrUndefined(ops.op_lstat_sync, p, { throwIfNoEntry: false })?.isDirectory()) {
    throw isDirError(p);
  }
  ops.op_remove_sync(p, 2, !!options.recursive, !!options.force);
}

export function unlinkSync(path) {
  ops.op_remove_sync(String(path), 0, false, false);
}

export function rmdirSync(path) {
  ops.op_remove_sync(String(path), 1, false, false);
}

export function renameSync(from, to) {
  ops.op_rename_sync(String(from), String(to));
}

export function copyFileSync(from, to, mode = 0) {
  ops.op_copy_file_sync(String(from), String(to), (mode & constants.COPYFILE_EXCL) !== 0);
}

export function utimesSync(path, atime, mtime) {
  ops.op_utimes_sync(String(path), toSeconds(atime), toSeconds(mtime));
}

function toSeconds(time) {
  if (time instanceof Date) return time.getTime() / 1000;
  if (typeof time === "string") return Number(time);
  return time;
}

export function linkSync(existingPath, newPath) {
  ops.op_link_sync(String(existingPath), String(newPath));
}

// fs.cpSync: files, directories (with recursive), and symlinks.
export function cpSync(src, dest, options = {}) {
  const { recursive = false, force = true, errorOnExist = false, filter, dereference = false } = options;
  const copy = (from, to) => {
    if (filter && !filter(from, to)) return;
    const st = dereference ? statSync(from) : lstatSync(from);
    if (st.isDirectory()) {
      if (!recursive) {
        const err = new SystemError(`Recursive option is required to copy a directory: cp returned EISDIR (${from} is a directory (not copied)) ${from}`);
        err.code = "ERR_FS_EISDIR";
        throw err;
      }
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) copy(path.join(from, name), path.join(to, name));
    } else if (st.isSymbolicLink()) {
      if (existsSync(to) || lstatSync(to, { throwIfNoEntry: false })) {
        if (!force) return;
        unlinkSync(to);
      }
      symlinkSync(readlinkSync(from), to);
    } else if (lstatSync(to, { throwIfNoEntry: false })) {
      if (force) copyFileSync(from, to);
      else if (errorOnExist) copyFileSync(from, to, constants.COPYFILE_EXCL);
    } else {
      copyFileSync(from, to);
    }
  };
  copy(String(src), String(dest));
}

export class Dir {
  #entries;
  #index = 0;
  constructor(dirPath, entries) {
    this.path = dirPath;
    this.#entries = entries;
  }
  readSync() {
    return this.#entries[this.#index++] ?? null;
  }
  async read() {
    return this.readSync();
  }
  closeSync() {}
  async close() {}
  async *[Symbol.asyncIterator]() {
    for (let entry = this.readSync(); entry !== null; entry = this.readSync()) yield entry;
  }
}

export function opendirSync(dirPath) {
  const p = String(dirPath);
  return new Dir(p, ops.op_readdir_sync(p).map((entry) => dirent(entry, p)));
}

export function realpathSync(path) {
  return ops.op_realpath_sync(String(path));
}

export function accessSync(path, mode = 0) {
  ops.op_access_sync(String(path), mode >>> 0);
}

export function chmodSync(path, mode) {
  ops.op_chmod_sync(String(path), mode >>> 0);
}

export function truncateSync(path, len = 0) {
  ops.op_truncate_sync(String(path), len);
}

export function symlinkSync(target, link) {
  ops.op_symlink_sync(String(target), String(link));
}

export function readlinkSync(path) {
  return ops.op_readlink_sync(String(path));
}

export function mkdtempSync(prefix) {
  return ops.op_mkdtemp_sync(String(prefix));
}

async function readFileInner(path, options) {
  const encoding = encodingOf(options);
  const p = String(path);
  if (encoding && isUtf8(encoding)) return ops.op_read_text_file(p);
  const bytes = await ops.op_read_file_bytes(p);
  return encoding ? decode(bytes, encoding) : asBuffer(bytes);
}

async function writeFileInner(path, data, options) {
  const p = String(path);
  const flag = flagOf(options, "w");
  const encoding = encodingOf(options);
  if (flag !== "w") return writeAllSync(p, toBytes(data, encoding), flag, modeOf(options));
  if (typeof data === "string" && (!encoding || isUtf8(encoding))) await ops.op_write_text_file(p, data);
  else await ops.op_write_file_bytes(p, toBytes(data, encoding));
}

export const readFile = callbackize(readFileInner);
export const writeFile = callbackize(writeFileInner);
export const appendFile = callbackize(async (path, data, options) => {
  const flag = flagOf(options, "a");
  if (flag !== "a") return writeAllSync(String(path), toBytes(data, encodingOf(options)), flag, modeOf(options));
  await ops.op_append_bytes(String(path), toBytes(data, encodingOf(options)));
});
export const stat = callbackize(async (path, options) => {
  try {
    return makeStat(await ops.op_stat(String(path)));
  } catch (err) {
    if (options?.throwIfNoEntry === false && err.code === "ENOENT") return undefined;
    throw err;
  }
});
export const lstat = callbackize(async (path) => makeStat(await ops.op_lstat(String(path))));
export const readdir = callbackize(async (path, options) => {
  options = typeof options === "string" ? { encoding: options } : options;
  // ponytail: recursive listing walks synchronously; make it async if huge
  // trees show up in profiles.
  if (options?.recursive) return listDir(ops.op_readdir_sync, path, options);
  const p = String(path);
  const entries = await ops.op_readdir(p);
  if (options?.withFileTypes) return entries.map((entry) => dirent(entry, p));
  return entries.map((entry) => (options?.encoding === "buffer" ? Buffer.from(entry.name) : entry.name));
});
export const mkdir = callbackize(async (p, options) => {
  const recursive = !!(options && typeof options === "object" && options.recursive);
  const first = recursive ? firstMissingDir(String(p)) : undefined;
  await ops.op_mkdir(String(p), recursive);
  return first;
});
export const rm = callbackize(async (path, options = {}) => {
  const p = String(path);
  if (!options.recursive && statOrUndefined(ops.op_lstat_sync, p, { throwIfNoEntry: false })?.isDirectory()) {
    throw isDirError(p);
  }
  await ops.op_remove(p, 2, !!options.recursive, !!options.force);
});
export const unlink = callbackize(async (path) => {
  await ops.op_remove(String(path), 0, false, false);
});
export const rmdir = callbackize(async (path) => {
  await ops.op_remove(String(path), 1, false, false);
});
export const rename = callbackize(async (from, to) => {
  await ops.op_rename(String(from), String(to));
});
export const copyFile = callbackize(async (from, to, mode = 0) => {
  await ops.op_copy_file(String(from), String(to), (mode & constants.COPYFILE_EXCL) !== 0);
});
export const utimes = callbackize(async (path, atime, mtime) => {
  await ops.op_utimes(String(path), toSeconds(atime), toSeconds(mtime));
});
export const link = callbackize(async (existingPath, newPath) => {
  await ops.op_link(String(existingPath), String(newPath));
});
export const cp = callbackize(async (src, dest, options) => cpSync(src, dest, options));
export const opendir = callbackize(async (dirPath) => opendirSync(dirPath));
export function exists(path, cb) {
  queueMicrotask(() => cb(existsSync(path)));
}
export const realpath = callbackize(async (path) => ops.op_realpath(String(path)));
export const access = callbackize(async (path, mode = 0) => {
  await ops.op_access(String(path), mode >>> 0);
});
export const chmod = callbackize(async (path, mode) => {
  await ops.op_chmod(String(path), mode >>> 0);
});
export const truncate = callbackize(async (path, len = 0) => {
  await ops.op_truncate(String(path), len);
});
export const symlink = callbackize(async (target, link) => {
  await ops.op_symlink(String(target), String(link));
});
export const readlink = callbackize(async (path) => ops.op_readlink(String(path)));
export const mkdtemp = callbackize(async (prefix) => ops.op_mkdtemp(String(prefix)));

// Node's `end` is inclusive. Each pull is 64KB and runs off the isolate,
// so a listener attached later still sees the bytes and timers keep firing.
// `_read` returns without pushing; the promise pushes when the bytes arrive.
export function createReadStream(path, options = {}) {
  const start = options.start ?? 0;
  const end = options.end;
  const file = String(path);
  const stream = new Readable({
    read() {
      if (this._left <= 0) {
        this.push(null);
        return;
      }
      const len = Math.min(this._left, 64 * 1024);
      const pos = this._pos;
      const self = this;
      ops.op_read_range_at(file, pos, len).then(
        (bytes) => {
          if (self.destroyed) return;
          if (!bytes || bytes.byteLength === 0) {
            self.push(null);
            return;
          }
          self._pos += bytes.byteLength;
          self._left -= bytes.byteLength;
          self.push(asBuffer(bytes));
          if (self._left <= 0) self.push(null);
        },
        (err) => {
          if (!self.destroyed) self.destroy(err);
        },
      );
    },
  });
  stream._pos = start;
  stream._left = end === undefined ? Number.POSITIVE_INFINITY : end - start + 1;
  return stream;
}

export function createWriteStream(path, options = {}) {
  const flags = options.flags || "w";
  const file = String(path);
  let started = false;
  return new Writable({
    write(chunk, encoding, cb) {
      const bytes = toBytes(chunk, encoding);
      const first = !started && flags !== "a";
      started = true;
      const op = first ? ops.op_write_file_bytes(file, bytes) : ops.op_append_bytes(file, bytes);
      op.then(() => cb(), (err) => cb(err));
    },
    final(cb) {
      if (started) {
        cb();
        return;
      }
      const empty = new Uint8Array(0);
      const op = flags === "a" ? ops.op_append_bytes(file, empty) : ops.op_write_file_bytes(file, empty);
      op.then(() => cb(), (err) => cb(err));
    },
  });
}

export const constants = {
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  ...ops.op_fs_constants(),
};
export const { F_OK = 0, R_OK = 4, W_OK = 2, X_OK = 1 } = constants;

export function openSync(filePath, flags = "r", mode = 0o666) {
  const f = typeof flags === "number" ? flagsToString(flags) : String(flags || "r");
  return ops.op_fs_open(String(filePath), f, mode);
}

function flagsToString(flags) {
  if ((flags & constants.O_RDWR) === constants.O_RDWR) return "r+";
  if ((flags & constants.O_WRONLY) === constants.O_WRONLY) {
    if (flags & constants.O_APPEND) return "a";
    return "w";
  }
  return "r";
}

export function closeSync(fd) {
  ops.op_fs_close(fd);
}

export function fstatSync(fd) {
  return makeStat(ops.op_fs_fstat(fd));
}

export function ftruncateSync(fd, len = 0) {
  ops.op_fs_ftruncate(fd, len);
}

export function fsyncSync(fd) {
  ops.op_fs_fsync(fd);
}

export function readSync(fd, buffer, offset = 0, length = buffer ? buffer.byteLength - offset : 0, position = null) {
  if (!buffer || !ArrayBuffer.isView(buffer)) {
    throw new TypeError("buffer must be a TypedArray or Buffer");
  }
  const pos = position === null || position === undefined ? -1.0 : Number(position);
  const bytes = ops.op_fs_read(fd, length, pos);
  const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
  target.set(bytes.subarray(0, length));
  return bytes.byteLength;
}

export function writeSync(fd, buffer, offset = 0, length = buffer ? buffer.byteLength - offset : 0, position = null) {
  let toWrite;
  if (typeof buffer === "string") {
    toWrite = Buffer.from(buffer, typeof offset === "string" ? offset : "utf8");
    const pos = typeof length === "number" ? length : -1.0;
    return ops.op_fs_write(fd, toWrite, pos);
  }
  if (!buffer || !ArrayBuffer.isView(buffer)) {
    throw new TypeError("buffer must be a TypedArray or Buffer");
  }
  const pos = position === null || position === undefined ? -1.0 : Number(position);
  toWrite = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
  return ops.op_fs_write(fd, toWrite, pos);
}

export const open = callbackize(openSync);
export const close = callbackize(closeSync);
export const fstat = callbackize(fstatSync);
export const ftruncate = callbackize(ftruncateSync);
export const fsync = callbackize(fsyncSync);
export const read = callbackize(readSync);
export const write = callbackize(writeSync);

export class FileHandle extends EventEmitter {
  #fd;
  constructor(fd) {
    super();
    this.#fd = fd;
  }
  get fd() {
    return this.#fd;
  }
  async read(buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
    const bytesRead = readSync(this.#fd, buffer, offset, length, position);
    return { bytesRead, buffer };
  }
  async write(buffer, offset = 0, length = buffer ? buffer.byteLength - offset : 0, position = null) {
    const bytesWritten = writeSync(this.#fd, buffer, offset, length, position);
    return { bytesWritten, buffer };
  }
  async stat() {
    return fstatSync(this.#fd);
  }
  async truncate(len = 0) {
    ftruncateSync(this.#fd, len);
  }
  async sync() {
    fsyncSync(this.#fd);
  }
  async close() {
    closeSync(this.#fd);
  }
  async [Symbol.asyncDispose]() {
    return this.close();
  }
}

export class FSWatcher extends EventEmitter {
  #path;
  #closed = false;
  #id = null;

  constructor(filename, options = {}, listener) {
    super();
    this.#path = String(filename);
    if (typeof options === "function") {
      listener = options;
      options = {};
    }
    if (typeof listener === "function") {
      this.on("change", listener);
    }
    const recursive = !!options.recursive;
    try {
      this.#id = ops.op_fs_watch(this.#path, recursive);
      this.#pump();
    } catch {
      // Fallback: polling if native watch fails.
      this.#pollFallback(options.interval || 200);
    }
  }

  #pump() {
    if (this.#closed || this.#id === null) return;
    ops.op_fs_watch_poll(this.#id).then(
      (event) => {
        if (!event || this.#closed) return;
        this.emit("change", event.kind, event.filename || path.basename(this.#path));
        this.#pump();
      },
      () => {},
    );
  }

  #pollFallback(interval) {
    let lastStat;
    try { lastStat = statSync(this.#path); } catch { lastStat = null; }
    const timer = setInterval(() => {
      if (this.#closed) { clearInterval(timer); return; }
      let curr;
      try { curr = statSync(this.#path); } catch { curr = null; }
      if (!lastStat && curr) { lastStat = curr; this.emit("change", "rename", path.basename(this.#path)); }
      else if (lastStat && !curr) { lastStat = null; this.emit("change", "rename", path.basename(this.#path)); }
      else if (lastStat && curr && (lastStat.mtimeMs !== curr.mtimeMs || lastStat.size !== curr.size)) {
        lastStat = curr; this.emit("change", "change", path.basename(this.#path));
      }
    }, interval);
    this._fallbackTimer = timer;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#id !== null) { ops.op_fs_watch_close(this.#id); this.#id = null; }
    if (this._fallbackTimer) { clearInterval(this._fallbackTimer); this._fallbackTimer = null; }
    this.emit("close");
  }

  ref() { return this; }
  unref() { return this; }
}

export function watch(filename, options, listener) {
  return new FSWatcher(filename, options, listener);
}

const watchedFiles = new Map();

export function watchFile(filename, options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  const file = path.resolve(String(filename));
  let entry = watchedFiles.get(file);
  if (!entry) {
    let lastStat;
    try {
      lastStat = statSync(file);
    } catch {
      lastStat = makeStat({ mtime_ms: 0, ctime_ms: 0, size: 0, ino: 0 });
    }
    const interval = options.interval || 5007;
    const listeners = new Set();
    const timer = setInterval(() => {
      let curr;
      try {
        curr = statSync(file);
      } catch {
        curr = makeStat({ mtime_ms: 0, ctime_ms: 0, size: 0, ino: 0 });
      }
      const prev = entry.lastStat;
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size || curr.ino !== prev.ino) {
        entry.lastStat = curr;
        for (const fn of entry.listeners) {
          try {
            fn(curr, prev);
          } catch (e) {
            console.error("watchFile listener error:", e);
          }
        }
      }
    }, interval);
    entry = { timer, listeners, lastStat };
    watchedFiles.set(file, entry);
  }
  if (typeof listener === "function") {
    entry.listeners.add(listener);
  }
}

export function unwatchFile(filename, listener) {
  const file = path.resolve(String(filename));
  const entry = watchedFiles.get(file);
  if (!entry) return;
  if (typeof listener === "function") {
    entry.listeners.delete(listener);
  } else {
    entry.listeners.clear();
  }
  if (entry.listeners.size === 0) {
    clearInterval(entry.timer);
    watchedFiles.delete(file);
  }
}

export const promises = {
  open: async (filePath, flags, mode) => {
    const fd = openSync(filePath, flags, mode);
    return new FileHandle(fd);
  },
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
  constants,
};

export default {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readFile,
  writeFile,
  appendFile,
  existsSync,
  statSync,
  lstatSync,
  stat,
  lstat,
  readdirSync,
  readdir,
  mkdirSync,
  mkdir,
  rmSync,
  rm,
  unlinkSync,
  unlink,
  rmdirSync,
  rmdir,
  renameSync,
  rename,
  copyFileSync,
  copyFile,
  realpathSync,
  realpath,
  accessSync,
  access,
  chmodSync,
  chmod,
  truncateSync,
  truncate,
  symlinkSync,
  symlink,
  readlinkSync,
  readlink,
  mkdtempSync,
  mkdtemp,
  utimesSync,
  utimes,
  linkSync,
  link,
  cpSync,
  cp,
  opendirSync,
  opendir,
  exists,
  Stats,
  Dirent,
  Dir,
  openSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  readSync,
  writeSync,
  open,
  close,
  fstat,
  ftruncate,
  fsync,
  read,
  write,
  FileHandle,
  FSWatcher,
  watch,
  watchFile,
  unwatchFile,
  createReadStream,
  createWriteStream,
  constants,
  promises,
};

