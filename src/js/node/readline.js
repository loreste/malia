// node:readline — Readline interface for stdin/streams.
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export class Interface extends EventEmitter {
  constructor(options = {}) {
    super();
    this.input = options.input;
    this.output = options.output;
    this.promptStr = options.prompt || "> ";
    this.terminal = !!options.terminal;
    this.closed = false;

    if (this.input) {
      this._buffer = "";
      // A decoder keeps multi-byte characters split across chunks intact.
      const decoder = new StringDecoder("utf8");
      this.input.on("data", (chunk) => {
        this._buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        const lines = this._buffer.split(/\r?\n/);
        this._buffer = lines.pop();
        for (const line of lines) {
          this.emit("line", line);
        }
      });
      this.input.on("end", () => {
        if (this._buffer.length > 0) {
          this.emit("line", this._buffer);
          this._buffer = "";
        }
        this.close();
      });
    }
  }

  setPrompt(prompt) {
    this.promptStr = prompt;
  }

  prompt(preserveCursor) {
    if (this.output) {
      this.output.write(this.promptStr);
    }
  }

  question(query, cb) {
    if (this.output) {
      this.output.write(query);
    }
    this.once("line", (line) => {
      if (typeof cb === "function") cb(line);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  pause() {
    if (this.input && typeof this.input.pause === "function") this.input.pause();
    return this;
  }

  resume() {
    if (this.input && typeof this.input.resume === "function") this.input.resume();
    return this;
  }

  // for await (const line of rl): lines are buffered from the moment the
  // iterator is created, so none are lost between next() calls.
  [Symbol.asyncIterator]() {
    const queue = [];
    const waiters = [];
    let done = this.closed;
    this.on("line", (line) => {
      if (waiters.length) waiters.shift()({ done: false, value: line });
      else queue.push(line);
    });
    this.once("close", () => {
      done = true;
      while (waiters.length) waiters.shift()({ done: true, value: undefined });
    });
    return {
      next: () => {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
        if (done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

// readline/promises: the same interface with question() returning a promise.
class PromisesInterface extends Interface {
  question(query) {
    return new Promise((resolve) => super.question(query, resolve));
  }
}

export function createInterface(options) {
  return new Interface(options);
}

export const promises = {
  Interface: PromisesInterface,
  createInterface(options) {
    return new PromisesInterface(options);
  },
};

export default {
  Interface,
  createInterface,
  promises,
};
