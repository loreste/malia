// node:repl — Read-Eval-Print Loop module.
import { EventEmitter } from "node:events";

class REPLServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.prompt = options.prompt ?? "> ";
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.context = globalThis;
  }

  displayPrompt() {
    if (this.output?.write) this.output.write(this.prompt);
  }

  close() {
    this.emit("exit");
  }
}

export function start(options) {
  const server = new REPLServer(options);
  queueMicrotask(() => server.displayPrompt());
  return server;
}

export { REPLServer };
export default {
  start,
  REPLServer,
};
