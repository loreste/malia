// Independent Node client checks the real Malia HTTP listener.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
const child = spawn(process.argv[2], ['run', '--allow-all', 'tests/fixtures/remediation_http_server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let errors = ''; child.stderr.on('data', b => { errors += b; });
const timer = setTimeout(() => { child.kill(); throw new Error('HTTP regression deadline'); }, 10000);
try {
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', bytes => resolve(Number(bytes.toString().trim())));
    child.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
  });
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body) { req.write(body.subarray(0, 512)); req.write(body.subarray(512)); }
    req.end();
  });
  assert.equal(await request('/', Buffer.alloc(2048)), 413);
  assert.equal(await request('/', Buffer.alloc(100)), 200);
  assert.equal(await request('/wait'), 504);
  assert.equal(await request('/'), 200);
  for (let pair = 0; pair < 25; pair++) {
    const ids = [`A-${pair}`, `B-${pair}`];
    const replies = await Promise.all(ids.map(async id => {
      const response = await fetch(`http://127.0.0.1:${port}/context`, { headers: { 'x-request-id': id } });
      assert.equal(response.status, 200);
      return response.text();
    }));
    assert.deepEqual(replies, ids);
  }
  console.log('MAL_006_WIRE_OK');
} finally { clearTimeout(timer); child.kill(); }
