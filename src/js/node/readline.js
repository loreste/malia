// node:readline — Readline interface for stdin/streams.
import { EventEmitter } from "node:events";

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
      this.input.on("data", (chunk) => {
        this._buffer += chunk.toString("utf8");
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
}

export function createInterface(options) {
  return new Interface(options);
}

export const promises = {
  createInterface(options) {
    const rl = new Interface(options);
    return {
      question(query) {
        return new Promise((resolve) => rl.question(query, resolve));
      },
      close() {
        rl.close();
      },
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise((resolve) => {
              if (rl.closed) return resolve({ done: true, value: undefined });
              rl.once("line", (line) => resolve({ done: false, value: line }));
              rl.once("close", () => resolve({ done: true, value: undefined }));
            });
          },
        };
      },
    };
  },
};

export default {
  Interface,
  createInterface,
  promises,
};
