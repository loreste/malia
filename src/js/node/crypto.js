// node:crypto: hashes (SHA-1/2, MD5), HMAC, PBKDF2, scrypt, AEAD ciphers,
// Ed25519, and randomness, backed by Rust ops (RustCrypto, ring, getrandom).
const ops = Deno.core.ops;
const { Buffer } = globalThis;
const webcrypto = globalThis.crypto;
const subtle = webcrypto?.subtle;

function codeError(Ctor, code, message) {
  const err = new Ctor(message);
  err.code = code;
  return err;
}

const hashFinalized = () => codeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");

function inputBytes(data, inputEncoding, name = "data") {
  if (typeof data === "string") return Buffer.from(data, inputEncoding ?? "utf8");
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw __jse.invalidArgType(name, "string or an instance of Buffer, TypedArray, or DataView", data);
}

class Hash {
  #id;
  #digested = false;

  constructor(algorithm, _options, id) {
    this.#id = id ?? ops.op_crypto_hash_new(String(algorithm));
  }

  update(data, inputEncoding) {
    if (this.#digested) throw hashFinalized();
    ops.op_crypto_hash_update(this.#id, inputBytes(data, inputEncoding));
    return this;
  }

  digest(encoding) {
    if (this.#digested) throw hashFinalized();
    this.#digested = true;
    const out = Buffer.from(ops.op_crypto_hash_digest(this.#id));
    return encoding === undefined || encoding === "buffer" ? out : out.toString(encoding);
  }

  copy() {
    if (this.#digested) throw hashFinalized();
    return new Hash(undefined, undefined, ops.op_crypto_hash_copy(this.#id));
  }
}

// crypto.hash(algorithm, data, outputEncoding = "hex"): one-shot digest.
function hash(algorithm, data, outputEncoding = "hex") {
  return new Hash(algorithm).update(data).digest(outputEncoding);
}

// Uniform integer in [min, max) by rejection sampling (no modulo bias).
function randomInt(min, max, callback) {
  if (typeof max === "undefined" || typeof max === "function") {
    callback = max;
    max = min;
    min = 0;
  }
  if (!Number.isSafeInteger(min)) throw __jse.invalidArgType("min", "a safe integer", min);
  if (!Number.isSafeInteger(max)) throw __jse.invalidArgType("max", "a safe integer", max);
  if (max <= min) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`);
  }
  const range = max - min;
  if (range > 2 ** 48 - 1) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "max - min" is out of range. It must be <= 281474976710655. Received ${range}`);
  }
  const limit = 2 ** 48 - (2 ** 48 % range);
  let value;
  do {
    value = Buffer.from(ops.op_crypto_random_bytes(6)).readUIntBE(0, 6);
  } while (value >= limit);
  const result = min + (value % range);
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, result));
    return undefined;
  }
  return result;
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
    this.#id = ops.op_hmac_new(String(algorithm), inputBytes(key, undefined, "key"));
  }

  update(data, inputEncoding) {
    if (this.#digested) throw hashFinalized();
    ops.op_hmac_update(this.#id, inputBytes(data, inputEncoding));
    return this;
  }

  digest(encoding) {
    if (this.#digested) throw hashFinalized();
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
  if (ba.byteLength !== bb.byteLength) {
    throw codeError(RangeError, "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length");
  }
  return ops.op_crypto_timing_safe_equal(ba, bb);
}

function getHashes() {
  return ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-256"];
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

// Node's option names and their aliases (N/r/p), with Node's defaults.
function scryptParams(options) {
  const o = options ?? {};
  return [
    o.cost ?? o.N ?? 16384,
    o.blockSize ?? o.r ?? 8,
    o.parallelization ?? o.p ?? 1,
    o.maxmem ?? 32 * 1024 * 1024,
  ];
}

function scryptSync(password, salt, keylen, options) {
  const [cost, blockSize, parallelization, maxmem] = scryptParams(options);
  return Buffer.from(ops.op_crypto_scrypt_sync(
    inputBytes(password, undefined, "password"),
    inputBytes(salt, undefined, "salt"),
    cost,
    blockSize,
    parallelization,
    keylen,
    maxmem,
  ));
}

function scrypt(password, salt, keylen, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }
  const [cost, blockSize, parallelization, maxmem] = scryptParams(options);
  ops.op_crypto_scrypt(
    inputBytes(password, undefined, "password"),
    inputBytes(salt, undefined, "salt"),
    cost,
    blockSize,
    parallelization,
    keylen,
    maxmem,
  ).then((key) => callback(null, Buffer.from(key)), (err) => callback(err));
}

const CIPHERS = ["aes-256-gcm", "aes-128-gcm", "chacha20-poly1305"];

// Reject unsupported ciphers up front (as Node does), not at final().
function checkCipher(algorithm) {
  const name = String(algorithm).toLowerCase();
  if (!CIPHERS.includes(name)) {
    throw codeError(TypeError, "ERR_CRYPTO_UNKNOWN_CIPHER", `Unknown cipher: ${algorithm} (supported: ${CIPHERS.join(", ")})`);
  }
  return name;
}

class Cipheriv {
  #algorithm;
  #key;
  #iv;
  #chunks = [];
  #aad = [];
  #tag = null;

  constructor(algorithm, key, iv, options = {}) {
    this.#algorithm = checkCipher(algorithm);
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
    this.#algorithm = checkCipher(algorithm);
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
  return [...CIPHERS];
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
  hash,
  randomInt,
  webcrypto,
  subtle,
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
  hash,
  randomInt,
  webcrypto,
  subtle,
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
