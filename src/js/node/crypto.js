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
  #algo;
  #digested = false;
  #singleData = undefined; // fast-path: one update, no copy

  constructor(algorithm, _options, id) {
    this.#algo = algorithm ? String(algorithm) : null;
    this.#id = id ?? -1; // defer native alloc until needed
  }

  update(data, inputEncoding) {
    if (this.#digested) throw hashFinalized();
    const bytes = inputBytes(data, inputEncoding);
    if (this.#id === -1 && this.#singleData === undefined) {
      // First update: stash data for potential one-shot digest.
      this.#singleData = bytes;
    } else {
      // Multiple updates or copied hash: fall back to streaming.
      if (this.#id === -1) {
        this.#id = ops.op_crypto_hash_new(this.#algo);
        if (this.#singleData !== undefined) {
          ops.op_crypto_hash_update(this.#id, this.#singleData);
          this.#singleData = undefined;
        }
      }
      ops.op_crypto_hash_update(this.#id, bytes);
    }
    return this;
  }

  digest(encoding) {
    if (this.#digested) throw hashFinalized();
    this.#digested = true;
    let out;
    if (this.#id === -1 && this.#singleData !== undefined) {
      // One-shot fast path: single op call instead of 3.
      out = Buffer.from(ops.op_crypto_hash_oneshot(this.#algo, this.#singleData));
    } else {
      if (this.#id === -1) {
        this.#id = ops.op_crypto_hash_new(this.#algo);
      }
      out = Buffer.from(ops.op_crypto_hash_digest(this.#id));
    }
    return encoding === undefined || encoding === "buffer" ? out : out.toString(encoding);
  }

  copy() {
    if (this.#digested) throw hashFinalized();
    // Force streaming mode for both source and copy.
    if (this.#id === -1) {
      this.#id = ops.op_crypto_hash_new(this.#algo);
      if (this.#singleData !== undefined) {
        ops.op_crypto_hash_update(this.#id, this.#singleData);
        this.#singleData = undefined;
      }
    }
    return new Hash(undefined, undefined, ops.op_crypto_hash_copy(this.#id));
  }
}

// crypto.hash(algorithm, data, outputEncoding = "hex"): one-shot digest.
function hash(algorithm, data, outputEncoding = "hex") {
  const out = Buffer.from(ops.op_crypto_hash_oneshot(String(algorithm), inputBytes(data, undefined)));
  return outputEncoding === undefined || outputEncoding === "buffer" ? out : out.toString(outputEncoding);
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

const AEAD_CIPHERS = ["aes-128-gcm", "aes-256-gcm", "chacha20-poly1305"];
const STREAM_CIPHERS = [
  "aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
];
const CIPHERS = [...AEAD_CIPHERS, ...STREAM_CIPHERS];

// Reject unsupported ciphers up front (as Node does), not at final().
function checkCipher(algorithm) {
  const name = String(algorithm).toLowerCase();
  if (!CIPHERS.includes(name)) {
    throw codeError(TypeError, "ERR_CRYPTO_UNKNOWN_CIPHER", `Unknown cipher: ${algorithm} (supported: ${CIPHERS.join(", ")})`);
  }
  return name;
}

const toBuffer = (data, encoding) =>
  typeof data === "string" ? Buffer.from(data, encoding || "utf8") : Buffer.from(inputBytes(data));

const output = (buf, encoding) => (encoding && encoding !== "buffer" ? buf.toString(encoding) : buf);

// Shared by Cipheriv and Decipheriv. AEAD modes (GCM, ChaCha20-Poly1305) are
// processed as one message at final(); CBC and CTR stream through update().
class CipherBase {
  #algorithm;
  #key;
  #iv;
  #decrypt;
  #streamId = null;
  #chunks = [];
  #aad = [];
  #finalized = false;
  _tag = null;

  constructor(algorithm, key, iv, decrypt) {
    this.#algorithm = checkCipher(algorithm);
    this.#key = toBuffer(key);
    this.#iv = toBuffer(iv);
    this.#decrypt = decrypt;
    if (STREAM_CIPHERS.includes(this.#algorithm)) {
      this.#streamId = ops.op_crypto_stream_cipher_new(this.#algorithm, this.#key, this.#iv, decrypt);
    }
  }

  setAAD(buffer) {
    if (this.#streamId !== null) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "setAAD is only valid for AEAD ciphers");
    this.#aad.push(toBuffer(buffer));
    return this;
  }

  setAutoPadding(autoPadding = true) {
    // CTR mode has no padding; GCM/ChaCha20 handle it internally.
    // Only CBC with PKCS#7 is affected. For CBC, disabling padding means
    // the caller must supply data in exact block multiples.
    this._autoPadding = autoPadding;
    return this;
  }

  update(data, inputEncoding, outputEncoding) {
    if (this.#finalized) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation update");
    const chunk = toBuffer(data, inputEncoding);
    if (this.#streamId !== null) {
      return output(Buffer.from(ops.op_crypto_stream_cipher_update(this.#streamId, chunk)), outputEncoding);
    }
    this.#chunks.push(chunk);
    return output(Buffer.alloc(0), outputEncoding);
  }

  final(outputEncoding) {
    if (this.#finalized) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation final");
    this.#finalized = true;
    if (this.#streamId !== null) {
      return output(Buffer.from(ops.op_crypto_stream_cipher_final(this.#streamId)), outputEncoding);
    }
    const body = Buffer.concat(this.#chunks);
    const aad = Buffer.concat(this.#aad);
    if (this.#decrypt) {
      if (!this._tag) throw new Error("Authentication tag must be set before final()");
      const res = ops.op_crypto_cipher_decrypt(this.#algorithm, this.#key, this.#iv, body, this._tag, aad);
      return output(Buffer.from(res), outputEncoding);
    }
    const res = ops.op_crypto_cipher_encrypt(this.#algorithm, this.#key, this.#iv, body, aad);
    this._tag = Buffer.from(res.tag);
    return output(Buffer.from(res.ciphertext), outputEncoding);
  }
}

class Cipheriv extends CipherBase {
  constructor(algorithm, key, iv) {
    super(algorithm, key, iv, false);
  }

  getAuthTag() {
    if (!this._tag) throw new Error("Authentication tag not available yet (call final() first)");
    return this._tag;
  }
}

class Decipheriv extends CipherBase {
  constructor(algorithm, key, iv) {
    super(algorithm, key, iv, true);
  }

  setAuthTag(tag, encoding) {
    this._tag = typeof tag === "string" ? Buffer.from(tag, encoding || "utf8") : Buffer.from(tag);
    return this;
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

// ---- Keys --------------------------------------------------------------------
// Asymmetric keys are held as normalized DER: PKCS#8 (private) or
// SubjectPublicKeyInfo (public), converted by the Rust ops in src/crypto.rs.

const constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
};

const kKey = Symbol("key");

function pemDecode(text) {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) return null;
  return { label: match[1], der: Buffer.from(match[2].replace(/[\r\n\t ]|Proc-Type:.*|DEK-Info:.*/g, ""), "base64") };
}

function pemEncode(label, der) {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

const HASH_NAMES = { sha1: "sha1", sha256: "sha256", sha384: "sha384", sha512: "sha512" };

function digestName(algorithm) {
  const name = String(algorithm).toLowerCase().replace(/^rsa-/, "").replace(/-/g, "");
  const hashName = HASH_NAMES[name];
  if (!hashName) throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  return hashName;
}

class KeyObject {
  constructor(type, handle) {
    if (handle?.[kKey] !== true) throw new TypeError("Illegal constructor");
    this._type = type;
    this._der = handle.der;
    this._info = handle.info;
  }

  get type() {
    return this._type;
  }

  get asymmetricKeyType() {
    return this._type === "secret" ? undefined : this._info.asymmetric_type;
  }

  get asymmetricKeyDetails() {
    if (this._type === "secret") return undefined;
    if (this._info.asymmetric_type === "rsa") return { modulusLength: this._info.bits, publicExponent: 65537n };
    if (this._info.asymmetric_type === "ec") return { namedCurve: this._info.curve };
    return {};
  }

  get symmetricKeySize() {
    return this._type === "secret" ? this._der.length : undefined;
  }

  export(options = {}) {
    if (this._type === "secret") {
      if (options.format === "jwk") return { kty: "oct", k: this._der.toString("base64url") };
      return Buffer.from(this._der);
    }
    const { format = "pem", type } = options;
    if (format === "jwk") return __jse.derToJwk(this._type, this._der, this._info);
    const wanted = this._type === "private" ? "pkcs8" : "spki";
    if (type !== undefined && type !== wanted) {
      throw codeError(TypeError, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", `Exporting ${this._type} keys as '${type}' is not supported (use '${wanted}')`);
    }
    if (options.cipher !== undefined || options.passphrase !== undefined) {
      throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Encrypted key export is not supported");
    }
    if (format === "der") return Buffer.from(this._der);
    if (format === "pem") return pemEncode(this._type === "private" ? "PRIVATE KEY" : "PUBLIC KEY", this._der);
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.format' is invalid. Received '${format}'`);
  }

  equals(other) {
    return other instanceof KeyObject && other._type === this._type && Buffer.from(this._der).equals(Buffer.from(other._der));
  }

  get [Symbol.toStringTag]() {
    return "KeyObject";
  }
}

function makeKey(type, der, info) {
  return new KeyObject(type, { [kKey]: true, der: Buffer.from(der), info });
}

// key: KeyObject | PEM string/Buffer | { key, format, type, encoding }.
function prepareKey(input, wantPrivate) {
  if (input instanceof KeyObject) return input;
  let key = input;
  let format;
  let encoding;
  if (key && typeof key === "object" && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer)) {
    if (key.passphrase !== undefined) {
      throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Encrypted private keys are not supported");
    }
    format = key.format;
    encoding = key.encoding;
    key = key.key;
    if (key instanceof KeyObject) return key;
  }
  if (format === "jwk") {
    const converted = __jse.jwkToDer(key);
    if (converted.secret) return createSecretKey(converted.der);
    const info = ops.op_crypto_key_import(converted.der, converted.isPrivate);
    return makeKey(converted.isPrivate ? "private" : "public", info.der, info);
  }
  let der;
  let isPrivate = wantPrivate;
  if (format === "der") {
    der = toBuffer(key, encoding);
  } else {
    const text = typeof key === "string" ? key : toBuffer(key).toString("latin1");
    const pem = pemDecode(text);
    if (!pem) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid key: expected a PEM encoded key");
    if (pem.label.startsWith("ENCRYPTED") || /Proc-Type: 4,ENCRYPTED/.test(text)) {
      throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Encrypted private keys are not supported");
    }
    if (pem.label === "CERTIFICATE") {
      throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Reading keys from certificates is not supported");
    }
    isPrivate = pem.label.endsWith("PRIVATE KEY");
    der = pem.der;
  }
  const info = ops.op_crypto_key_import(der, isPrivate);
  return makeKey(isPrivate ? "private" : "public", info.der, info);
}

function createPrivateKey(key) {
  const k = prepareKey(key, true);
  if (k.type !== "private") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Expected a private key");
  return k;
}

// A private key (or its PEM) yields its public half.
function createPublicKey(key) {
  const k = prepareKey(key, false);
  if (k.type === "public") return k;
  if (k.type !== "private") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Expected an asymmetric key");
  const spki = ops.op_crypto_public_from_private(k._info.asymmetric_type, k._der, k._info.curve ?? "");
  return prepareKey({ key: spki, format: "der" }, false);
}

function createSecretKey(key, encoding) {
  return makeKey("secret", toBuffer(key, encoding), null);
}

const EC_CURVES = { "prime256v1": "prime256v1", "p-256": "prime256v1", "secp256r1": "prime256v1", "secp384r1": "secp384r1", "p-384": "secp384r1", "secp521r1": "secp521r1", "p-521": "secp521r1" };

function encodeKey(key, encoding) {
  if (!encoding) return key;
  return key.export(encoding);
}

function generateKeyPairSync(type, options = {}) {
  const kind = String(type).toLowerCase();
  let bits = 0;
  let curve = "";
  if (kind === "rsa") {
    bits = options.modulusLength;
    if (options.publicExponent !== undefined && options.publicExponent !== 65537) {
      throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Only publicExponent 65537 is supported");
    }
  } else if (kind === "ec") {
    curve = EC_CURVES[String(options.namedCurve).toLowerCase()];
    if (!curve) throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", `Invalid EC curve name: ${options.namedCurve}`);
  } else if (kind !== "ed25519") {
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' must be one of 'rsa', 'ec', 'ed25519'. Received '${type}'`);
  }
  const pair = ops.op_crypto_generate_key_pair(kind, bits ?? 0, curve);
  const privateKey = prepareKey({ key: pair.private, format: "der" }, true);
  const publicKey = prepareKey({ key: pair.public, format: "der" }, false);
  return {
    publicKey: encodeKey(publicKey, options.publicKeyEncoding),
    privateKey: encodeKey(privateKey, options.privateKeyEncoding),
  };
}

function generateKeyPair(type, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  let result;
  try {
    result = generateKeyPairSync(type, options);
  } catch (err) {
    queueMicrotask(() => callback(err));
    return;
  }
  queueMicrotask(() => callback(null, result.publicKey, result.privateKey));
}
generateKeyPair[Symbol.for("nodejs.util.promisify.custom")] = (type, options) =>
  new Promise((resolve, reject) => {
    generateKeyPair(type, options, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
  });

// ---- Signatures ---------------------------------------------------------------

function signSpec(algorithm, key, options) {
  const type = key.asymmetricKeyType;
  const padding = options?.padding ?? constants.RSA_PKCS1_PADDING;
  const pss = type === "rsa" && padding === constants.RSA_PKCS1_PSS_PADDING;
  const saltLength = options?.saltLength;
  if (pss && saltLength !== undefined && saltLength >= 0 && saltLength !== { sha256: 32, sha384: 48, sha512: 64 }[digestName(algorithm ?? "sha256")]) {
    throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "RSA-PSS saltLength must equal the digest length");
  }
  return {
    kind: type,
    hash: type === "ed25519" ? "" : digestName(algorithm ?? "sha256"),
    curve: key._info.curve ?? "",
    bits: key._info.bits ?? 0,
    pss,
    fixed: options?.dsaEncoding === "ieee-p1363",
  };
}

// key options may carry padding / saltLength / dsaEncoding next to `key`.
const keyOptions = (key) => (key && typeof key === "object" && !(key instanceof KeyObject) && !ArrayBuffer.isView(key) ? key : {});

function sign(algorithm, data, key, callback) {
  const k = createPrivateKey(key);
  const sig = Buffer.from(ops.op_crypto_sign(signSpec(algorithm, k, keyOptions(key)), k._der, inputBytes(data)));
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, sig));
    return undefined;
  }
  return sig;
}

function verify(algorithm, data, key, signature, callback) {
  const k = createPublicKey(key);
  const ok = ops.op_crypto_verify(signSpec(algorithm, k, keyOptions(key)), k._der, inputBytes(data), inputBytes(signature));
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, ok));
    return undefined;
  }
  return ok;
}

class Sign {
  #algorithm;
  #chunks = [];

  constructor(algorithm) {
    this.#algorithm = digestName(algorithm);
  }

  update(data, encoding) {
    this.#chunks.push(toBuffer(data, encoding));
    return this;
  }

  sign(key, outputEncoding) {
    return output(sign(this.#algorithm, Buffer.concat(this.#chunks), key), outputEncoding);
  }
}

class Verify {
  #algorithm;
  #chunks = [];

  constructor(algorithm) {
    this.#algorithm = digestName(algorithm);
  }

  update(data, encoding) {
    this.#chunks.push(toBuffer(data, encoding));
    return this;
  }

  verify(key, signature, signatureEncoding) {
    return verify(this.#algorithm, Buffer.concat(this.#chunks), key, toBuffer(signature, signatureEncoding));
  }
}

const createSign = (algorithm) => new Sign(algorithm);
const createVerify = (algorithm) => new Verify(algorithm);

// ---- RSA encryption -----------------------------------------------------------
// Node's default padding is OAEP with SHA-1.

function rsaPadding(key) {
  const opts = keyOptions(key);
  const padding = opts.padding ?? constants.RSA_PKCS1_OAEP_PADDING;
  if (padding === constants.RSA_PKCS1_PADDING) return "";
  if (padding === constants.RSA_PKCS1_OAEP_PADDING) return digestName(opts.oaepHash ?? "sha1");
  throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "Only OAEP and PKCS#1 v1.5 padding are supported");
}

function publicEncrypt(key, buffer) {
  const k = createPublicKey(key);
  return Buffer.from(ops.op_crypto_rsa_encrypt(k._der, inputBytes(buffer), rsaPadding(key)));
}

function privateDecrypt(key, buffer) {
  const k = createPrivateKey(key);
  return Buffer.from(ops.op_crypto_rsa_decrypt(k._der, inputBytes(buffer), rsaPadding(key)));
}

function getCurves() {
  return ["prime256v1", "secp384r1", "secp521r1", "x25519"];
}

class ECDH {
  #curve;
  #privateKey = null;
  #publicKey = null;

  constructor(curve) {
    this.#curve = String(curve);
  }

  generateKeys(encoding, format) {
    const kp = ops.op_crypto_ecdh_generate(this.#curve);
    this.#privateKey = Buffer.from(kp.private_key);
    this.#publicKey = Buffer.from(kp.public_key);
    const pub = this.getPublicKey(encoding, format);
    return pub;
  }

  computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
    if (!this.#privateKey) throw codeError(Error, "ERR_CRYPTO_ECDH_INVALID_FORMAT", "ECDH key not generated");
    const peer = inputBytes(otherPublicKey, inputEncoding, "otherPublicKey");
    const secret = Buffer.from(ops.op_crypto_ecdh_compute(this.#curve, this.#privateKey, peer));
    return outputEncoding ? secret.toString(outputEncoding) : secret;
  }

  getPrivateKey(encoding) {
    if (!this.#privateKey) return null;
    return encoding ? this.#privateKey.toString(encoding) : this.#privateKey;
  }

  getPublicKey(encoding, format) {
    if (!this.#publicKey) return null;
    return encoding ? this.#publicKey.toString(encoding) : this.#publicKey;
  }

  setPrivateKey(key, encoding) {
    this.#privateKey = inputBytes(key, encoding, "key");
    // Recompute public key from private - not trivially available from the op.
    // Generate a fresh pair and keep only the public key if needed.
    this.#publicKey = null;
  }

  setPublicKey(key, encoding) {
    this.#publicKey = inputBytes(key, encoding, "key");
  }
}

function createECDH(curve) {
  return new ECDH(curve);
}

function diffieHellman(options) {
  const { privateKey, publicKey } = options;
  if (!privateKey || !publicKey) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "privateKey and publicKey are required");
  // Determine curve from key info
  const curve = privateKey.asymmetricKeyDetails?.namedCurve ||
    privateKey._curve || publicKey._curve || "prime256v1";
  const priv = privateKey._der || privateKey;
  const pub = publicKey._der || publicKey;
  return Buffer.from(ops.op_crypto_ecdh_compute(curve, inputBytes(priv), inputBytes(pub)));
}

export {
  Hash,
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKeyPair,
  createSign,
  createVerify,
  Sign,
  Verify,
  publicEncrypt,
  privateDecrypt,
  getCurves,
  constants,
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
  ECDH,
  createECDH,
  diffieHellman,
};
export default {
  Hash,
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKeyPair,
  createSign,
  createVerify,
  Sign,
  Verify,
  publicEncrypt,
  privateDecrypt,
  getCurves,
  constants,
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
  ECDH,
  createECDH,
  diffieHellman,
};
