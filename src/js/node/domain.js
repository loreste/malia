// node:domain shim
import EventEmitter from "node:events";

let activeDomain = null;

export class Domain extends EventEmitter {
  constructor() {
    super();
    this.members = [];
  }

  run(fn, ...args) {
    const prev = activeDomain;
    activeDomain = this;
    this.enter();
    try {
      return fn(...args);
    } catch (err) {
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      } else {
        throw err;
      }
    } finally {
      this.exit();
      activeDomain = prev;
    }
  }

  add(emitter) {
    if (emitter && typeof emitter.on === "function") {
      this.members.push(emitter);
      emitter.domain = this;
    }
  }

  remove(emitter) {
    const idx = this.members.indexOf(emitter);
    if (idx !== -1) {
      this.members.splice(idx, 1);
      if (emitter.domain === this) emitter.domain = null;
    }
  }

  bind(fn) {
    const self = this;
    return function (...args) {
      return self.run(fn, ...args);
    };
  }

  intercept(fn) {
    const self = this;
    return function (err, ...args) {
      if (err) {
        self.emit("error", err);
      } else {
        return self.run(fn, ...args);
      }
    };
  }

  enter() {
    activeDomain = this;
  }

  exit() {
    if (activeDomain === this) activeDomain = null;
  }
}

export function create() {
  return new Domain();
}

export function createDomain() {
  return new Domain();
}

Object.defineProperty(create, "active", {
  get() {
    return activeDomain;
  },
  set(val) {
    activeDomain = val;
  },
});

export default {
  Domain,
  create,
  createDomain,
  get active() {
    return activeDomain;
  },
  set active(val) {
    activeDomain = val;
  },
};
