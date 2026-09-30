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

function makeStat(raw) {
  const atime = raw.atime_ms ?? raw.mtime_ms;
  const birth = raw.birthtime_ms ?? raw.ctime_ms;
  return {
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
  };
}

function dirent(entry) {
  return {
    name: entry.name,
    isFile: () => entry.is_file,
    isDirectory: () => entry.is_dir,
    isSymbolicLink: () => entry.is_symlink,
  };
}

export function readFileSync(path, options) {
  const encoding = encodingOf(options);
  const p = String(path);
  if (encoding) return ops.op_read_text_file_sync(p);
  return asBuffer(ops.op_read_file_bytes_sync(p));
}

export function writeFileSync(path, data, options) {
  const p = String(path);
  if (typeof data === "string") ops.op_write_text_file_sync(p, data);
  else ops.op_write_file_bytes_sync(p, toBytes(data, encodingOf(options)));
}

export function appendFileSync(path, data, options) {
  ops.op_append_bytes_sync(String(path), toBytes(data, encodingOf(options)));
}

export function existsSync(path) {
  return ops.op_exists_sync(String(path));
}

export function statSync(path) {
  return makeStat(ops.op_stat_sync(String(path)));
}

export function lstatSync(path) {
  return makeStat(ops.op_lstat_sync(String(path)));
}

export function readdirSync(path, options) {
  const entries = ops.op_readdir_sync(String(path));
  if (options && options.withFileTypes) return entries.map(dirent);
  return entries.map((entry) => entry.name);
}

export function mkdirSync(path, options) {
  const recursive = !!(options && typeof options === "object" && options.recursive);
  ops.op_mkdir_sync(String(path), recursive);
}

export function rmSync(path, options = {}) {
  ops.op_remove_sync(String(path), 2, !!options.recursive, !!options.force);
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

export function copyFileSync(from, to) {
  ops.op_copy_file_sync(String(from), String(to));
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
  if (encoding) return ops.op_read_text_file(p);
  return asBuffer(await ops.op_read_file_bytes(p));
}

async function writeFileInner(path, data, options) {
  const p = String(path);
  if (typeof data === "string") await ops.op_write_text_file(p, data);
  else await ops.op_write_file_bytes(p, toBytes(data, encodingOf(options)));
}

export const readFile = callbackize(readFileInner);
export const writeFile = callbackize(writeFileInner);
export const appendFile = callbackize(async (path, data, options) => {
  await ops.op_append_bytes(String(path), toBytes(data, encodingOf(options)));
});
export const stat = callbackize(async (path) => makeStat(await ops.op_stat(String(path))));
export const lstat = callbackize(async (path) => makeStat(await ops.op_lstat(String(path))));
export const readdir = callbackize(async (path, options) => {
  const entries = await ops.op_readdir(String(path));
  if (options && options.withFileTypes) return entries.map(dirent);
  return entries.map((entry) => entry.name);
});
export const mkdir = callbackize(async (path, options) => {
  const recursive = !!(options && typeof options === "object" && options.recursive);
  await ops.op_mkdir(String(path), recursive);
});
export const rm = callbackize(async (path, options = {}) => {
  await ops.op_remove(String(path), 2, !!options.recursive, !!options.force);
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
export const copyFile = callbackize(async (from, to) => {
  await ops.op_copy_file(String(from), String(to));
});
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
          if (self._rState.destroyed) return;
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
          if (!self._rState.destroyed) self.destroy(err);
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

export const constants = ops.op_fs_constants();

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
  #timer = null;
  #lastStat = null;

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
    const interval = options.interval || 200;
    try {
      this.#lastStat = statSync(this.#path);
    } catch {
      this.#lastStat = null;
    }
    this.#timer = setInterval(() => this.#poll(), interval);
  }

  #poll() {
    if (this.#closed) return;
    let curr;
    try {
      curr = statSync(this.#path);
    } catch {
      curr = null;
    }
    const prev = this.#lastStat;
    if (!prev && curr) {
      this.#lastStat = curr;
      this.emit("change", "rename", path.basename(this.#path));
    } else if (prev && !curr) {
      this.#lastStat = null;
      this.emit("change", "rename", path.basename(this.#path));
    } else if (prev && curr) {
      if (prev.mtimeMs !== curr.mtimeMs || prev.size !== curr.size || prev.ino !== curr.ino) {
        this.#lastStat = curr;
        this.emit("change", "change", path.basename(this.#path));
      }
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.emit("close");
  }

  ref() {
    return this;
  }
  unref() {
    return this;
  }
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

