import assert from 'node:assert/strict';
import tls from 'node:tls';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
const cert = fs.readFileSync('tests/fixtures/tls_cert.pem');
const server = tls.createServer({ cert, key: fs.readFileSync('tests/fixtures/tls_key.pem') });
server.on('tlsClientError', () => {});
let actual;
server.on('secureConnection', socket => {
  actual = { protocol: socket.getProtocol(), cipher: socket.getCipher().standardName };
  socket.on('data', bytes => { assert.equal(bytes.toString(), 'ping'); socket.end('pong'); });
  socket.on('error', () => {});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.argv[2], ['run', '--allow-all', 'tests/fixtures/remediation_tls_client.mjs', String(server.address().port)]);
let stdout = '', stderr = '';
child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
const deadline = setTimeout(() => child.kill(), 10000);
try {
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.protocol, actual.protocol);
  assert.equal(result.cipher, actual.cipher);
  assert.equal(result.fingerprint, new X509Certificate(cert).fingerprint256);
  console.log('MAL_005_WIRE_OK');
} finally { clearTimeout(deadline); child.kill(); server.close(); }
