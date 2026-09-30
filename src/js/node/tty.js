// node:tty — isatty follows the host stdio handles.
const ops = Deno.core.ops;

export function isatty(fd) {
  return ops.op_isatty(fd >>> 0);
}

export class WriteStream {
  constructor(fd) {
    this.fd = fd;
    this.isTTY = isatty(fd);
    this.columns = 80;
    this.rows = 24;
  }
  hasColors() {
    return false;
  }
  getColorDepth() {
    return 1;
  }
  write(s) {
    process.stdout.write(s);
    return true;
  }
}

export class ReadStream {
  constructor(fd) {
    this.fd = fd;
    this.isTTY = isatty(fd);
  }
}

export default { isatty, WriteStream, ReadStream };
