import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'malia-lease-'));
const file = path.join(dir, 'jobs.sqlite');
const now = Date.now;
let clock = now();
Date.now = () => clock;
let a = jse.queue(file);
let b = jse.queue(file);
try {
  a.push('topic', { value: 42 }, { maxRetries: 2 });
  const first = a.pop('topic', 10);
  clock += 11;
  const second = b.pop('topic', 10);
  assert.equal(typeof second.token, 'string');
  assert.notEqual(first.token, second.token);
  assert.equal(a.ack(first.id, first.token), false);
  assert.equal(a.nack(first.id, first.token, 0), false);
  assert.equal(a.renew(first.id, first.token, 10), false);
  assert.equal(b.renew(second.id, second.token, 10), true);
  assert.equal(b.ack(second.id, second.token), true);
  assert.equal(b.ack(second.id, second.token), false);
  a.push('topic', 'expire', { maxRetries: 1 });
  a.pop('topic', 10);
  a.close(); a = jse.queue(file);
  clock += 11;
  assert.equal(a.pop('topic', 10), null);
  assert.equal(a.dead('topic').length, 1);
  assert.throws(() => a.push('', 'bad'));
  assert.throws(() => a.pop('topic', -1));
  console.log('MAL_009_OK');
} finally {
  Date.now = now;
  a.close(); b.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
