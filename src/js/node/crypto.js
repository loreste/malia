// node:crypto shim: createHash (sha256/sha512/sha1/md5), randomBytes and
// timingSafeEqual, backed by Rust ops (RustCrypto hashes, getrandom).
const ops = Deno.core.ops;
const { Buffer } = globalThis;

class Hash {
  #id;
  #digested = false;

  constructor(algorithm) {
    this.#id = ops.op_crypto_hash_new(String(algorithm));
  }

  update(data, inputEncoding) {
    if (this.#digested) throw new Error("Digest already called");
    const bytes =
      typeof data === "string" ? Buffer.from(data, inputEncoding ?? "utf8") : Buffer.from(data);
    ops.op_crypto_hash_update(this.#id, bytes);
    return this;
  }

  digest(encoding) {
    if (this.#digested) throw new Error("Digest already called");
    this.#digested = true;
    const out = Buffer.from(ops.op_crypto_hash_digest(this.#id));
    return encoding === undefined ? out : out.toString(encoding);
  }
}

function createHash(algorithm) {
  return new Hash(algorithm);
}

function randomBytes(size, cb) {
  if (typeof size !== "number" || size < 0) {
    throw new TypeError("size must be a non-negative number");
  }
  if (typeof cb === "function") {
    try {
      const out = Buffer.from(ops.op_crypto_random_bytes(size));
      queueMicrotask(() => cb(null, out));
    } catch (err) {
      queueMicrotask(() => cb(err));
    }
    return undefined;
  }
  return Buffer.from(ops.op_crypto_random_bytes(size));
}

class Hmac {
  #id;
  #digested = false;

  constructor(algorithm, key) {
    const bytes = typeof key === "string" ? Buffer.from(key) : Buffer.from(key);
    this.#id = ops.op_hmac_new(String(algorithm), bytes);
  }

  update(data, inputEncoding) {
    if (this.#digested) throw new Error("Digest already called");
    const bytes =
      typeof data === "string" ? Buffer.from(data, inputEncoding ?? "utf8") : Buffer.from(data);
    ops.op_hmac_update(this.#id, bytes);
    return this;
  }

  digest(encoding) {
    if (this.#digested) throw new Error("Digest already called");
    this.#digested = true;
    const out = Buffer.from(ops.op_hmac_digest(this.#id));
    return encoding === undefined ? out : out.toString(encoding);
  }
}

function createHmac(algorithm, key) {
  return new Hmac(algorithm, key);
}

function randomUUID() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomFillSync(buf, offset = 0, size) {
  const start = offset >>> 0;
  const len = size === undefined ? buf.length - start : size >>> 0;
  const bytes = ops.op_crypto_random_bytes(len);
  buf.set(bytes, start);
  return buf;
}

function timingSafeEqual(a, b) {
  const ba = typeof a === "string" ? Buffer.from(a) : a;
  const bb = typeof b === "string" ? Buffer.from(b) : b;
  if (ba.length !== bb.length) {
    throw new RangeError("Input buffers must have the same byte length");
  }
  return ops.op_crypto_timing_safe_equal(ba, bb);
}

function getHashes() {
  return ["md5", "sha1", "sha256", "sha512"];
}

function pbkdf2Sync(password, salt, iterations, keylen, digest = "sha1") {
  if (typeof iterations !== "number" || iterations <= 0) {
    throw new TypeError("iterations must be a positive number");
  }
  if (typeof keylen !== "number" || keylen < 0) {
    throw new TypeError("keylen must be a non-negative number");
  }
  const passBuf = typeof password === "string" ? Buffer.from(password) : Buffer.from(password);
  const saltBuf = typeof salt === "string" ? Buffer.from(salt) : Buffer.from(salt);
  const algo = String(digest || "sha1").toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = ops.op_crypto_pbkdf2(algo, passBuf, saltBuf, iterations, keylen);
  return Buffer.from(out);
}

function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  if (typeof digest === "function") {
    callback = digest;
    digest = "sha1";
  }
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }
  try {
    const res = pbkdf2Sync(password, salt, iterations, keylen, digest);
    queueMicrotask(() => callback(null, res));
  } catch (err) {
    queueMicrotask(() => callback(err));
  }
}

function scryptSync(password, salt, keylen, options = {}) {
  const cost = typeof options === "object" && options?.cost ? options.cost : 16384;
  return pbkdf2Sync(password, salt, cost, keylen, "sha256");
}

function scrypt(password, salt, keylen, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }
  try {
    const res = scryptSync(password, salt, keylen, options);
    queueMicrotask(() => callback(null, res));
  } catch (err) {
    queueMicrotask(() => callback(err));
  }
}

class Cipheriv {
  #algorithm;
  #key;
  #iv;
  #chunks = [];
  #aad = [];
  #tag = null;

  constructor(algorithm, key, iv, options = {}) {
    this.#algorithm = String(algorithm);
    this.#key = Buffer.isBuffer(key) ? key : Buffer.from(key);
    this.#iv = Buffer.isBuffer(iv) ? iv : Buffer.from(iv);
  }

  setAAD(buffer, options = {}) {
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.#aad.push(b);
    return this;
  }

  update(data, inputEncoding, outputEncoding) {
    const chunk = typeof data === "string" ? Buffer.from(data, inputEncoding || "utf8") : Buffer.from(data);
    this.#chunks.push(chunk);
    return outputEncoding ? "" : Buffer.alloc(0);
  }

  final(outputEncoding) {
    const plaintext = Buffer.concat(this.#chunks);
    const aad = Buffer.concat(this.#aad);
    const res = ops.op_crypto_cipher_encrypt(this.#algorithm, this.#key, this.#iv, plaintext, aad);
    const ciphertext = Buffer.from(res.ciphertext);
    this.#tag = Buffer.from(res.tag);
    return outputEncoding ? ciphertext.toString(outputEncoding) : ciphertext;
  }

  getAuthTag() {
    if (!this.#tag) throw new Error("Authentication tag not available yet (call final() first)");
    return this.#tag;
  }
}

class Decipheriv {
  #algorithm;
  #key;
  #iv;
  #chunks = [];
  #aad = [];
  #tag = null;

  constructor(algorithm, key, iv, options = {}) {
    this.#algorithm = String(algorithm);
    this.#key = Buffer.isBuffer(key) ? key : Buffer.from(key);
    this.#iv = Buffer.isBuffer(iv) ? iv : Buffer.from(iv);
  }

  setAAD(buffer, options = {}) {
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.#aad.push(b);
    return this;
  }

  setAuthTag(tag, encoding) {
    this.#tag = typeof tag === "string" ? Buffer.from(tag, encoding || "hex") : Buffer.from(tag);
    return this;
  }

  update(data, inputEncoding, outputEncoding) {
    const chunk = typeof data === "string" ? Buffer.from(data, inputEncoding || "hex") : Buffer.from(data);
    this.#chunks.push(chunk);
    return outputEncoding ? "" : Buffer.alloc(0);
  }

  final(outputEncoding) {
    if (!this.#tag) throw new Error("Authentication tag must be set before final() in GCM mode");
    const ciphertext = Buffer.concat(this.#chunks);
    const aad = Buffer.concat(this.#aad);
    const res = ops.op_crypto_cipher_decrypt(this.#algorithm, this.#key, this.#iv, ciphertext, this.#tag, aad);
    const plaintext = Buffer.from(res);
    return outputEncoding ? plaintext.toString(outputEncoding) : plaintext;
  }
}

function createCipheriv(algorithm, key, iv, options) {
  return new Cipheriv(algorithm, key, iv, options);
}

function createDecipheriv(algorithm, key, iv, options) {
  return new Decipheriv(algorithm, key, iv, options);
}

function getCiphers() {
  return ["aes-256-gcm", "aes-128-gcm", "chacha20-poly1305"];
}

function generateKeyPairSync(type, options = {}) {
  const t = String(type).toLowerCase();
  if (t !== "ed25519") {
    throw new Error(`generateKeyPairSync: algorithm '${type}' not supported yet (supported: 'ed25519')`);
  }
  const res = ops.op_crypto_keypair_ed25519();
  return {
    publicKey: Buffer.from(res.public_key),
    privateKey: Buffer.from(res.private_key),
  };
}

function sign(algorithm, data, key) {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const keyBuf = Buffer.isBuffer(key) ? key : (key?.key ? Buffer.from(key.key) : Buffer.from(key));
  const sig = ops.op_crypto_sign_ed25519(keyBuf, dataBuf);
  return Buffer.from(sig);
}

function verify(algorithm, data, key, signature) {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const keyBuf = Buffer.isBuffer(key) ? key : (key?.key ? Buffer.from(key.key) : Buffer.from(key));
  const sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  return ops.op_crypto_verify_ed25519(keyBuf, dataBuf, sigBuf);
}

export {
  Hash,
  Hmac,
  Cipheriv,
  Decipheriv,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  getCiphers,
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
  randomUUID,
  randomFillSync,
  timingSafeEqual,
  getHashes,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
};
export default {
  Hash,
  Hmac,
  Cipheriv,
  Decipheriv,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  getCiphers,
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
  randomUUID,
  randomFillSync,
  timingSafeEqual,
  getHashes,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
};
