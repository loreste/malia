// Context propagation is owned by V8/deno_core, including native await.
const core = Deno.core;
const resourceContext = new core.AsyncVariable();
let nextResourceId = 1;
function scoped(context, callback, thisArg, args) {
  const previous = core.getAsyncContext();
  core.setAsyncContext(context);
  try { return Reflect.apply(callback, thisArg, args); }
  finally { core.setAsyncContext(previous); }
}
export class AsyncLocalStorage {
  #variable = new core.AsyncVariable();
  #defaultValue;
  constructor(options = {}) {
    this.#defaultValue = options.defaultValue;
    this.name = options.name ?? '';
  }
  getStore() {
    const entry = this.#variable.get();
    return entry === undefined ? this.#defaultValue : entry.value;
  }
  enterWith(store) { this.#variable.enter({ value: store }); }
  run(store, callback, ...args) {
    const previous = core.getAsyncContext();
    this.enterWith(store);
    try { return Reflect.apply(callback, undefined, args); }
    finally { core.setAsyncContext(previous); }
  }
  exit(callback, ...args) { return this.run(undefined, callback, ...args); }
  // Node 26: existing snapshots and async descendants retain their context.
  disable() { this.#variable.enter(undefined); }
  static snapshot() {
    const context = core.getAsyncContext();
    return (callback, ...args) => scoped(context, callback, undefined, args);
  }
  static bind(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const context = core.getAsyncContext();
    return function (...args) { return scoped(context, callback, this, args); };
  }
}
export class AsyncResource {
  #context;
  #id = nextResourceId++;
  #trigger;
  constructor(type, options = {}) {
    if (typeof type !== 'string') throw new TypeError('type must be a string');
    this.type = type;
    this.#trigger = typeof options === 'number' ? options : (options.triggerAsyncId ?? executionAsyncId());
    const previous = resourceContext.enter(this);
    this.#context = core.getAsyncContext();
    core.setAsyncContext(previous);
  }
  runInAsyncScope(callback, thisArg, ...args) { return scoped(this.#context, callback, thisArg, args); }
  bind(callback, thisArg) {
    const resource = this;
    return function (...args) { return resource.runInAsyncScope(callback, thisArg ?? this, ...args); };
  }
  static bind(callback, type = 'bound', thisArg) { return new AsyncResource(type).bind(callback, thisArg); }
  emitDestroy() { return this; }
  asyncId() { return this.#id; }
  triggerAsyncId() { return this.#trigger; }
}
// IDs describe explicit AsyncResources only; native async_hooks lifecycle hooks are unsupported.
export function executionAsyncId() { return resourceContext.get()?.asyncId() ?? 0; }
export function triggerAsyncId() { return resourceContext.get()?.triggerAsyncId() ?? 0; }
export default { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId };
