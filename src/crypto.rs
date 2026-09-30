// Asymmetric keys, signatures, RSA encryption, and streaming AES-CBC/CTR for
// node:crypto and WebCrypto, on aws-lc-rs (already in the tree as rustls's
// provider). Keys cross into JS as normalized DER: PKCS#8 for private keys,
// SubjectPublicKeyInfo for public keys.
use std::collections::HashMap;

use aws_lc_rs::cipher::{
  DecryptionContext, EncryptionContext, StreamingDecryptingKey, StreamingEncryptingKey, UnboundCipherKey,
  AES_128, AES_192, AES_256,
};
use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::{self, KeySize};
use aws_lc_rs::signature::{self, EcdsaKeyPair, EcdsaSigningAlgorithm, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use deno_core::{OpState, op2};
use deno_error::JsErrorBox;

fn err(msg: impl Into<String>) -> JsErrorBox {
  JsErrorBox::generic(msg.into())
}

fn type_err(msg: impl Into<String>) -> JsErrorBox {
  JsErrorBox::type_error(msg.into())
}

// ---- Key parsing ---------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct KeyInfo {
  /// "rsa" | "ec" | "ed25519"
  asymmetric_type: &'static str,
  #[serde(with = "serde_bytes")]
  der: Vec<u8>,
  /// Node's namedCurve for EC keys ("prime256v1", "secp384r1", "secp521r1").
  curve: Option<&'static str>,
  /// RSA modulus length in bits.
  bits: Option<u32>,
}

const CURVES: [(&str, &EcdsaSigningAlgorithm); 3] = [
  ("prime256v1", &signature::ECDSA_P256_SHA256_ASN1_SIGNING),
  ("secp384r1", &signature::ECDSA_P384_SHA384_ASN1_SIGNING),
  ("secp521r1", &signature::ECDSA_P521_SHA512_ASN1_SIGNING),
];

fn curve_alg(curve: &str) -> Result<&'static EcdsaSigningAlgorithm, JsErrorBox> {
  CURVES
    .iter()
    .find(|(name, _)| *name == curve)
    .map(|(_, alg)| *alg)
    .ok_or_else(|| type_err(format!("Unsupported EC curve: {curve}")))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
  haystack.windows(needle.len()).any(|w| w == needle)
}

// DER-encoded OIDs (tag, length, value) used to classify public keys.
const OID_EC: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_P521: &[u8] = &[0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23];
const OID_ED25519: &[u8] = &[0x06, 0x03, 0x2b, 0x65, 0x70];

fn private_key_info(der: &[u8]) -> Option<KeyInfo> {
  if let Ok(kp) = Ed25519KeyPair::from_pkcs8_maybe_unchecked(der) {
    return Some(KeyInfo {
      asymmetric_type: "ed25519",
      der: kp.to_pkcs8v1().ok()?.as_ref().to_vec(),
      curve: None,
      bits: None,
    });
  }
  let rsa_key = rsa::KeyPair::from_pkcs8(der).or_else(|_| rsa::KeyPair::from_der(der));
  if let Ok(kp) = rsa_key {
    let pkcs8: Pkcs8V1Der = kp.as_der().ok()?;
    return Some(KeyInfo {
      asymmetric_type: "rsa",
      der: pkcs8.as_ref().to_vec(),
      curve: None,
      bits: Some(kp.public_modulus_len() as u32 * 8),
    });
  }
  for (name, alg) in CURVES {
    let kp = EcdsaKeyPair::from_pkcs8(alg, der).or_else(|_| EcdsaKeyPair::from_private_key_der(alg, der));
    if let Ok(kp) = kp {
      return Some(KeyInfo {
        asymmetric_type: "ec",
        der: kp.to_pkcs8v1().ok()?.as_ref().to_vec(),
        curve: Some(name),
        bits: None,
      });
    }
  }
  None
}

fn public_key_info(der: &[u8]) -> Option<KeyInfo> {
  if contains(der, OID_EC) {
    let curve = if contains(der, OID_P256) {
      "prime256v1"
    } else if contains(der, OID_P384) {
      "secp384r1"
    } else if contains(der, OID_P521) {
      "secp521r1"
    } else {
      return None;
    };
    return Some(KeyInfo { asymmetric_type: "ec", der: der.to_vec(), curve: Some(curve), bits: None });
  }
  if contains(der, OID_ED25519) {
    return Some(KeyInfo { asymmetric_type: "ed25519", der: der.to_vec(), curve: None, bits: None });
  }
  // RSA: SubjectPublicKeyInfo or PKCS#1 RSAPublicKey, normalized to SPKI.
  let key = rsa::PublicKey::from_der(der).ok()?;
  let spki: PublicKeyX509Der = key.as_der().ok()?;
  Some(KeyInfo {
    asymmetric_type: "rsa",
    der: spki.as_ref().to_vec(),
    curve: None,
    bits: Some(key.modulus_len() as u32 * 8),
  })
}

/// Parse a DER key (PKCS#8, PKCS#1, or SEC1 private; SPKI or PKCS#1 public).
#[op2]
#[serde]
pub fn op_crypto_key_import(#[buffer] der: &[u8], is_private: bool) -> Result<KeyInfo, JsErrorBox> {
  let info = if is_private { private_key_info(der) } else { public_key_info(der) };
  info.ok_or_else(|| err(format!("Unsupported or invalid {} key", if is_private { "private" } else { "public" })))
}

/// SubjectPublicKeyInfo DER for a PKCS#8 private key.
#[op2]
#[buffer]
pub fn op_crypto_public_from_private(#[string] kind: String, #[buffer] pkcs8: &[u8], #[string] curve: String) -> Result<Vec<u8>, JsErrorBox> {
  public_from_private(&kind, pkcs8, &curve)
}

fn public_from_private(kind: &str, pkcs8: &[u8], curve: &str) -> Result<Vec<u8>, JsErrorBox> {
  let invalid = |_| err("Invalid private key");
  let spki: PublicKeyX509Der = match kind {
    "rsa" => rsa::KeyPair::from_pkcs8(pkcs8).map_err(invalid)?.public_key().as_der(),
    "ec" => EcdsaKeyPair::from_pkcs8(curve_alg(curve)?, pkcs8).map_err(invalid)?.public_key().as_der(),
    "ed25519" => Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8).map_err(invalid)?.public_key().as_der(),
    _ => return Err(type_err(format!("Unsupported key type: {kind}"))),
  }
  .map_err(|_| err("Could not encode public key"))?;
  Ok(spki.as_ref().to_vec())
}

#[derive(serde::Serialize)]
pub struct GeneratedKeyPair {
  #[serde(with = "serde_bytes")]
  private: Vec<u8>,
  #[serde(with = "serde_bytes")]
  public: Vec<u8>,
}

#[op2]
#[serde]
pub fn op_crypto_generate_key_pair(#[string] kind: String, bits: u32, #[string] curve: String) -> Result<GeneratedKeyPair, JsErrorBox> {
  let failed = |_| err("Key generation failed");
  let private = match kind.as_str() {
    "rsa" => {
      let size = match bits {
        2048 => KeySize::Rsa2048,
        3072 => KeySize::Rsa3072,
        4096 => KeySize::Rsa4096,
        8192 => KeySize::Rsa8192,
        _ => return Err(type_err(format!("Unsupported RSA modulusLength {bits} (supported: 2048, 3072, 4096, 8192)"))),
      };
      let pkcs8: Pkcs8V1Der = rsa::KeyPair::generate(size).map_err(failed)?.as_der().map_err(failed)?;
      pkcs8.as_ref().to_vec()
    }
    "ec" => EcdsaKeyPair::generate(curve_alg(&curve)?).map_err(failed)?.to_pkcs8v1().map_err(failed)?.as_ref().to_vec(),
    "ed25519" => Ed25519KeyPair::generate().map_err(failed)?.to_pkcs8v1().map_err(failed)?.as_ref().to_vec(),
    _ => return Err(type_err(format!("Unsupported key type: {kind}"))),
  };
  let public = public_from_private(&kind, &private, &curve)?;
  Ok(GeneratedKeyPair { private, public })
}

// ---- Signatures -----------------------------------------------------------------

fn rsa_signing(hash: &str, pss: bool) -> Result<&'static dyn signature::RsaEncoding, JsErrorBox> {
  Ok(match (hash, pss) {
    ("sha256", false) => &signature::RSA_PKCS1_SHA256,
    ("sha384", false) => &signature::RSA_PKCS1_SHA384,
    ("sha512", false) => &signature::RSA_PKCS1_SHA512,
    ("sha256", true) => &signature::RSA_PSS_SHA256,
    ("sha384", true) => &signature::RSA_PSS_SHA384,
    ("sha512", true) => &signature::RSA_PSS_SHA512,
    _ => return Err(type_err(format!("Unsupported RSA signature digest: {hash}"))),
  })
}

fn rsa_verification(hash: &str, pss: bool, bits: u32) -> Result<&'static dyn signature::VerificationAlgorithm, JsErrorBox> {
  let legacy = bits < 2048;
  Ok(match (hash, pss, legacy) {
    ("sha1", false, true) => &signature::RSA_PKCS1_1024_8192_SHA1_FOR_LEGACY_USE_ONLY,
    ("sha1", false, false) => &signature::RSA_PKCS1_2048_8192_SHA1_FOR_LEGACY_USE_ONLY,
    ("sha256", false, true) => &signature::RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY,
    ("sha512", false, true) => &signature::RSA_PKCS1_1024_8192_SHA512_FOR_LEGACY_USE_ONLY,
    ("sha256", false, false) => &signature::RSA_PKCS1_2048_8192_SHA256,
    ("sha384", false, false) => &signature::RSA_PKCS1_2048_8192_SHA384,
    ("sha512", false, false) => &signature::RSA_PKCS1_2048_8192_SHA512,
    ("sha256", true, false) => &signature::RSA_PSS_2048_8192_SHA256,
    ("sha384", true, false) => &signature::RSA_PSS_2048_8192_SHA384,
    ("sha512", true, false) => &signature::RSA_PSS_2048_8192_SHA512,
    _ => return Err(type_err(format!("Unsupported RSA verification: {hash}{} with {bits}-bit key", if pss { " (PSS)" } else { "" }))),
  })
}

fn ecdsa_signing(curve: &str, hash: &str, fixed: bool) -> Result<&'static EcdsaSigningAlgorithm, JsErrorBox> {
  Ok(match (curve, hash, fixed) {
    ("prime256v1", "sha256", false) => &signature::ECDSA_P256_SHA256_ASN1_SIGNING,
    ("prime256v1", "sha256", true) => &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
    ("secp384r1", "sha384", false) => &signature::ECDSA_P384_SHA384_ASN1_SIGNING,
    ("secp384r1", "sha384", true) => &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
    ("secp521r1", "sha256", false) => &signature::ECDSA_P521_SHA256_ASN1_SIGNING,
    ("secp521r1", "sha256", true) => &signature::ECDSA_P521_SHA256_FIXED_SIGNING,
    ("secp521r1", "sha384", false) => &signature::ECDSA_P521_SHA384_ASN1_SIGNING,
    ("secp521r1", "sha384", true) => &signature::ECDSA_P521_SHA384_FIXED_SIGNING,
    ("secp521r1", "sha512", false) => &signature::ECDSA_P521_SHA512_ASN1_SIGNING,
    ("secp521r1", "sha512", true) => &signature::ECDSA_P521_SHA512_FIXED_SIGNING,
    _ => return Err(type_err(format!("Unsupported ECDSA signing: {hash} with {curve}"))),
  })
}

fn ecdsa_verification(curve: &str, hash: &str, fixed: bool) -> Result<&'static dyn signature::VerificationAlgorithm, JsErrorBox> {
  Ok(match (curve, hash, fixed) {
    ("prime256v1", "sha256", false) => &signature::ECDSA_P256_SHA256_ASN1,
    ("prime256v1", "sha384", false) => &signature::ECDSA_P256_SHA384_ASN1,
    ("prime256v1", "sha512", false) => &signature::ECDSA_P256_SHA512_ASN1,
    ("prime256v1", "sha256", true) => &signature::ECDSA_P256_SHA256_FIXED,
    ("secp384r1", "sha256", false) => &signature::ECDSA_P384_SHA256_ASN1,
    ("secp384r1", "sha384", false) => &signature::ECDSA_P384_SHA384_ASN1,
    ("secp384r1", "sha512", false) => &signature::ECDSA_P384_SHA512_ASN1,
    ("secp384r1", "sha384", true) => &signature::ECDSA_P384_SHA384_FIXED,
    ("secp521r1", "sha256", false) => &signature::ECDSA_P521_SHA256_ASN1,
    ("secp521r1", "sha384", false) => &signature::ECDSA_P521_SHA384_ASN1,
    ("secp521r1", "sha512", false) => &signature::ECDSA_P521_SHA512_ASN1,
    ("secp521r1", "sha256", true) => &signature::ECDSA_P521_SHA256_FIXED,
    ("secp521r1", "sha384", true) => &signature::ECDSA_P521_SHA384_FIXED,
    ("secp521r1", "sha512", true) => &signature::ECDSA_P521_SHA512_FIXED,
    _ => return Err(type_err(format!("Unsupported ECDSA verification: {hash} with {curve}"))),
  })
}

#[derive(serde::Deserialize)]
pub struct SignSpec {
  kind: String,
  /// Normalized digest name ("sha256"); ignored for Ed25519.
  hash: String,
  curve: String,
  bits: u32,
  pss: bool,
  /// ECDSA dsaEncoding "ieee-p1363" (raw r||s) instead of DER.
  fixed: bool,
}

#[op2]
#[buffer]
pub fn op_crypto_sign(#[serde] spec: SignSpec, #[buffer] pkcs8: &[u8], #[buffer] data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
  let invalid = |_| err("Invalid private key");
  let failed = |_| err("Signing failed");
  let rng = SystemRandom::new();
  match spec.kind.as_str() {
    "rsa" => {
      let kp = rsa::KeyPair::from_pkcs8(pkcs8).map_err(invalid)?;
      let mut sig = vec![0u8; kp.public_modulus_len()];
      kp.sign(rsa_signing(&spec.hash, spec.pss)?, &rng, data, &mut sig).map_err(failed)?;
      Ok(sig)
    }
    "ec" => {
      let kp = EcdsaKeyPair::from_pkcs8(ecdsa_signing(&spec.curve, &spec.hash, spec.fixed)?, pkcs8).map_err(invalid)?;
      Ok(kp.sign(&rng, data).map_err(failed)?.as_ref().to_vec())
    }
    "ed25519" => Ok(Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8).map_err(invalid)?.sign(data).as_ref().to_vec()),
    kind => Err(type_err(format!("Unsupported key type for signing: {kind}"))),
  }
}

#[op2]
pub fn op_crypto_verify(
  #[serde] spec: SignSpec,
  #[buffer] spki: &[u8],
  #[buffer] data: &[u8],
  #[buffer] sig: &[u8],
) -> Result<bool, JsErrorBox> {
  let alg: &'static dyn signature::VerificationAlgorithm = match spec.kind.as_str() {
    "rsa" => rsa_verification(&spec.hash, spec.pss, spec.bits)?,
    "ec" => ecdsa_verification(&spec.curve, &spec.hash, spec.fixed)?,
    "ed25519" => &signature::ED25519,
    kind => return Err(type_err(format!("Unsupported key type for verification: {kind}"))),
  };
  Ok(UnparsedPublicKey::new(alg, spki).verify(data, sig).is_ok())
}

// ---- RSA encryption ---------------------------------------------------------------

fn oaep(hash: &str) -> Result<&'static rsa::OaepAlgorithm, JsErrorBox> {
  Ok(match hash {
    "sha1" => &rsa::OAEP_SHA1_MGF1SHA1,
    "sha256" => &rsa::OAEP_SHA256_MGF1SHA256,
    "sha384" => &rsa::OAEP_SHA384_MGF1SHA384,
    "sha512" => &rsa::OAEP_SHA512_MGF1SHA512,
    _ => return Err(type_err(format!("Unsupported OAEP digest: {hash}"))),
  })
}

/// RSA public-key encryption: OAEP with `oaep_hash`, or PKCS#1 v1.5 when empty.
#[op2]
#[buffer]
pub fn op_crypto_rsa_encrypt(#[buffer] spki: &[u8], #[buffer] data: &[u8], #[string] oaep_hash: String) -> Result<Vec<u8>, JsErrorBox> {
  let key = rsa::PublicEncryptingKey::from_der(spki).map_err(|_| err("Invalid public key"))?;
  let failed = |_| err("Encryption failed (message too long for the key?)");
  if oaep_hash.is_empty() {
    let key = rsa::Pkcs1PublicEncryptingKey::new(key).map_err(failed)?;
    let mut out = vec![0u8; key.ciphertext_size()];
    Ok(key.encrypt(data, &mut out).map_err(failed)?.to_vec())
  } else {
    let key = rsa::OaepPublicEncryptingKey::new(key).map_err(failed)?;
    let mut out = vec![0u8; key.ciphertext_size()];
    Ok(key.encrypt(oaep(&oaep_hash)?, data, &mut out, None).map_err(failed)?.to_vec())
  }
}

#[op2]
#[buffer]
pub fn op_crypto_rsa_decrypt(#[buffer] pkcs8: &[u8], #[buffer] data: &[u8], #[string] oaep_hash: String) -> Result<Vec<u8>, JsErrorBox> {
  let key = rsa::PrivateDecryptingKey::from_pkcs8(pkcs8).map_err(|_| err("Invalid private key"))?;
  let failed = |_| err("Decryption failed");
  if oaep_hash.is_empty() {
    let key = rsa::Pkcs1PrivateDecryptingKey::new(key).map_err(failed)?;
    let mut out = vec![0u8; key.min_output_size()];
    Ok(key.decrypt(data, &mut out).map_err(failed)?.to_vec())
  } else {
    let key = rsa::OaepPrivateDecryptingKey::new(key).map_err(failed)?;
    let mut out = vec![0u8; key.min_output_size()];
    Ok(key.decrypt(oaep(&oaep_hash)?, data, &mut out, None).map_err(failed)?.to_vec())
  }
}

// ---- Streaming AES-CBC / AES-CTR ----------------------------------------------------

enum StreamCipher {
  Encrypt(StreamingEncryptingKey),
  Decrypt(StreamingDecryptingKey),
}

#[derive(Default)]
struct CipherTable {
  next_id: u32,
  ciphers: HashMap<u32, StreamCipher>,
}

fn cipher_table(state: &mut OpState) -> &mut CipherTable {
  if !state.has::<CipherTable>() {
    state.put(CipherTable::default());
  }
  state.borrow_mut::<CipherTable>()
}

/// Start an aes-{128,192,256}-{cbc,ctr} cipher (CBC uses PKCS#7 padding).
#[op2(fast)]
pub fn op_crypto_stream_cipher_new(
  state: &mut OpState,
  #[string] algorithm: String,
  #[buffer] key: &[u8],
  #[buffer] iv: &[u8],
  decrypt: bool,
) -> Result<u32, JsErrorBox> {
  let (bits, mode) = algorithm
    .strip_prefix("aes-")
    .and_then(|rest| rest.split_once('-'))
    .ok_or_else(|| type_err(format!("Unknown cipher: {algorithm}")))?;
  let (alg, key_len) = match bits {
    "128" => (&AES_128, 16),
    "192" => (&AES_192, 24),
    "256" => (&AES_256, 32),
    _ => return Err(type_err(format!("Unknown cipher: {algorithm}"))),
  };
  if key.len() != key_len {
    return Err(JsErrorBox::range_error("Invalid key length"));
  }
  let iv: [u8; 16] = iv.try_into().map_err(|_| JsErrorBox::range_error("Invalid initialization vector"))?;
  let key = UnboundCipherKey::new(alg, key).map_err(|_| JsErrorBox::range_error("Invalid key length"))?;
  let failed = |_| err(format!("Could not initialize {algorithm}"));
  let cipher = match (mode, decrypt) {
    ("cbc", false) => StreamCipher::Encrypt(StreamingEncryptingKey::less_safe_cbc_pkcs7(key, EncryptionContext::Iv128(iv.into())).map_err(failed)?),
    ("ctr", false) => StreamCipher::Encrypt(StreamingEncryptingKey::less_safe_ctr(key, EncryptionContext::Iv128(iv.into())).map_err(failed)?),
    ("cbc", true) => StreamCipher::Decrypt(StreamingDecryptingKey::cbc_pkcs7(key, DecryptionContext::Iv128(iv.into())).map_err(failed)?),
    ("ctr", true) => StreamCipher::Decrypt(StreamingDecryptingKey::ctr(key, DecryptionContext::Iv128(iv.into())).map_err(failed)?),
    _ => return Err(type_err(format!("Unknown cipher: {algorithm}"))),
  };
  let table = cipher_table(state);
  table.next_id += 1;
  table.ciphers.insert(table.next_id, cipher);
  Ok(table.next_id)
}

#[op2]
#[buffer]
pub fn op_crypto_stream_cipher_update(state: &mut OpState, id: u32, #[buffer] data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
  let cipher = cipher_table(state).ciphers.get_mut(&id).ok_or_else(|| err("Cipher already finalized"))?;
  let mut out = vec![0u8; data.len() + 16];
  let written = match cipher {
    StreamCipher::Encrypt(c) => c.update(data, &mut out).map_err(|_| err("Cipher update failed"))?.written().len(),
    StreamCipher::Decrypt(c) => c.update(data, &mut out).map_err(|_| err("Decipher update failed"))?.written().len(),
  };
  out.truncate(written);
  Ok(out)
}

#[op2]
#[buffer]
pub fn op_crypto_stream_cipher_final(state: &mut OpState, id: u32) -> Result<Vec<u8>, JsErrorBox> {
  let cipher = cipher_table(state).ciphers.remove(&id).ok_or_else(|| err("Cipher already finalized"))?;
  let mut out = vec![0u8; 32];
  let written = match cipher {
    StreamCipher::Encrypt(c) => c.finish(&mut out).map_err(|_| err("Cipher final failed"))?.1.written().len(),
    // OpenSSL's message for a bad key/IV or corrupted CBC ciphertext.
    StreamCipher::Decrypt(c) => c.finish(&mut out).map_err(|_| err("bad decrypt"))?.written().len(),
  };
  out.truncate(written);
  Ok(out)
}

// ---- ECDH / X25519 key agreement ---------------------------------------------------

fn ecdh_algo(curve: &str) -> Result<&'static aws_lc_rs::agreement::Algorithm, JsErrorBox> {
  Ok(match curve {
    "prime256v1" | "P-256" | "p256" => &aws_lc_rs::agreement::ECDH_P256,
    "secp384r1" | "P-384" | "p384" => &aws_lc_rs::agreement::ECDH_P384,
    "secp521r1" | "P-521" | "p521" => &aws_lc_rs::agreement::ECDH_P521,
    "x25519" | "X25519" => &aws_lc_rs::agreement::X25519,
    _ => return Err(type_err(format!("Unsupported ECDH curve: {curve}"))),
  })
}

#[derive(serde::Serialize)]
pub struct EcdhKeyPair {
  #[serde(with = "serde_bytes")]
  private_key: Vec<u8>,
  #[serde(with = "serde_bytes")]
  public_key: Vec<u8>,
}

/// Generate an ECDH/X25519 key pair.
#[op2]
#[serde]
pub fn op_crypto_ecdh_generate(#[string] curve: String) -> Result<EcdhKeyPair, JsErrorBox> {
  use aws_lc_rs::encoding::{AsBigEndian, AsDer};
  let algo = ecdh_algo(&curve)?;
  let private = aws_lc_rs::agreement::PrivateKey::generate(algo)
    .map_err(|_| err("ECDH key generation failed"))?;
  let public = private.compute_public_key()
    .map_err(|_| err("ECDH public key computation failed"))?;
  // Try PKCS#8 DER first (EC curves), fall back to raw seed (X25519).
  let priv_bytes = if let Ok(pkcs8) = AsDer::<aws_lc_rs::encoding::Pkcs8V1Der>::as_der(&private) {
    pkcs8.as_ref().to_vec()
  } else if let Ok(seed) = AsBigEndian::<aws_lc_rs::encoding::Curve25519SeedBin>::as_be_bytes(&private) {
    seed.as_ref().to_vec()
  } else if let Ok(raw) = AsBigEndian::<aws_lc_rs::encoding::EcPrivateKeyBin>::as_be_bytes(&private) {
    raw.as_ref().to_vec()
  } else {
    return Err(err("ECDH private key export failed"));
  };
  Ok(EcdhKeyPair {
    private_key: priv_bytes,
    public_key: public.as_ref().to_vec(),
  })
}

/// Compute the ECDH/X25519 shared secret. Private key may be PKCS#8 DER or raw bytes.
#[op2]
#[buffer]
pub fn op_crypto_ecdh_compute(
  #[string] curve: String,
  #[buffer] private_key: &[u8],
  #[buffer] peer_public_key: &[u8],
) -> Result<Vec<u8>, JsErrorBox> {
  let algo = ecdh_algo(&curve)?;
  let private = aws_lc_rs::agreement::PrivateKey::from_private_key_der(algo, private_key)
    .or_else(|_| aws_lc_rs::agreement::PrivateKey::from_private_key(algo, private_key))
    .map_err(|_| err("Invalid ECDH private key"))?;
  let peer = aws_lc_rs::agreement::UnparsedPublicKey::new(algo, peer_public_key);
  aws_lc_rs::agreement::agree(&private, peer, err("ECDH key agreement failed"), |shared| {
    Ok(shared.to_vec())
  })
}
