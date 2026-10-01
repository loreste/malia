import assert from 'node:assert/strict';
const url = new URL('./remediation_pool_worker.js', import.meta.url);
const pool = new WorkerPool(url, { size: 1, maxQueue: 2, timeoutMs: 1000 });
try {
  const first = pool.run({ kind: 'run', value: 'ordinary' });
  const iterator = pool.stream({ kind: 'stream' })[Symbol.asyncIterator]();
  const pending = iterator.next();
  assert.equal(await first, 'ordinary');
  assert.equal((await pending).value, 'first');
  await iterator.return();
  assert.equal(await pool.run({ kind: 'run', value: 'new' }), 'new');
  const all = [];
  for await (const value of pool.stream({ kind: 'stream' })) all.push(value);
  assert.deepEqual(all, ['first', 'second']);
  await assert.rejects(pool.run({ kind: 'throw' }));
  const running = pool.run({ kind: 'silent' });
  const queued = pool.run({ kind: 'run', value: 1 });
  const runningCheck = assert.rejects(running);
  const queuedCheck = assert.rejects(queued);
  pool.close();
  await Promise.all([runningCheck, queuedCheck]);
  console.log('MAL_002_OK');
} finally { pool.close(); }
