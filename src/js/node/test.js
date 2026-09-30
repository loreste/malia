// node:test: queues tests, runs them in order after the module body, and
// reports TAP version 13 on stdout (exit code 1 when anything fails).
const testQueue = [];
let running = false;
let started = false;
let count = 0;
let passes = 0;
let fails = 0;
let skips = 0;

const beforeHooks = [];
const afterHooks = [];
const beforeEachHooks = [];
const afterEachHooks = [];

// test(name?, options?, fn?)
function normalize(name, options, fn) {
  if (typeof name === "function") return { name: name.name || "<anonymous>", options: {}, fn: name };
  if (typeof options === "function") return { name, options: {}, fn: options };
  return { name, options: options ?? {}, fn };
}

export function test(name, options, fn) {
  testQueue.push(normalize(name, options, fn));
  scheduleDrain();
}
test.skip = (name, options, fn) => {
  const t = normalize(name, options, fn);
  test(t.name, { ...t.options, skip: true }, t.fn);
};
test.todo = (name, options, fn) => {
  const t = normalize(name, options, fn);
  test(t.name, { ...t.options, todo: true }, t.fn);
};
test.only = test;

export const it = test;

export function describe(name, options, fn) {
  const d = normalize(name, options, fn);
  // Suite-level skip/todo applies to every test registered inside it.
  if (d.options.skip || d.options.todo) {
    const start = testQueue.length;
    d.fn?.();
    for (const t of testQueue.slice(start)) Object.assign(t.options, { skip: d.options.skip, todo: d.options.todo });
    return;
  }
  d.fn?.();
}
describe.skip = (name, options, fn) => {
  const d = normalize(name, options, fn);
  describe(d.name, { ...d.options, skip: true }, d.fn);
};
describe.todo = (name, options, fn) => {
  const d = normalize(name, options, fn);
  describe(d.name, { ...d.options, todo: true }, d.fn);
};
describe.only = describe;
export const suite = describe;

export function before(fn) {
  beforeHooks.push(fn);
}
export function after(fn) {
  afterHooks.push(fn);
}
export function beforeEach(fn) {
  beforeEachHooks.push(fn);
}
export function afterEach(fn) {
  afterEachHooks.push(fn);
}

const yamlText = (s) => JSON.stringify(String(s));

function report(ok, name, directive, details) {
  if (!started) {
    started = true;
    console.log("TAP version 13");
  }
  count++;
  console.log(`${ok ? "ok" : "not ok"} ${count} - ${name}${directive ? ` # ${directive}` : ""}`);
  console.log("  ---");
  for (const [key, value] of Object.entries(details)) console.log(`  ${key}: ${value}`);
  console.log("  ...");
}

async function runHooks(hooks, label) {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      fails++;
      report(false, `${label} hook`, "", { error: yamlText(err?.message ?? err), stack: yamlText(err?.stack ?? "") });
    }
  }
}

function scheduleDrain() {
  if (running) return;
  running = true;
  queueMicrotask(async () => {
    await runHooks(beforeHooks, "before");
    while (testQueue.length > 0) {
      const { name, options, fn } = testQueue.shift();
      if (options.skip || options.todo) {
        skips++;
        const reason = typeof (options.skip ?? options.todo) === "string" ? ` ${options.skip ?? options.todo}` : "";
        report(true, name, `${options.skip ? "SKIP" : "TODO"}${reason}`, { duration_ms: 0 });
        continue;
      }
      await runHooks(beforeEachHooks, "beforeEach");
      const start = performance.now();
      let skipped = null;
      const context = {
        name,
        diagnostic: (msg) => console.log(`# ${msg}`),
        skip: (message = "") => {
          skipped = message;
        },
        todo: (message = "") => {
          skipped = message;
        },
      };
      try {
        if (typeof fn === "function") await fn(context);
        const duration = (performance.now() - start).toFixed(3);
        if (skipped !== null) {
          skips++;
          report(true, name, `SKIP${skipped ? ` ${skipped}` : ""}`, { duration_ms: duration });
        } else {
          passes++;
          report(true, name, "", { duration_ms: duration });
        }
      } catch (err) {
        fails++;
        report(false, name, "", {
          duration_ms: (performance.now() - start).toFixed(3),
          error: yamlText(err?.message ?? err),
          stack: yamlText(err?.stack ?? ""),
        });
      }
      await runHooks(afterEachHooks, "afterEach");
    }
    await runHooks(afterHooks, "after");

    console.log(`1..${count}`);
    console.log(`# tests ${passes + fails + skips}`);
    console.log(`# pass ${passes}`);
    console.log(`# fail ${fails}`);
    console.log(`# skipped ${skips}`);
    if (fails > 0) process.exitCode = 1;
    running = false;
  });
}

test.test = test;
test.it = it;
test.describe = describe;
test.suite = describe;
test.before = before;
test.after = after;
test.beforeEach = beforeEach;
test.afterEach = afterEach;

export default test;
