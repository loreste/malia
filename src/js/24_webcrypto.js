// WebCrypto (crypto.subtle, CryptoKey) and the JWK <-> DER conversion that
// node:crypto shares. Asymmetric keys live as DER (PKCS#8 private, SPKI
// public); the ops in src/crypto.rs parse, generate, sign, and encrypt.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  const u8 = (x) => (x instanceof Uint8Array ? x : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x));
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };
  const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
  const fromB64u = (s) => new Uint8Array(Buffer.from(String(s), "base64url"));
  const hex = (s) => new Uint8Array(Buffer.from(s, "hex"));

  // ---- Minimal DER --------------------------------------------------------------

  function derLength(n) {
    if (n < 0x80) return [n];
    const bytes = [];
    for (; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
    return [0x80 | bytes.length, ...bytes];
  }

  const tlv = (tag, content) => concat(new Uint8Array([tag, ...derLength(content.length)]), content);

  function derInt(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const v = bytes.subarray(i);
    return tlv(0x02, v[0] & 0x80 ? concat(new Uint8Array([0]), v) : v);
  }

  const derSeq = (...parts) => tlv(0x30, concat(...parts));

  // Parse one TLV at `pos`: { tag, start, end } (content range).
  function derRead(buf, pos) {
    const tag = buf[pos];
    let len = buf[pos + 1];
    let start = pos + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
      start += n;
    }
    return { tag, start, end: start + len };
  }

  function derChildren(buf, node) {
    const out = [];
    for (let pos = node.start; pos < node.end; ) {
      const child = derRead(buf, pos);
      out.push(child);
      pos = child.end;
    }
    return out;
  }

  const derUint = (buf, node) => {
    let v = buf.subarray(node.start, node.end);
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    return v;
  };

  // ---- JWK <-> DER ----------------------------------------------------------------

  const CURVES = {
    "P-256": { name: "prime256v1", size: 32, oid: "06082a8648ce3d030107", spki: "3059301306072a8648ce3d020106082a8648ce3d030107034200" },
    "P-384": { name: "secp384r1", size: 48, oid: "06052b81040022", spki: "3076301006072a8648ce3d020106052b81040022036200" },
    "P-521": { name: "secp521r1", size: 66, oid: "06052b81040023", spki: "30819b301006072a8648ce3d020106052b8104002303818600" },
  };
  const CURVE_BY_NODE_NAME = Object.fromEntries(Object.entries(CURVES).map(([crv, c]) => [c.name, crv]));
  const ED25519_SPKI = "302a300506032b6570032100";
  const ED25519_PKCS8 = "302e020100300506032b657004220420";

  // JWK -> { der, isPrivate } in a form op_crypto_key_import accepts.
  function jwkToDer(jwk) {
    const isPrivate = jwk.d !== undefined;
    if (jwk.kty === "RSA") {
      const fields = isPrivate ? ["n", "e", "d", "p", "q", "dp", "dq", "qi"] : ["n", "e"];
      const ints = fields.map((f) => {
        if (jwk[f] === undefined) throw new DOMException(`JWK is missing "${f}"`, "DataError");
        return derInt(fromB64u(jwk[f]));
      });
      return { der: isPrivate ? derSeq(derInt(new Uint8Array([0])), ...ints) : derSeq(...ints), isPrivate };
    }
    if (jwk.kty === "EC") {
      const curve = CURVES[jwk.crv];
      if (!curve) throw new DOMException(`Unsupported JWK curve: ${jwk.crv}`, "NotSupportedError");
      const point = concat(new Uint8Array([4]), fromB64u(jwk.x), fromB64u(jwk.y));
      if (!isPrivate) return { der: concat(hex(curve.spki), point), isPrivate };
      // SEC1 ECPrivateKey { version 1, d, [0] curve, [1] public point }
      const der = derSeq(
        derInt(new Uint8Array([1])),
        tlv(0x04, fromB64u(jwk.d)),
        tlv(0xa0, hex(curve.oid)),
        tlv(0xa1, tlv(0x03, concat(new Uint8Array([0]), point))),
      );
      return { der, isPrivate };
    }
    if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
      return isPrivate
        ? { der: concat(hex(ED25519_PKCS8), fromB64u(jwk.d)), isPrivate }
        : { der: concat(hex(ED25519_SPKI), fromB64u(jwk.x)), isPrivate };
    }
    if (jwk.kty === "oct") return { der: fromB64u(jwk.k), isPrivate: false, secret: true };
    throw new DOMException(`Unsupported JWK key type: ${jwk.kty}`, "NotSupportedError");
  }

  // The public point / x of an SPKI (the BIT STRING without its unused-bits byte).
  function spkiKeyBits(spki) {
    const [, bits] = derChildren(spki, derRead(spki, 0));
    return spki.subarray(bits.start + 1, bits.end);
  }

  // (type, der, info) -> JWK. Private keys include their public fields.
  function derToJwk(type, der, info) {
    der = u8(der);
    const isPrivate = type === "private";
    const spki = isPrivate ? u8(ops.op_crypto_public_from_private(info.asymmetric_type, der, info.curve ?? "")) : der;
    if (info.asymmetric_type === "rsa") {
      const pubBits = spkiKeyBits(spki);
      const [n, e] = derChildren(pubBits, derRead(pubBits, 0));
      const jwk = { kty: "RSA", n: b64u(derUint(pubBits, n)), e: b64u(derUint(pubBits, e)) };
      if (isPrivate) {
        const [, , octet] = derChildren(der, derRead(der, 0));
        const rsaKey = der.subarray(octet.start, octet.end);
        const ints = derChildren(rsaKey, derRead(rsaKey, 0));
        ["d", "p", "q", "dp", "dq", "qi"].forEach((f, i) => (jwk[f] = b64u(derUint(rsaKey, ints[i + 3]))));
      }
      return jwk;
    }
    if (info.asymmetric_type === "ec") {
      const crv = CURVE_BY_NODE_NAME[info.curve];
      const size = CURVES[crv].size;
      const point = spkiKeyBits(spki);
      const jwk = { kty: "EC", x: b64u(point.subarray(1, 1 + size)), y: b64u(point.subarray(1 + size)), crv };
      if (isPrivate) {
        const [, , octet] = derChildren(der, derRead(der, 0));
        const ecKey = der.subarray(octet.start, octet.end);
        const [, d] = derChildren(ecKey, derRead(ecKey, 0));
        jwk.d = b64u(ecKey.subarray(d.start, d.end));
      }
      return jwk;
    }
    // Node's member order for OKP keys: crv, d, x, kty.
    const x = b64u(spkiKeyBits(spki));
    if (!isPrivate) return { crv: "Ed25519", x, kty: "OKP" };
    const [, , octet] = derChildren(der, derRead(der, 0));
    const inner = derRead(der, octet.start);
    return { crv: "Ed25519", d: b64u(der.subarray(inner.start, inner.end)), x, kty: "OKP" };
  }

  globalThis.__jse.jwkToDer = jwkToDer;
  globalThis.__jse.derToJwk = derToJwk;

  // ---- CryptoKey ------------------------------------------------------------------

  const kMaterial = Symbol("material");
  const kInfo = Symbol("info");

  class CryptoKey {
    constructor() {
      throw new TypeError("Illegal constructor");
    }

    get [Symbol.toStringTag]() {
      return "CryptoKey";
    }
  }

  function makeKey(type, extractable, algorithm, usages, material, info = null) {
    const key = Object.create(CryptoKey.prototype);
    Object.defineProperties(key, {
      type: { value: type, enumerable: true },
      extractable: { value: extractable, enumerable: true },
      algorithm: { value: Object.freeze(algorithm), enumerable: true },
      usages: { value: Object.freeze([...usages]), enumerable: true },
    });
    key[kMaterial] = material;
    key[kInfo] = info;
    return key;
  }

  // ---- Algorithm helpers --------------------------------------------------------------

  const HASHES = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
  const HASH_LEN = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  const HASH_BLOCK = { sha1: 64, sha256: 64, sha384: 128, sha512: 128 };

  const notSupported = (what) => new DOMException(`${what} is not supported`, "NotSupportedError");

  function normalize(algorithm) {
    const alg = typeof algorithm === "string" ? { name: algorithm } : { ...algorithm };
    const names = [
      "AES-GCM", "AES-CBC", "AES-CTR", "HMAC", "RSASSA-PKCS1-v1_5", "RSA-PSS", "RSA-OAEP", "ECDSA",
      "Ed25519", "PBKDF2", "HKDF", "SHA-1", "SHA-256", "SHA-384", "SHA-512",
    ];
    const name = names.find((n) => n.toUpperCase() === String(alg.name).toUpperCase());
    if (!name) throw notSupported(`Algorithm ${alg.name}`);
    alg.name = name;
    if (alg.hash !== undefined) alg.hash = { name: normalize(alg.hash).name };
    return alg;
  }

  function hashOf(alg, key) {
    const name = alg?.hash?.name ?? key?.algorithm?.hash?.name;
    const hash = HASHES[name];
    if (!hash) throw notSupported(`Hash ${name}`);
    return hash;
  }

  function checkKey(key, alg, usage) {
    if (!(key instanceof CryptoKey)) throw new TypeError("key is not a CryptoKey");
    if (key.algorithm.name !== alg.name) {
      throw new DOMException(`The key is for ${key.algorithm.name}, not ${alg.name}`, "InvalidAccessError");
    }
    if (!key.usages.includes(usage)) {
      throw new DOMException(`The key does not support the '${usage}' operation`, "InvalidAccessError");
    }
  }

  const bytesOf = (data) => {
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return u8(data).slice();
    throw new TypeError("data is not a BufferSource");
  };
  const toArrayBuffer = (bytes) => u8(bytes).slice().buffer;

  function hmac(hash, key, data) {
    const id = ops.op_hmac_new(hash, key);
    ops.op_hmac_update(id, data);
    return u8(ops.op_hmac_digest(id));
  }

  // RFC 5869 HKDF on HMAC.
  function hkdf(hash, ikm, salt, info, length) {
    const prk = hmac(hash, salt.length ? salt : new Uint8Array(HASH_LEN[hash]), ikm);
    const out = new Uint8Array(length);
    let t = new Uint8Array(0);
    for (let i = 1, off = 0; off < length; i++) {
      t = hmac(hash, prk, concat(t, info, new Uint8Array([i])));
      out.set(t.subarray(0, Math.min(t.length, length - off)), off);
      off += t.length;
    }
    return out;
  }

  const SECRET_ALGS = ["AES-GCM", "AES-CBC", "AES-CTR", "HMAC", "PBKDF2", "HKDF"];
  const ASYM_TYPE = { "RSASSA-PKCS1-v1_5": "rsa", "RSA-PSS": "rsa", "RSA-OAEP": "rsa", ECDSA: "ec", Ed25519: "ed25519" };
  const PUBLIC_USAGES = ["verify", "encrypt", "wrapKey"];

  function asymmetricKey(alg, info, der, isPrivate, extractable, usages) {
    const algorithm = { name: alg.name };
    if (info.asymmetric_type === "rsa") {
      Object.assign(algorithm, {
        modulusLength: info.bits,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: alg.hash ?? { name: "SHA-256" },
      });
    } else if (info.asymmetric_type === "ec") {
      algorithm.namedCurve = CURVE_BY_NODE_NAME[info.curve];
    }
    const allowed = isPrivate ? usages.filter((u) => !PUBLIC_USAGES.includes(u)) : usages.filter((u) => PUBLIC_USAGES.includes(u));
    return makeKey(isPrivate ? "private" : "public", isPrivate ? extractable : true, algorithm, allowed, u8(der), info);
  }

  function importAsymmetric(alg, der, isPrivate, extractable, usages) {
    let info;
    try {
      info = ops.op_crypto_key_import(der, isPrivate);
    } catch (err) {
      throw new DOMException(err.message, "DataError");
    }
    if (info.asymmetric_type !== ASYM_TYPE[alg.name]) {
      throw new DOMException(`Key type ${info.asymmetric_type} does not match ${alg.name}`, "DataError");
    }
    if (alg.name === "ECDSA" && alg.namedCurve && CURVE_BY_NODE_NAME[info.curve] !== alg.namedCurve) {
      throw new DOMException("namedCurve does not match the key", "DataError");
    }
    return asymmetricKey(alg, info, info.der, isPrivate, extractable, usages);
  }

  function signSpec(key, alg) {
    const info = key[kInfo];
    return {
      kind: info.asymmetric_type,
      hash: info.asymmetric_type === "ed25519" ? "" : hashOf(alg.name === "ECDSA" ? alg : null, key),
      curve: info.curve ?? "",
      bits: info.bits ?? 0,
      pss: alg.name === "RSA-PSS",
      fixed: alg.name === "ECDSA", // WebCrypto ECDSA signatures are raw r||s
    };
  }

  function checkPss(alg, key) {
    if (alg.name === "RSA-PSS" && alg.saltLength !== HASH_LEN[hashOf(null, key)]) {
      throw notSupported("RSA-PSS saltLength other than the digest length");
    }
  }

  function aesCipher(alg, key, data, decrypt) {
    const raw = key[kMaterial];
    const bits = raw.length * 8;
    if (alg.name === "AES-GCM") {
      if (alg.tagLength !== undefined && alg.tagLength !== 128) throw notSupported("AES-GCM tagLength other than 128");
      if (bits === 192) throw notSupported("AES-192-GCM");
      const name = `aes-${bits}-gcm`;
      const iv = bytesOf(alg.iv);
      const aad = alg.additionalData ? bytesOf(alg.additionalData) : new Uint8Array(0);
      if (!decrypt) {
        const res = ops.op_crypto_cipher_encrypt(name, raw, iv, data, aad);
        return concat(u8(res.ciphertext), u8(res.tag));
      }
      if (data.length < 16) throw new DOMException("The provided data is too small", "OperationError");
      try {
        return u8(ops.op_crypto_cipher_decrypt(name, raw, iv, data.subarray(0, -16), data.subarray(-16), aad));
      } catch {
        throw new DOMException("The operation failed for an operation-specific reason", "OperationError");
      }
    }
    const iv = bytesOf(alg.name === "AES-CTR" ? alg.counter : alg.iv);
    const mode = alg.name === "AES-CTR" ? "ctr" : "cbc";
    try {
      const id = ops.op_crypto_stream_cipher_new(`aes-${bits}-${mode}`, raw, iv, decrypt);
      return concat(u8(ops.op_crypto_stream_cipher_update(id, data)), u8(ops.op_crypto_stream_cipher_final(id)));
    } catch (err) {
      throw new DOMException(err.message, "OperationError");
    }
  }

  // The JWK "alg" member Node emits for each key algorithm (none for ECDSA).
  function jwkAlg(key) {
    const { name, hash, length } = key.algorithm;
    const bits = hash?.name?.slice(4);
    const alg = {
      HMAC: bits === "1" ? "HS1" : `HS${bits}`,
      "RSASSA-PKCS1-v1_5": `RS${bits}`,
      "RSA-PSS": `PS${bits}`,
      "RSA-OAEP": bits === "1" ? "RSA-OAEP" : `RSA-OAEP-${bits}`,
      "AES-GCM": `A${length}GCM`,
      "AES-CBC": `A${length}CBC`,
      "AES-CTR": `A${length}CTR`,
      Ed25519: "Ed25519",
    }[name];
    return alg ? { alg } : {};
  }

  // ---- SubtleCrypto ---------------------------------------------------------------

  const subtle = {
    async digest(algorithm, data) {
      const alg = normalize(algorithm);
      const hash = HASHES[alg.name];
      if (!hash) throw notSupported(`Digest ${alg.name}`);
      const id = ops.op_crypto_hash_new(hash);
      ops.op_crypto_hash_update(id, bytesOf(data));
      return toArrayBuffer(ops.op_crypto_hash_digest(id));
    },

    async generateKey(algorithm, extractable, usages) {
      const alg = normalize(algorithm);
      if (alg.name === "HMAC") {
        const hash = hashOf(alg);
        const length = alg.length ?? HASH_BLOCK[hash] * 8;
        return makeKey("secret", extractable, { name: "HMAC", hash: alg.hash, length }, usages, u8(ops.op_crypto_random_bytes(length / 8)));
      }
      if (alg.name.startsWith("AES-")) {
        if (![128, 192, 256].includes(alg.length)) throw new DOMException("AES key length must be 128, 192, or 256", "OperationError");
        return makeKey("secret", extractable, { name: alg.name, length: alg.length }, usages, u8(ops.op_crypto_random_bytes(alg.length / 8)));
      }
      const kind = ASYM_TYPE[alg.name];
      if (!kind) throw notSupported(`generateKey for ${alg.name}`);
      let curve = "";
      if (kind === "ec") {
        curve = CURVES[alg.namedCurve]?.name;
        if (!curve) throw notSupported(`Curve ${alg.namedCurve}`);
      }
      if (kind === "rsa" && alg.publicExponent && Buffer.from(u8(alg.publicExponent)).toString("hex").replace(/^0+/, "") !== "10001") {
        throw notSupported("publicExponent other than 65537");
      }
      const pair = ops.op_crypto_generate_key_pair(kind, alg.modulusLength ?? 0, curve);
      return {
        publicKey: importAsymmetric(alg, u8(pair.public), false, true, usages),
        privateKey: importAsymmetric(alg, u8(pair.private), true, extractable, usages),
      };
    },

    async importKey(format, keyData, algorithm, extractable, usages) {
      const alg = normalize(algorithm);
      if (format === "jwk") {
        const converted = jwkToDer(keyData);
        if (converted.secret) return subtle.importKey("raw", converted.der, alg, extractable, usages);
        return importAsymmetric(alg, converted.der, converted.isPrivate, extractable, usages);
      }
      if (SECRET_ALGS.includes(alg.name)) {
        if (format !== "raw") throw notSupported(`Importing ${alg.name} keys as ${format}`);
        const raw = bytesOf(keyData);
        const algorithm = alg.name === "HMAC"
          ? { name: "HMAC", hash: alg.hash, length: alg.length ?? raw.length * 8 }
          : alg.name.startsWith("AES-") ? { name: alg.name, length: raw.length * 8 } : { name: alg.name };
        if (algorithm.name.startsWith("AES-") && ![16, 24, 32].includes(raw.length)) {
          throw new DOMException("Invalid AES key length", "DataError");
        }
        return makeKey("secret", extractable, algorithm, usages, raw);
      }
      if (format === "spki") return importAsymmetric(alg, bytesOf(keyData), false, extractable, usages);
      if (format === "pkcs8") return importAsymmetric(alg, bytesOf(keyData), true, extractable, usages);
      if (format === "raw") {
        const raw = bytesOf(keyData);
        if (alg.name === "Ed25519") return importAsymmetric(alg, concat(hex(ED25519_SPKI), raw), false, extractable, usages);
        if (alg.name === "ECDSA" && CURVES[alg.namedCurve]) {
          return importAsymmetric(alg, concat(hex(CURVES[alg.namedCurve].spki), raw), false, extractable, usages);
        }
      }
      throw notSupported(`Importing ${alg.name} keys as ${format}`);
    },

    async exportKey(format, key) {
      if (!(key instanceof CryptoKey)) throw new TypeError("key is not a CryptoKey");
      if (!key.extractable) throw new DOMException("The key is not extractable", "InvalidAccessError");
      const material = key[kMaterial];
      if (key.type === "secret") {
        if (format === "raw") return toArrayBuffer(material);
        if (format === "jwk") return { key_ops: [...key.usages], ext: true, ...jwkAlg(key), kty: "oct", k: b64u(material) };
        throw notSupported(`Exporting secret keys as ${format}`);
      }
      if (format === "jwk") return { key_ops: [...key.usages], ext: true, ...jwkAlg(key), ...derToJwk(key.type, material, key[kInfo]) };
      if (format === "spki" && key.type === "public") return toArrayBuffer(material);
      if (format === "pkcs8" && key.type === "private") return toArrayBuffer(material);
      if (format === "raw" && key.type === "public" && key[kInfo].asymmetric_type !== "rsa") {
        return toArrayBuffer(spkiKeyBits(material));
      }
      throw new DOMException(`Cannot export a ${key.type} key as ${format}`, "InvalidAccessError");
    },

    async sign(algorithm, key, data) {
      const alg = normalize(algorithm);
      checkKey(key, alg, "sign");
      if (alg.name === "HMAC") return toArrayBuffer(hmac(hashOf(null, key), key[kMaterial], bytesOf(data)));
      checkPss(alg, key);
      return toArrayBuffer(ops.op_crypto_sign(signSpec(key, alg), key[kMaterial], bytesOf(data)));
    },

    async verify(algorithm, key, signature, data) {
      const alg = normalize(algorithm);
      checkKey(key, alg, "verify");
      if (alg.name === "HMAC") {
        const expected = hmac(hashOf(null, key), key[kMaterial], bytesOf(data));
        const sig = bytesOf(signature);
        return sig.length === expected.length && ops.op_crypto_timing_safe_equal(sig, expected);
      }
      checkPss(alg, key);
      return ops.op_crypto_verify(signSpec(key, alg), key[kMaterial], bytesOf(data), bytesOf(signature));
    },

    async encrypt(algorithm, key, data) {
      const alg = normalize(algorithm);
      checkKey(key, alg, "encrypt");
      if (alg.name === "RSA-OAEP") {
        if (alg.label !== undefined && bytesOf(alg.label).length) throw notSupported("RSA-OAEP label");
        return toArrayBuffer(ops.op_crypto_rsa_encrypt(key[kMaterial], bytesOf(data), hashOf(null, key)));
      }
      return toArrayBuffer(aesCipher(alg, key, bytesOf(data), false));
    },

    async decrypt(algorithm, key, data) {
      const alg = normalize(algorithm);
      checkKey(key, alg, "decrypt");
      if (alg.name === "RSA-OAEP") {
        try {
          return toArrayBuffer(ops.op_crypto_rsa_decrypt(key[kMaterial], bytesOf(data), hashOf(null, key)));
        } catch (err) {
          throw new DOMException(err.message, "OperationError");
        }
      }
      return toArrayBuffer(aesCipher(alg, key, bytesOf(data), true));
    },

    async deriveBits(algorithm, baseKey, length) {
      const alg = normalize(algorithm);
      checkKey(baseKey, alg, "deriveBits");
      if (length === null || length % 8 !== 0) throw new DOMException("length must be a multiple of 8", "OperationError");
      const hash = hashOf(alg);
      if (alg.name === "PBKDF2") {
        return toArrayBuffer(ops.op_crypto_pbkdf2(hash, baseKey[kMaterial], bytesOf(alg.salt), alg.iterations, length / 8));
      }
      if (alg.name === "HKDF") {
        return toArrayBuffer(hkdf(hash, baseKey[kMaterial], bytesOf(alg.salt), bytesOf(alg.info), length / 8));
      }
      throw notSupported(`deriveBits for ${alg.name}`);
    },

    async deriveKey(algorithm, baseKey, derivedKeyAlgorithm, extractable, usages) {
      const target = normalize(derivedKeyAlgorithm);
      const length = target.length ?? (target.name === "HMAC" ? HASH_BLOCK[hashOf(target)] * 8 : undefined);
      if (!length) throw new DOMException("The derived key algorithm needs a length", "OperationError");
      const alg = normalize(algorithm);
      checkKey(baseKey, alg, "deriveKey");
      const key = makeKey("secret", false, baseKey.algorithm, ["deriveBits"], baseKey[kMaterial]);
      const bits = await subtle.deriveBits(alg, key, length);
      return subtle.importKey("raw", bits, target, extractable, usages);
    },

    async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      const exported = await subtle.exportKey(format, key);
      const bytes = format === "jwk" ? new TextEncoder().encode(JSON.stringify(exported)) : exported;
      const alg = normalize(wrapAlgorithm);
      checkKey(wrappingKey, alg, "wrapKey");
      const unwrapped = makeKey(wrappingKey.type, true, wrappingKey.algorithm, ["encrypt"], wrappingKey[kMaterial], wrappingKey[kInfo]);
      return subtle.encrypt(alg, unwrapped, bytes);
    },

    async unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, usages) {
      const alg = normalize(unwrapAlgorithm);
      checkKey(unwrappingKey, alg, "unwrapKey");
      const key = makeKey(unwrappingKey.type, true, unwrappingKey.algorithm, ["decrypt"], unwrappingKey[kMaterial], unwrappingKey[kInfo]);
      const bytes = await subtle.decrypt(alg, key, wrappedKey);
      const data = format === "jwk" ? JSON.parse(new TextDecoder().decode(bytes)) : bytes;
      return subtle.importKey(format, data, unwrappedKeyAlgorithm, extractable, usages);
    },
  };

  const SubtleCrypto = function SubtleCrypto() {
    throw new TypeError("Illegal constructor");
  };
  Object.setPrototypeOf(subtle, SubtleCrypto.prototype);

  globalThis.crypto.subtle = subtle;
  globalThis.CryptoKey = CryptoKey;
  globalThis.SubtleCrypto = SubtleCrypto;
})(globalThis);
