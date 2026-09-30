// node:wasi implementation
export class WASI {
  constructor(options = {}) {
    this.args = options.args || [];
    this.env = options.env || {};
    this.preopens = options.preopens || {};
    this.returnOnExit = Boolean(options.returnOnExit);
    this.instance = null;

    const self = this;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    this.wasiImport = {
      args_sizes_get(argc_ptr, argv_buf_size_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        view.setUint32(argc_ptr, self.args.length, true);
        let bufSize = 0;
        for (const arg of self.args) {
          bufSize += encoder.encode(arg).length + 1;
        }
        view.setUint32(argv_buf_size_ptr, bufSize, true);
        return 0; // WASI_ESUCCESS
      },
      args_get(argv_ptr, argv_buf_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        const u8 = new Uint8Array(mem.buffer);
        let currentBufPtr = argv_buf_ptr;
        for (let i = 0; i < self.args.length; i++) {
          view.setUint32(argv_ptr + i * 4, currentBufPtr, true);
          const encoded = encoder.encode(self.args[i]);
          u8.set(encoded, currentBufPtr);
          u8[currentBufPtr + encoded.length] = 0;
          currentBufPtr += encoded.length + 1;
        }
        return 0;
      },
      environ_sizes_get(environ_count_ptr, environ_buf_size_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        const entries = Object.entries(self.env);
        view.setUint32(environ_count_ptr, entries.length, true);
        let bufSize = 0;
        for (const [k, v] of entries) {
          bufSize += encoder.encode(`${k}=${v}`).length + 1;
        }
        view.setUint32(environ_buf_size_ptr, bufSize, true);
        return 0;
      },
      environ_get(environ_ptr, environ_buf_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        const u8 = new Uint8Array(mem.buffer);
        let currentBufPtr = environ_buf_ptr;
        const entries = Object.entries(self.env);
        for (let i = 0; i < entries.length; i++) {
          view.setUint32(environ_ptr + i * 4, currentBufPtr, true);
          const [k, v] = entries[i];
          const encoded = encoder.encode(`${k}=${v}`);
          u8.set(encoded, currentBufPtr);
          u8[currentBufPtr + encoded.length] = 0;
          currentBufPtr += encoded.length + 1;
        }
        return 0;
      },
      // Clock ids: 0 realtime (ns since the Unix epoch), 1 monotonic,
      // 2/3 process/thread CPU time (approximated by the monotonic clock).
      clock_time_get(id, _precision, time_ptr) {
        let ns;
        if (id === 0) ns = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
        else if (id >= 1 && id <= 3) ns = process.hrtime.bigint();
        else return 28; // EINVAL
        new DataView(self.#memory().buffer).setBigUint64(time_ptr, ns, true);
        return 0;
      },
      clock_res_get(_id, resolution_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        view.setBigUint64(resolution_ptr, 1000n, true); // 1 microsecond
        return 0;
      },
      fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        const u8 = new Uint8Array(mem.buffer);
        let written = 0;
        const chunks = [];
        for (let i = 0; i < iovs_len; i++) {
          const ptr = view.getUint32(iovs_ptr + i * 8, true);
          const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
          chunks.push(u8.subarray(ptr, ptr + len));
          written += len;
        }
        const total = new Uint8Array(written);
        let offset = 0;
        for (const c of chunks) {
          total.set(c, offset);
          offset += c.length;
        }
        const text = decoder.decode(total);
        if (fd === 1) {
          process.stdout.write(text);
        } else if (fd === 2) {
          process.stderr.write(text);
        }
        view.setUint32(nwritten_ptr, written, true);
        return 0;
      },
      fd_read(fd, iovs_ptr, iovs_len, nread_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        view.setUint32(nread_ptr, 0, true);
        return 0;
      },
      fd_close(_fd) {
        return 0;
      },
      fd_seek(_fd, _offset, _whence, newoffset_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        view.setBigUint64(newoffset_ptr, 0n, true);
        return 0;
      },
      fd_fdstat_get(fd, stat_ptr) {
        const mem = self.#memory();
        const view = new DataView(mem.buffer);
        // fd 0,1,2 = character device (2)
        view.setUint8(stat_ptr, fd <= 2 ? 2 : 4);
        view.setUint16(stat_ptr + 2, 0, true); // flags
        view.setBigUint64(stat_ptr + 8, 0xffffffffffffffffn, true); // rights base
        view.setBigUint64(stat_ptr + 16, 0xffffffffffffffffn, true); // rights inheriting
        return 0;
      },
      fd_fdstat_set_flags(_fd, _flags) {
        return 0;
      },
      fd_prestat_get(_fd, _prestat_ptr) {
        return 8; // WASI_EBADF
      },
      fd_prestat_dir_name(_fd, _path_ptr, _path_len) {
        return 8; // WASI_EBADF
      },
      fd_sync(_fd) {
        return 0;
      },
      random_get(buf_ptr, buf_len) {
        const mem = self.#memory();
        const u8 = new Uint8Array(mem.buffer, buf_ptr, buf_len);
        crypto.getRandomValues(u8);
        return 0;
      },
      sched_yield() {
        return 0;
      },
      proc_exit(rval) {
        if (self.returnOnExit) {
          self._exitCode = rval;
          throw new WASIExitError(rval);
        }
        process.exit(rval);
      },
    };
  }

  #memory() {
    if (!this.instance) {
      throw new Error("WASI instance not set. Call start(instance) or initialize(instance) first.");
    }
    const mem = this.instance.exports.memory;
    if (!mem) {
      throw new Error("WebAssembly instance has no memory export");
    }
    return mem;
  }

  getImportObject() {
    return {
      wasi_snapshot_preview1: this.wasiImport,
      wasi_unstable: this.wasiImport,
    };
  }

  start(instance) {
    this.instance = instance;
    if (typeof instance.exports._start === "function") {
      try {
        instance.exports._start();
      } catch (err) {
        if (err instanceof WASIExitError) {
          return err.code;
        }
        throw err;
      }
    }
    return 0;
  }

  initialize(instance) {
    this.instance = instance;
    if (typeof instance.exports._initialize === "function") {
      instance.exports._initialize();
    }
  }
}

class WASIExitError extends Error {
  constructor(code) {
    super(`WASI exit code ${code}`);
    this.code = code;
  }
}

export default { WASI };
