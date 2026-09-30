// Adversarial Test Suite for New Enterprise Features:
// 1. AEAD Hardware Ciphers (AES-256-GCM, AES-128-GCM, ChaCha20-Poly1305) & Tamper Resistance
// 2. Ed25519 Keypair Generation, Signing, and Verification
// 3. Unix Domain Sockets (IPC echo client/server)
// 4. OpenTelemetry W3C Distributed Tracing Engine (jse.trace)
// 5. Embedded Persistent Durable Task Queue (jse.queue)

import assert from "node:assert";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

console.log("=== RUNNING ADVANCED FEATURES ADVERSARIAL TEST ===");

// ---------------------------------------------------------------------------
// 1. Hardware Ciphers & AEAD Tamper Rejection
// ---------------------------------------------------------------------------
console.log("1. Testing AEAD Hardware Ciphers (AES-GCM & ChaCha20)...");
const ciphers = crypto.getCiphers();
assert(ciphers.includes("aes-256-gcm"), "aes-256-gcm in getCiphers()");
assert(ciphers.includes("chacha20-poly1305"), "chacha20-poly1305 in getCiphers()");

function testAeadCipher(algo, keyLen) {
  const key = crypto.randomBytes(keyLen);
  const iv = crypto.randomBytes(12);
  const plaintext = Buffer.from("Enterprise confidential payload: 42_TOP_SECRET");
  const aad = Buffer.from("tenant_id=enterprise_corp;user=admin");

  // Encrypt
  const cipher = crypto.createCipheriv(algo, key, iv);
  cipher.setAAD(aad);
  cipher.update(plaintext);
  const ciphertext = cipher.final();
  const tag = cipher.getAuthTag();
  assert.strictEqual(tag.length, 16, `${algo} tag length must be 16 bytes`);

  // Decrypt valid
  const decipher = crypto.createDecipheriv(algo, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  decipher.update(ciphertext);
  const decrypted = decipher.final();
  assert.strictEqual(decrypted.toString(), plaintext.toString(), `${algo} decrypt match`);

  // Adversarial: Tampered ciphertext must fail
  const tamperedCiphertext = Buffer.from(ciphertext);
  tamperedCiphertext[0] ^= 0xff;
  const tamperedDecipher = crypto.createDecipheriv(algo, key, iv);
  tamperedDecipher.setAAD(aad);
  tamperedDecipher.setAuthTag(tag);
  tamperedDecipher.update(tamperedCiphertext);
  assert.throws(() => {
    tamperedDecipher.final();
  }, /authentication tag verification failed|corrupted/i, "tampered ciphertext must throw");

  // Adversarial: Tampered AAD must fail
  const tamperedAadDecipher = crypto.createDecipheriv(algo, key, iv);
  tamperedAadDecipher.setAAD(Buffer.from("tenant_id=attacker"));
  tamperedAadDecipher.setAuthTag(tag);
  tamperedAadDecipher.update(ciphertext);
  assert.throws(() => {
    tamperedAadDecipher.final();
  }, /authentication tag verification failed|corrupted/i, "tampered AAD must throw");
}

testAeadCipher("aes-256-gcm", 32);
testAeadCipher("aes-128-gcm", 16);
testAeadCipher("chacha20-poly1305", 32);
console.log("   AEAD Ciphers & Tamper Rejection: PASS");

// ---------------------------------------------------------------------------
// 2. Ed25519 Keypair Generation, Signing, and Verification
// ---------------------------------------------------------------------------
console.log("2. Testing Ed25519 Signatures...");
const keypair = crypto.generateKeyPairSync("ed25519");
assert(keypair.publicKey instanceof crypto.KeyObject && keypair.publicKey.type === "public", "publicKey is a KeyObject");
assert(keypair.privateKey.asymmetricKeyType === "ed25519", "privateKey is an ed25519 KeyObject");

const msg = Buffer.from("Authorize multi-billion wire transfer: TX-90021");
const signature = crypto.sign(null, msg, keypair.privateKey);
assert.strictEqual(signature.length, 64, "ed25519 signature is 64 bytes");

const valid = crypto.verify(null, msg, keypair.publicKey, signature);
assert.strictEqual(valid, true, "ed25519 signature verification must succeed");

// Adversarial: tampered message must return false
const tamperedMsg = Buffer.from("Authorize multi-billion wire transfer: TX-90022");
const invalid = crypto.verify(null, tamperedMsg, keypair.publicKey, signature);
assert.strictEqual(invalid, false, "tampered message verification must fail");

// Adversarial: wrong public key must return false
const otherKeypair = crypto.generateKeyPairSync("ed25519");
const wrongKeyValid = crypto.verify(null, msg, otherKeypair.publicKey, signature);
assert.strictEqual(wrongKeyValid, false, "wrong key verification must fail");
console.log("   Ed25519 Signatures: PASS");

// ---------------------------------------------------------------------------
// 3. Unix Domain Sockets (node:net IPC)
// ---------------------------------------------------------------------------
// Unix domain sockets only (Windows named pipes are not supported).
if (process.platform !== "win32") {
  console.log("3. Testing Unix Domain Sockets...");
  const sockPath = `/tmp/jse-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;

  const udsServer = net.createServer((sock) => {
    sock.on("data", (chunk) => sock.end(chunk));
  });

  await new Promise((resolve, reject) => {
    udsServer.once("error", reject);
    udsServer.listen(sockPath, resolve);
  });

  const echoed = await new Promise((resolve, reject) => {
    const sock = net.connect({ path: sockPath }, () => sock.write("HELLO_FROM_UNIX_SOCKET"));
    const chunks = [];
    sock.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString()));
    sock.on("error", reject);
  });

  assert.strictEqual(echoed, "HELLO_FROM_UNIX_SOCKET", "unix domain socket echo match");
  udsServer.close();
  try {
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
  } catch (_) {}
  console.log("   Unix Domain Sockets: PASS");
}

// ---------------------------------------------------------------------------
// 4. OpenTelemetry Distributed Tracing (jse.trace)
// ---------------------------------------------------------------------------
console.log("4. Testing jse.trace OpenTelemetry Distributed Tracing...");
assert(globalThis.jse?.trace, "jse.trace must exist globally");
jse.trace.clear();

let capturedTraceparent = "";
const parentResult = jse.trace.startSpan("handle_http_request", (parentSpan) => {
  parentSpan.setAttribute("http.method", "POST");
  parentSpan.setAttribute("http.route", "/api/v1/checkout");
  parentSpan.addEvent("validation_complete", { items: 3 });

  capturedTraceparent = parentSpan.toTraceparent();
  assert.match(capturedTraceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, "W3C traceparent format");

  // Child span
  const childResult = jse.trace.startSpan("db_charge_card", (childSpan) => {
    childSpan.setAttribute("db.system", "postgresql");
    childSpan.setAttribute("amount", 99.99);
    return "CHARGED";
  });
  assert.strictEqual(childResult, "CHARGED", "child span result");
  return 200;
});
assert.strictEqual(parentResult, 200);

// Trace context extraction & injection
const headers = {};
const active = jse.trace.startSpan("outbound_call");
jse.trace.inject(active, headers);
assert(headers.traceparent, "injected traceparent header");
const extracted = jse.trace.extract(headers);
assert.strictEqual(extracted.traceId, active.traceId, "extracted traceId match");
active.end();

// Exception recording
assert.throws(() => {
  jse.trace.startSpan("failing_span", () => {
    throw new Error("Simulated failure in pipeline");
  });
});

// OTLP Export verification
const otlp = jse.trace.export("otlp");
assert(Array.isArray(otlp.resourceSpans) && otlp.resourceSpans.length > 0, "otlp resourceSpans");
const recordedSpans = otlp.resourceSpans[0].scopeSpans[0].spans;
assert(recordedSpans.length >= 4, "all spans recorded");
const failedSpan = recordedSpans.find((s) => s.name === "failing_span");
assert.strictEqual(failedSpan?.status?.code, "ERROR", "failing_span status code is ERROR");
console.log("   jse.trace Distributed Tracing: PASS");

// ---------------------------------------------------------------------------
// 5. Embedded Persistent Task Queue (jse.queue)
// ---------------------------------------------------------------------------
console.log("5. Testing jse.queue Embedded Task Queue...");
assert(globalThis.jse?.queue, "jse.queue must exist globally");

const queuePath = path.join(os.tmpdir(), `jse-queue-test-${Date.now()}.db`);
const q = jse.queue.open(queuePath);

try {
  // Push jobs
  const id1 = q.push("email_topic", { to: "user1@example.com", template: "welcome" });
  const id2 = q.push("email_topic", { to: "user2@example.com", template: "invite" });
  assert(id1 > 0 && id2 > id1, "sequential queue job ids");
  assert.strictEqual(q.size("email_topic"), 2, "queue size pending 2");

  // Pop job 1
  const job1 = q.pop("email_topic", 5000);
  assert.strictEqual(job1.id, id1);
  assert.strictEqual(job1.payload.to, "user1@example.com");
  assert.strictEqual(job1.attempts, 1);

  // While job 1 is in-flight (leased), popping again returns job 2
  const job2 = q.pop("email_topic", 5000);
  assert.strictEqual(job2.id, id2);

  // Ack job 1
  q.ack(job1.id);

  // Nack job 2 with max retries 1 -> goes to dead-letter queue
  const idDead = q.push("dead_topic", { critical: true }, { maxRetries: 1 });
  const jobDead = q.pop("dead_topic", 5000);
  q.nack(jobDead.id, 0); // attempts reaches maxRetries 1 -> marks dead
  const deadList = q.dead("dead_topic");
  assert.strictEqual(deadList.length, 1, "dead letter queue has 1 job");
  assert.strictEqual(deadList[0].id, idDead);

  // Ack job 2
  q.ack(job2.id);
  assert.strictEqual(q.size("email_topic"), 0, "email queue empty after acks");
} finally {
  q.close();
  try {
    if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
  } catch (_) {}
}
console.log("   jse.queue Persistent Task Queue: PASS");

console.log("=== ALL ADVANCED ENTERPRISE TESTS PASSED SUCCESSFULLY ===");
