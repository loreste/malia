import tls from 'node:tls';
import assert from 'node:assert/strict';
const port = Number(process.argv[2]);
await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: '127.0.0.1', servername: 'localhost', port });
  socket.on('secureConnect', () => reject(new Error('untrusted certificate accepted')));
  socket.on('error', () => { assert.equal(socket.authorized, false); resolve(); });
});
const metadata = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: '127.0.0.1', servername: 'localhost', port, rejectUnauthorized: false });
  socket.on('error', reject);
  socket.on('secureConnect', () => {
    assert.equal(socket.authorized, false);
    assert.equal(socket.authorizationError, 'CERTIFICATE_VERIFICATION_DISABLED');
    const result = { protocol: socket.getProtocol(), cipher: socket.getCipher().standardName, fingerprint: socket.getPeerCertificate().fingerprint256 };
    socket.write('ping');
    socket.on('data', bytes => {
      assert.equal(bytes.toString(), 'pong'); socket.destroy(); resolve(result);
    });
  });
});
console.log(JSON.stringify(metadata));
