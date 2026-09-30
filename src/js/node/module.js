// node:module — createRequire with support for builtins, JSON, Wasm, CJS, plus Module class.
import { fileURLToPath } from "node:url";

import * as assert from "node:assert";
import * as assertStrict from "node:assert/strict";
import * as async_hooks from "node:async_hooks";
import * as buffer from "node:buffer";
import * as child_process from "node:child_process";
import * as cluster from "node:cluster";
import * as consoleMod from "node:console";
import * as constants from "node:constants";
import * as crypto from "node:crypto";
import * as dgram from "node:dgram";
import * as dns from "node:dns";
import * as dnsPromises from "node:dns/promises";
import * as events from "node:events";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as perf_hooks from "node:perf_hooks";
import * as processMod from "node:process";
import * as querystring from "node:querystring";
import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import * as repl from "node:repl";
import * as sqlite from "node:sqlite";
import * as stream from "node:stream";
import * as streamConsumers from "node:stream/consumers";
import * as streamPromises from "node:stream/promises";
import * as string_decoder from "node:string_decoder";
import * as timers from "node:timers";
import * as timersPromises from "node:timers/promises";
import * as tls from "node:tls";
import * as tty from "node:tty";
import * as url from "node:url";
import * as util from "node:util";
import * as wasi from "node:wasi";
import * as worker_threads from "node:worker_threads";
import * as ws from "node:ws";
import * as zlib from "node:zlib";
import * as diagnostics_channel from "node:diagnostics_channel";
import * as domain from "node:domain";
import * as inspector from "node:inspector";
import * as pathPosix from "node:path/posix";
import * as pathWin32 from "node:path/win32";
import * as punycode from "node:punycode";
import * as streamWeb from "node:stream/web";
import * as testMod from "node:test";
import * as utilTypes from "node:util/types";
import * as v8 from "node:v8";
import * as vm from "node:vm";

const builtins = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "test",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "ws",
  "zlib",
  "sqlite",
];

const BUILTIN_MAP = {
  assert,
  "assert/strict": assertStrict,
  async_hooks,
  buffer,
  child_process,
  cluster,
  console: consoleMod,
  constants,
  crypto,
  dgram,
  diagnostics_channel,
  dns,
  "dns/promises": dnsPromises,
  domain,
  events,
  fs,
  "fs/promises": fsPromises,
  http,
  http2,
  https,
  inspector,
  module: null, // assigned below
  net,
  os,
  path,
  "path/posix": pathPosix,
  "path/win32": pathWin32,
  perf_hooks,
  process: processMod,
  punycode,
  querystring,
  readline,
  "readline/promises": readlinePromises,
  repl,
  sqlite,
  stream,
  "stream/consumers": streamConsumers,
  "stream/promises": streamPromises,
  "stream/web": streamWeb,
  string_decoder,
  test: testMod,
  timers,
  "timers/promises": timersPromises,
  tls,
  tty,
  url,
  util,
  "util/types": utilTypes,
  v8,
  vm,
  wasi,
  worker_threads,
  ws,
  zlib,
};

function parentPath(filename) {
  if (filename instanceof URL) return fileURLToPath(filename);
  const text = String(filename);
  if (text.startsWith("file:")) return fileURLToPath(text);
  return text;
}

export function isBuiltin(spec) {
  const text = String(spec);
  const name = text.startsWith("node:") ? text.slice(5) : text;
  return builtins.includes(name);
}

export const builtinModules = Object.freeze(builtins.slice());

export function createRequire(filename) {
  const dir = path.dirname(parentPath(filename));
  const cache = {};

  function resolve(spec) {
    const text = String(spec);
    if (text.startsWith("node:")) {
      const bare = text.slice(5);
      if (Object.prototype.hasOwnProperty.call(BUILTIN_MAP, bare)) return text;
    }
    if (Object.prototype.hasOwnProperty.call(BUILTIN_MAP, text)) {
      return `node:${text}`;
    }
    const target = path.isAbsolute(text) ? text : path.resolve(dir, text);
    const exts = ["", ".js", ".json", ".wasm", ".cjs", ".mjs", "/index.js", "/index.json"];
    for (const ext of exts) {
      const candidate = target + ext;
      try {
        const stat = Deno.core.ops.op_stat_sync(candidate);
        if (stat && stat.is_file) return candidate;
      } catch (_) {}
    }
    return target;
  }

  function require(spec) {
    const resolved = resolve(spec);
    if (resolved.startsWith("node:")) {
      const bare = resolved.slice(5);
      const mod = BUILTIN_MAP[bare];
      if (mod) {
        if (mod && typeof mod === "object" && "default" in mod && Object.keys(mod).length === 1) {
          return mod.default;
        }
        return mod;
      }
      throw new Error(`Cannot find module '${spec}'`);
    }

    if (cache[resolved]) {
      return cache[resolved].exports;
    }

    if (resolved.endsWith(".json")) {
      const content = Deno.core.ops.op_read_text_file_sync(resolved);
      const parsed = JSON.parse(content);
      cache[resolved] = { exports: parsed };
      return parsed;
    }

    if (resolved.endsWith(".wasm")) {
      const bytes = Deno.core.ops.op_read_file_bytes_sync(resolved);
      const mod = new WebAssembly.Module(bytes);
      const inst = new WebAssembly.Instance(mod);
      cache[resolved] = { exports: inst.exports };
      return inst.exports;
    }

    // CommonJS / JavaScript execution
    const code = Deno.core.ops.op_read_text_file_sync(resolved);
    const module = { exports: {}, id: resolved, filename: resolved, loaded: false };
    cache[resolved] = module;
    const dirname = path.dirname(resolved);
    const childRequire = createRequire(resolved);
    const fn = new Function("exports", "require", "module", "__filename", "__dirname", code);
    fn(module.exports, childRequire, module, resolved, dirname);
    module.loaded = true;
    return module.exports;
  }

  require.resolve = resolve;
  require.cache = cache;
  require.extensions = {
    ".js": () => {},
    ".json": () => {},
    ".wasm": () => {},
  };
  require.main = undefined;
  return require;
}

export class Module {
  constructor(id = "", parent = null) {
    this.id = id;
    this.parent = parent;
    this.filename = id;
    this.children = [];
    this.exports = {};
    this.loaded = false;
  }
}
Module.createRequire = createRequire;
Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module._cache = {};
Module._extensions = {
  ".js": () => {},
  ".json": () => {},
  ".wasm": () => {},
};
Module.builtin = builtins;
Module.syncBuiltinESMExports = function () {};
Module.findSourceMap = function () { return null; };
Module.register = function () {};
Module._nodeModulePaths = function (from) {
  from = path.resolve(from);
  const parts = from.split(path.sep);
  const paths = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "node_modules") continue;
    paths.push(parts.slice(0, i + 1).join(path.sep) + path.sep + "node_modules");
  }
  return paths;
};

BUILTIN_MAP["module"] = Module;

export default Module;
