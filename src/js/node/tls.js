// rustls clients. Server accept and socket upgrades are explicitly unsupported.
import net from "node:net";
import { createHash } from "node:crypto";
const ops = Deno.core.ops;
export const DEFAULT_ECDH_CURVE = "auto";
export const rootCertificates = [];
function unsupported(name) {
  const error = new Error(`node:tls does not support ${name}`);
  error.code = 'ERR_TLS_UNSUPPORTED_OPTION';
  throw error;
}
function validate(options) {
  for (const key of ['socket', 'ca', 'cert', 'key', 'pfx', 'secureContext', 'checkServerIdentity',
    'minVersion', 'maxVersion', 'ALPNProtocols', 'ciphers', 'secureProtocol', 'secureOptions',
    'session', 'requestCert', 'pskCallback', 'ecdhCurve', 'sigalgs', 'clientCertEngine']) {
    if (options[key] !== undefined) unsupported(key);
  }
}
export class TLSSocket extends net.Socket {
  constructor(socket, options = {}) {
    if (socket != null) unsupported('socket upgrades');
    validate(options);
    super(options);
    this.encrypted = true;
    this.authorized = false;
    this.authorizationError = null;
    this.alpnProtocol = false;
    this.servername = options.servername;
    this._tlsInfo = null;
  }
  getPeerCertificate() {
    const bytes = this._tlsInfo?.peer_certificate;
    if (!bytes) return {};
    const raw = Buffer.from(bytes);
    const fingerprint = createHash('sha256').update(raw).digest('hex').toUpperCase().match(/../g).join(':');
    return { raw, fingerprint256: fingerprint };
  }
  getCipher() {
    const info = this._tlsInfo;
    return info?.cipher ? { name: info.cipher, standardName: info.cipher, version: info.protocol } : null;
  }
  getProtocol() { return this._tlsInfo?.protocol ?? null; }
}
export function createSecureContext() { unsupported('secure contexts'); }
export function connect(...args) {
  let options;
  let cb;
  if (typeof args[0] === 'object') { options = { ...args[0] }; cb = args[1]; }
  else {
    options = { port: args[0] };
    if (typeof args[1] === 'string') { options.host = args[1]; options = { ...options, ...(typeof args[2] === 'object' ? args[2] : {}) }; }
    else if (typeof args[1] === 'object') options = { ...options, ...args[1] };
    cb = args.find(a => typeof a === 'function');
  }
  validate(options);
  const host = options.host || 'localhost';
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new RangeError('Invalid TLS port'); error.code = 'ERR_SOCKET_BAD_PORT'; throw error;
  }
  const servername = options.servername || host;
  const socket = new TLSSocket(null, { ...options, servername });
  socket.connecting = true;
  if (typeof cb === 'function') socket.once('secureConnect', cb);
  ops.op_tls_connect(String(host), port, String(servername), options.rejectUnauthorized === false).then(info => {
    if (socket.destroyed) { ops.op_net_close(info.id); return; }
    socket._tlsInfo = info;
    socket.authorized = info.authorized;
    socket.authorizationError = info.authorized ? null : 'CERTIFICATE_VERIFICATION_DISABLED';
    socket.alpnProtocol = info.alpn || false;
    socket._onConnect(info);
    socket.emit('secureConnect');
  }, error => {
    socket.authorizationError = error.message;
    socket.destroy(error);
  });
  return socket;
}
export class Server extends net.Server {
  constructor(options, connectionListener) {
    if (typeof options === 'function') { connectionListener = options; options = {}; }
    const { cert, key } = options || {};
    if (!cert || !key) throw new Error('tls.createServer requires cert and key options');
    super(options, connectionListener);
    this._tlsCert = typeof cert === 'string' ? cert : cert.toString();
    this._tlsKey = typeof key === 'string' ? key : key.toString();
  }
  listen(...args) {
    // Parse (port, host?, cb?) same as net.Server
    let port, host = '0.0.0.0', cb;
    if (typeof args[0] === 'number') { port = args[0]; }
    else if (typeof args[0] === 'object') { port = args[0].port; host = args[0].host || host; }
    if (typeof args[1] === 'string') host = args[1];
    cb = args.find(a => typeof a === 'function');

    ops.op_tls_listen(String(host), port, this._tlsCert, this._tlsKey).then(info => {
      this._serverId = info.id;
      this._address = { address: info.host, port: info.port, family: info.host.includes(':') ? 'IPv6' : 'IPv4' };
      this.listening = true;
      this.emit('listening');
      if (cb) cb();
      this._acceptLoop();
    }, err => this.emit('error', err));
    return this;
  }
  async _acceptLoop() {
    while (this.listening) {
      const conn = await ops.op_net_accept(this._serverId);
      if (!conn) break;
      const socket = new TLSSocket(null, {});
      socket.encrypted = true;
      socket.authorized = true;
      socket._onConnect(conn);
      socket.emit('secureConnect');
      this.emit('connection', socket);
      this.emit('secureConnection', socket);
    }
  }
}
export function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}
export default { TLSSocket, Server, connect, createServer, createSecureContext, DEFAULT_ECDH_CURVE, rootCertificates };
