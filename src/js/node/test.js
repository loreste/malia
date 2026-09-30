// node:test shim (Node.js test runner)
const testQueue = [];
let running = false;
let passes = 0;
let fails = 0;

export function test(name, fn) {
  if (typeof name === "function") {
    fn = name;
    name = fn.name || "anonymous test";
  }
  testQueue.push({ name, fn });
  scheduleDrain();
}

export const it = test;

export function describe(name, fn) {
  console.log(`\n# describe: ${name}`);
  if (typeof fn === "function") {
    fn();
  }
}

const beforeHooks = [];
const afterHooks = [];
const beforeEachHooks = [];
const afterEachHooks = [];

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

function scheduleDrain() {
  if (running) return;
  running = true;
  queueMicrotask(async () => {
    for (const h of beforeHooks) {
      try {
        await h();
      } catch (err) {
        console.error("before hook failed:", err);
      }
    }

    while (testQueue.length > 0) {
      const { name, fn } = testQueue.shift();
      for (const h of beforeEachHooks) {
        try {
          await h();
        } catch (err) {
          console.error("beforeEach hook failed:", err);
        }
      }
      try {
        const start = performance.now();
        if (typeof fn === "function") {
          await fn({
            diagnostic: (msg) => console.log(`# ${msg}`),
          });
        }
        const duration = (performance.now() - start).toFixed(2);
        console.log(`ok - ${name} (${duration}ms)`);
        passes++;
      } catch (err) {
        console.error(`not ok - ${name}`);
        console.error(`  ${err?.stack || err}`);
        fails++;
      }
      for (const h of afterEachHooks) {
        try {
          await h();
        } catch (err) {
          console.error("afterEach hook failed:", err);
        }
      }
    }

    for (const h of afterHooks) {
      try {
        await h();
      } catch (err) {
        console.error("after hook failed:", err);
      }
    }

    console.log(`\n# tests ${passes + fails}`);
    console.log(`# pass ${passes}`);
    console.log(`# fail ${fails}`);
    if (fails > 0) {
      process.exitCode = 1;
    }
    running = false;
  });
}

test.test = test;
test.it = it;
test.describe = describe;
test.before = before;
test.after = after;
test.beforeEach = beforeEach;
test.afterEach = afterEach;

export default test;
