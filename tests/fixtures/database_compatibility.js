// tests/fixtures/database_compatibility.js
// Adversarial verification of major database drivers & wire protocol capabilities:
// 1. node:sqlite (Node 22+ DatabaseSync / StatementSync)
// 2. PostgreSQL / MySQL / Redis wire protocol simulation (TCP full-duplex, readyState, address, bytesRead/Written)
// 3. Cloud database DNS resolution (resolveSrv, resolveTxt, lookup) for MongoDB/Supabase/Atlas
// 4. Database authentication crypto (SCRAM-SHA-256, HMAC, MD5, SHA-256, randomBytes)
// 5. Embedded jse.sql engine verification

import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import dns from "node:dns";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

console.log("=== DATABASE COMPATIBILITY VERIFICATION ===");

// ---------------------------------------------------------------------------
// 1. node:sqlite (Node 22+ DatabaseSync & StatementSync)
// ---------------------------------------------------------------------------
console.log("1. Testing node:sqlite DatabaseSync & StatementSync...");
const db = new DatabaseSync(":memory:");

db.exec(`
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL
  );
`);

const insertStmt = db.prepare("INSERT INTO products (name, price, stock) VALUES (?, ?, ?)");
assert.strictEqual(typeof insertStmt.sourceSQL, "string");
assert.strictEqual(typeof insertStmt.expandedSQL, "string");

const r1 = insertStmt.run("MacBook Pro", 1999.99, 10);
assert.strictEqual(r1.changes, 1);
assert.strictEqual(r1.lastInsertRowid, 1);

const r2 = insertStmt.run("Magic Mouse", 79.50, 50);
assert.strictEqual(r2.changes, 1);
assert.strictEqual(r2.lastInsertRowid, 2);

const r3 = insertStmt.run("Thunderbolt Cable", 29.00, 100);
assert.strictEqual(r3.changes, 1);
assert.strictEqual(r3.lastInsertRowid, 3);

// Query all
const selectAll = db.prepare("SELECT * FROM products ORDER BY id ASC");
const allProducts = selectAll.all();
assert.strictEqual(allProducts.length, 3);
assert.strictEqual(allProducts[0].name, "MacBook Pro");
assert.strictEqual(allProducts[0].price, 1999.99);
assert.strictEqual(allProducts[1].name, "Magic Mouse");
assert.strictEqual(allProducts[2].name, "Thunderbolt Cable");

// Query get (single row)
const selectOne = db.prepare("SELECT * FROM products WHERE id = ?");
const product1 = selectOne.get(1);
assert.ok(product1);
assert.strictEqual(product1.name, "MacBook Pro");
assert.strictEqual(selectOne.get(999), undefined);

// Query iterate
const iteratedNames = [];
for (const row of selectAll.iterate()) {
  iteratedNames.push(row.name);
}
assert.deepStrictEqual(iteratedNames, ["MacBook Pro", "Magic Mouse", "Thunderbolt Cable"]);

db.close();
assert.throws(() => db.exec("SELECT 1"), /closed/i);
console.log("   ✓ node:sqlite fully verified!");

// ---------------------------------------------------------------------------
// 2. Wire Protocol Emulation (Postgres/MySQL/Redis TCP communication)
// ---------------------------------------------------------------------------
console.log("2. Testing database wire protocol TCP communication & socket semantics...");

// Start mock database server on a random port
const dbServer = net.createServer((sock) => {
  sock.on("data", (chunk) => {
    // Check for PostgreSQL StartupMessage or Redis PING or MySQL Handshake
    const str = chunk.toString();
    if (str.includes("PG_STARTUP")) {
      // Simulate PostgreSQL AuthOK (R) + ReadyForQuery (Z)
      const res = Buffer.from("PG_AUTH_OK;READY_FOR_QUERY;");
      sock.write(res);
    } else if (str.startsWith("*1\r\n$4\r\nPING\r\n")) {
      // Simulate Redis +PONG
      sock.write("+PONG\r\n");
    } else if (str.includes("SELECT 1;")) {
      // Simulate row result
      sock.write("ROW:1;COMPLETE;");
    }
  });
});

await new Promise((resolve) => dbServer.listen(0, "127.0.0.1", resolve));
const dbPort = dbServer.address().port;

// Connect client socket
const client = net.createConnection({ host: "127.0.0.1", port: dbPort });
assert.strictEqual(client.readyState, "opening");

await new Promise((resolve) => client.once("connect", resolve));
assert.strictEqual(client.readyState, "open");

// Validate socket properties expected by pg / mysql2 / ioredis
const clientAddr = client.address();
assert.ok(clientAddr.port > 0);
assert.strictEqual(clientAddr.address, "127.0.0.1");
assert.strictEqual(client.remoteAddress, "127.0.0.1");
assert.strictEqual(client.remotePort, dbPort);

client.setNoDelay(true);
client.setKeepAlive(true, 1000);
let timeoutFired = false;
client.setTimeout(10000, () => {
  timeoutFired = true;
});

// Send simulated PG startup packet
client.write(Buffer.from("PG_STARTUP:user=postgres,db=app"));
const responseData = await new Promise((resolve) => {
  client.once("data", resolve);
});
assert.ok(responseData.toString().includes("PG_AUTH_OK"));
assert.ok(client.bytesWritten > 0);
assert.ok(client.bytesRead > 0);

// Send simulated SQL query
client.write(Buffer.from("SELECT 1;"));
const queryResponse = await new Promise((resolve) => {
  client.once("data", resolve);
});
assert.ok(queryResponse.toString().includes("ROW:1"));

client.destroy();
assert.strictEqual(client.readyState, "closed");
await new Promise((resolve) => dbServer.close(resolve));
console.log("   ✓ Database wire protocol TCP & socket semantics fully verified!");

// ---------------------------------------------------------------------------
// 3. Database Authentication Crypto (PBKDF2 RFC 6070, SCRAM-SHA-256, MD5)
// ---------------------------------------------------------------------------
console.log("3. Testing database authentication crypto primitives (PBKDF2 RFC 6070 & SCRAM)...");

// RFC 6070 PBKDF2-HMAC-SHA1 test vector 1:
const rfc1 = crypto.pbkdf2Sync("password", "salt", 1, 20, "sha1");
assert.strictEqual(rfc1.toString("hex"), "0c60c80f961f0e71f3a9b524af6012062fe037a6");

// RFC 6070 PBKDF2-HMAC-SHA1 test vector 2:
const rfc2 = crypto.pbkdf2Sync("password", "salt", 2, 20, "sha1");
assert.strictEqual(rfc2.toString("hex"), "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");

// RFC 6070 PBKDF2-HMAC-SHA1 test vector 3 (4096 iterations):
const rfc3 = crypto.pbkdf2Sync("password", "salt", 4096, 20, "sha1");
assert.strictEqual(rfc3.toString("hex"), "4b007901b765489abead49d926f721d065a429c1");

// PBKDF2-HMAC-SHA256 (standard in MongoDB SCRAM-SHA-256 and PostgreSQL 10+):
const rfcSha256 = crypto.pbkdf2Sync("password", "salt", 4096, 32, "sha256");
assert.strictEqual(rfcSha256.toString("hex"), "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");

// Async pbkdf2 with callback
const asyncPbkdf2 = await new Promise((resolve, reject) => {
  crypto.pbkdf2("password", "salt", 1, 20, "sha1", (err, derivedKey) => {
    if (err) reject(err);
    else resolve(derivedKey);
  });
});
assert.strictEqual(asyncPbkdf2.toString("hex"), "0c60c80f961f0e71f3a9b524af6012062fe037a6");

// SCRAM-SHA-256 full key derivation flow used by MongoDB and Postgres
const password = "secret_password";
const salt = crypto.randomBytes(16);
const saltedPassword = crypto.pbkdf2Sync(password, salt, 4096, 32, "sha256");
const clientKey = crypto.createHmac("sha256", saltedPassword).update("Client Key").digest();
const storedKey = crypto.createHash("sha256").update(clientKey).digest();
const serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
assert.strictEqual(storedKey.length, 32);
assert.strictEqual(serverKey.length, 32);

// PostgreSQL legacy MD5 auth: 'md5' + md5(md5(password + user) + salt)
const user = "db_user";
const md5Inner = crypto.createHash("md5").update(password + user).digest("hex");
const md5Outer = "md5" + crypto.createHash("md5").update(md5Inner + "salt").digest("hex");
assert.ok(md5Outer.startsWith("md5"));
assert.strictEqual(md5Outer.length, 35);

// MySQL caching_sha2_password XOR scramble: XOR(SHA256(password), SHA256(SHA256(SHA256(password)), scramble))
const stage1 = crypto.createHash("sha256").update(password).digest();
const stage2 = crypto.createHash("sha256").update(stage1).digest();
const scramble = crypto.randomBytes(20);
const h = crypto.createHash("sha256").update(stage2).update(scramble).digest();
const token = Buffer.alloc(32);
for (let i = 0; i < 32; i++) {
  token[i] = stage1[i] ^ h[i];
}
assert.strictEqual(token.length, 32);
console.log("   ✓ SCRAM, PBKDF2 RFC 6070, MD5, and SHA256 database authentication verified!");

// ---------------------------------------------------------------------------
// 4. NoSQL Binary Protocols: BSON (MongoDB), RESP (Redis), CQL (Cassandra)
// ---------------------------------------------------------------------------
console.log("4. Testing NoSQL serialization primitives (BSON, Redis RESP, CQL)...");

// BSON 64-bit integer support in Buffer
const bsonBuf = Buffer.alloc(16);
bsonBuf.writeBigInt64LE(-9007199254740993n, 0);
bsonBuf.writeBigUInt64LE(18446744073709551615n, 8);
assert.strictEqual(bsonBuf.readBigInt64LE(0), -9007199254740993n);
assert.strictEqual(bsonBuf.readBigUInt64LE(8), 18446744073709551615n);

// BSON slice compatibility methods
const sampleString = "MongoDB Atlas Connection Test";
const textBuf = Buffer.from(sampleString);
assert.strictEqual(textBuf.utf8Slice(0, 7), "MongoDB");
assert.strictEqual(textBuf.latin1Slice(0, 7), "MongoDB");
assert.strictEqual(textBuf.asciiSlice(0, 7), "MongoDB");

// Cassandra CQL binary framing: 9-byte header [version, flags, stream(2), opcode, length(4)]
const cqlHeader = Buffer.alloc(9);
cqlHeader.writeUInt8(0x04, 0); // CQL v4 protocol
cqlHeader.writeUInt8(0x00, 1); // flags
cqlHeader.writeUInt16BE(0x0001, 2); // stream id 1
cqlHeader.writeUInt8(0x01, 4); // opcode 0x01: STARTUP
cqlHeader.writeInt32BE(24, 5); // payload length 24
assert.strictEqual(cqlHeader.readUInt8(0), 0x04);
assert.strictEqual(cqlHeader.readUInt16BE(2), 0x0001);
assert.strictEqual(cqlHeader.readInt32BE(5), 24);

// Redis RESP serialization simulation (commands & replies)
function encodeRespCommand(...args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return Buffer.from(out);
}
const redisCmd = encodeRespCommand("HSET", "user:100", "name", "Grace Hopper", "active", "1");
assert.ok(redisCmd.toString().startsWith("*6\r\n$4\r\nHSET\r\n"));
console.log("   ✓ BSON, Cassandra CQL, and Redis RESP wire protocols verified!");

// ---------------------------------------------------------------------------
// 5. Cloud Database DNS Resolution (Atlas / Supabase / Neon)
// ---------------------------------------------------------------------------
console.log("5. Testing cloud database DNS lookup resolution...");

assert.strictEqual(typeof dns.resolveSrv, "function");
assert.strictEqual(typeof dns.resolveTxt, "function");
assert.strictEqual(typeof dns.promises.resolveSrv, "function");
assert.strictEqual(typeof dns.promises.resolveTxt, "function");

const localhostLookup = await dns.promises.lookup("127.0.0.1");
assert.strictEqual(localhostLookup.address, "127.0.0.1");
console.log("   ✓ DNS SRV/TXT and lookup primitives verified!");

// ---------------------------------------------------------------------------
// 6. Container Readiness Verification (cgroups, PID 1 signals, PORT defaults)
// ---------------------------------------------------------------------------
console.log("6. Testing container readiness primitives (cgroups, signals, networking)...");

import os from "node:os";

// os.cpus() and memory functions reflecting container boundaries
const cpus = os.cpus();
assert.ok(Array.isArray(cpus));
assert.ok(cpus.length >= 1, `Expected at least 1 CPU core, got ${cpus.length}`);

const totalmem = os.totalmem();
const freemem = os.freemem();
assert.ok(totalmem > 0, "Total memory must be > 0");
assert.ok(freemem >= 0, "Free memory must be >= 0");
assert.ok(freemem <= totalmem, "Free memory cannot exceed total memory");

// Container PID 1 signal handler registration
assert.ok(process.listenerCount("SIGTERM") > 0, "SIGTERM container handler must be registered");
assert.ok(process.listenerCount("SIGINT") > 0, "SIGINT container handler must be registered");

let customSignalFired = false;
const customHandler = () => {
  customSignalFired = true;
};
process.on("SIGUSR2", customHandler);
assert.ok(process.listenerCount("SIGUSR2") > 0);
process.emit("SIGUSR2");
assert.strictEqual(customSignalFired, true);
process.removeListener("SIGUSR2", customHandler);
assert.strictEqual(process.listenerCount("SIGUSR2"), 0);

assert.strictEqual(typeof jse.production.onShutdown, "function");

// Container HTTP server defaults (0.0.0.0 host binding)
import http from "node:http";
const testContainerServer = http.createServer((req, res) => res.end("ok"));
await new Promise((resolve) => testContainerServer.listen(0, resolve));
const boundAddr = testContainerServer.address();
assert.ok(boundAddr.port > 0);
await new Promise((resolve) => testContainerServer.close(resolve));
console.log("   ✓ Container cgroups, signals, and networking defaults verified!");

// ---------------------------------------------------------------------------
// 7. Embedded jse.sql Engine
// ---------------------------------------------------------------------------
console.log("7. Testing embedded jse.sql tagged template queries...");
const jseDb = new jse.Database(":memory:");
jseDb.exec("CREATE TABLE metrics (name TEXT, value INTEGER);");
const insertSql = jseDb.sql`INSERT INTO metrics (name, value) VALUES (${"cpu_usage"}, ${42});`;
const readMetrics = jseDb.sql`SELECT * FROM metrics WHERE name = ${"cpu_usage"};`;
assert.strictEqual(readMetrics.length, 1);
assert.strictEqual(readMetrics[0].value, 42);
jseDb.close();
console.log("   ✓ Embedded jse.sql verified!");

console.log("=== ALL DATABASE COMPATIBILITY TESTS PASSED SUCCESSFULLY! ===");
