// MAL-001: observable context isolation; also runnable under the Node reference.
import assert from 'node:assert/strict';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const als = new AsyncLocalStorage();
const second = new AsyncLocalStorage();
let release;
const gate = new Promise(resolve => { release = resolve; });
const a = als.run('A', async () => {
  await gate;
  assert.equal(als.getStore(), 'A');
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(als.getStore(), 'A');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(als.getStore(), 'A');
  await readFile(fileURLToPath(new URL('./data.json', import.meta.url)));
  return als.getStore();
});
const b = als.run('B', async () => {
  await gate;
  await Promise.resolve().then(() => assert.equal(als.getStore(), 'B'));
  return als.getStore();
});
assert.equal(als.getStore(), undefined);
release();
assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
assert.equal(als.getStore(), undefined);
als.run('outer', () => {
  assert.throws(() => als.run('inner', () => { throw new Error('expected'); }));
  assert.equal(als.getStore(), 'outer');
  second.run(42, () => {
    assert.equal(second.getStore(), 42);
    assert.equal(als.getStore(), 'outer');
  });
  als.exit(() => assert.equal(als.getStore(), undefined));
  assert.equal(als.getStore(), 'outer');
});
const bound = als.run('bound', () => AsyncLocalStorage.bind(() => als.getStore()));
const snapshot = als.run('snapshot', () => AsyncLocalStorage.snapshot());
assert.equal(bound(), 'bound');
assert.equal(snapshot(() => als.getStore()), 'snapshot');
const resource = als.run('resource', () => new AsyncResource('test'));
assert.equal(resource.runInAsyncScope(() => als.getStore()), 'resource');
als.disable();
// Node 26 preserves already captured continuations after disable().
assert.equal(bound(), 'bound');
assert.equal(als.run('again', () => als.getStore()), 'again');
assert.equal(als.getStore(), undefined);
console.log('MAL_001_OK');
