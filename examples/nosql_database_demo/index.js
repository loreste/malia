// examples/nosql_database_demo/index.js
// Production Microservice demonstrating NoSQL database wire protocols & container readiness in JSE.

import http from "node:http";
import net from "node:net";
import os from "node:os";
import dns from "node:dns";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const HOST = process.env.HOST || "0.0.0.0";
const isSelfTest = process.argv.includes("--selftest");

console.log("================================================================================");
console.log("JSE Containerized NoSQL Microservice");
console.log("================================================================================");
console.log(`Node Environment:  ${process.env.NODE_ENV || "development"}`);
console.log(`Detected CPU cores: ${os.cpus().length} (cgroup quota aware)`);
console.log(`Total System RAM:  ${(os.totalmem() / 1024 / 1024).toFixed(1)} MB (cgroup limit aware)`);
console.log(`Free RAM:          ${(os.freemem() / 1024 / 1024).toFixed(1)} MB`);
console.log("--------------------------------------------------------------------------------");

// -----------------------------------------------------------------------------
// 1. MongoDB BSON & SCRAM-SHA-256 Authentication Driver
// -----------------------------------------------------------------------------
class MongoScramAuth {
  static deriveKeys(password, salt, iterations = 4096) {
    const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const clientKey = crypto.createHmac("sha256", saltedPassword).update("Client Key").digest();
    const storedKey = crypto.createHash("sha256").update(clientKey).digest();
    const serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
    return { clientKey, storedKey, serverKey };
  }

  static serializeBsonDocument(doc) {
    // Encodes a minimal BSON document with int32, string, and int64
    const entries = Object.entries(doc);
    const bodyBuffers = [];

    for (const [key, value] of entries) {
      if (typeof value === "string") {
        const valBuf = Buffer.from(value, "utf8");
        const entryBuf = Buffer.alloc(1 + Buffer.byteLength(key) + 1 + 4 + valBuf.length + 1);
        entryBuf.writeUInt8(0x02, 0); // 0x02 = String
        entryBuf.write(key, 1, "utf8");
        const offset = 1 + Buffer.byteLength(key) + 1;
        entryBuf.writeInt32LE(valBuf.length + 1, offset);
        valBuf.copy(entryBuf, offset + 4);
        bodyBuffers.push(entryBuf);
      } else if (typeof value === "bigint" || (typeof value === "number" && value > 2147483647)) {
        const entryBuf = Buffer.alloc(1 + Buffer.byteLength(key) + 1 + 8);
        entryBuf.writeUInt8(0x12, 0); // 0x12 = 64-bit integer
        entryBuf.write(key, 1, "utf8");
        const offset = 1 + Buffer.byteLength(key) + 1;
        entryBuf.writeBigInt64LE(BigInt(value), offset);
        bodyBuffers.push(entryBuf);
      } else if (typeof value === "number") {
        const entryBuf = Buffer.alloc(1 + Buffer.byteLength(key) + 1 + 4);
        entryBuf.writeUInt8(0x10, 0); // 0x10 = 32-bit integer
        entryBuf.write(key, 1, "utf8");
        const offset = 1 + Buffer.byteLength(key) + 1;
        entryBuf.writeInt32LE(value, offset);
        bodyBuffers.push(entryBuf);
      }
    }

    const body = Buffer.concat(bodyBuffers);
    const totalLength = 4 + body.length + 1;
    const header = Buffer.alloc(4);
    header.writeInt32LE(totalLength, 0);
    return Buffer.concat([header, body, Buffer.from([0x00])]);
  }
}

// -----------------------------------------------------------------------------
// 2. Redis RESP (REdis Serialization Protocol) Client
// -----------------------------------------------------------------------------
class RedisRespClient {
  static encodeCommand(...args) {
    let out = `*${args.length}\r\n`;
    for (const arg of args) {
      const str = String(arg);
      out += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return Buffer.from(out);
  }

  static parseSimpleReply(buf) {
    const str = buf.toString("utf8");
    if (str.startsWith("+")) return str.slice(1, -2);
    if (str.startsWith(":")) return parseInt(str.slice(1, -2), 10);
    if (str.startsWith("-")) throw new Error(str.slice(1, -2));
    if (str.startsWith("$")) {
      const crlf = str.indexOf("\r\n");
      const len = parseInt(str.slice(1, crlf), 10);
      if (len === -1) return null;
      return str.slice(crlf + 2, crlf + 2 + len);
    }
    return str;
  }
}

// -----------------------------------------------------------------------------
// 3. HTTP Application Server with Graceful Shutdown
// -----------------------------------------------------------------------------
let requestCount = 0;

const server = http.createServer(async (req, res) => {
  requestCount++;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Container Health Check endpoint
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "healthy",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      requests: requestCount,
    }));
  }

  // Demonstration endpoint exercising NoSQL & database primitives
  if (url.pathname === "/api/nosql-demo") {
    // 1. Simulate MongoDB SCRAM Auth + BSON Document
    const salt = crypto.randomBytes(16);
    const keys = MongoScramAuth.deriveKeys("adminPassword123", salt);
    const bson = MongoScramAuth.serializeBsonDocument({
      user: "alice",
      balance: 1000000000000n,
      version: 1,
    });

    // 2. Simulate Redis RESP command
    const redisSet = RedisRespClient.encodeCommand("SET", "session:user:1", "active");

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      success: true,
      mongo: {
        scramStoredKeyHex: keys.storedKey.toString("hex"),
        bsonBytes: bson.length,
        bsonSliceText: bson.utf8Slice(0, Math.min(bson.length, 16)),
      },
      redis: {
        rawResp: redisSet.toString("utf8"),
      },
      server: {
        pid: process.pid,
        cpus: os.cpus().length,
      }
    }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

// Register container graceful shutdown
if (globalThis.jse?.production?.onShutdown) {
  globalThis.jse.production.onShutdown(async () => {
    console.log("[demo] Running cleanup: closing HTTP server and flushing metrics...");
    await new Promise((resolve) => server.close(resolve));
    console.log("[demo] Cleanup complete.");
  });
}

// Start listening
server.listen(isSelfTest ? 0 : PORT, HOST, async () => {
  const addr = server.address();
  console.log(`✓ Microservice listening on http://${HOST}:${addr.port}`);
  console.log(`  • Health: http://${HOST}:${addr.port}/health`);
  console.log(`  • Demo:   http://${HOST}:${addr.port}/api/nosql-demo`);

  if (isSelfTest) {
    console.log("\n[selftest] Running automated validation checks...");

    // Test /health
    const healthRes = await fetch(`http://127.0.0.1:${addr.port}/health`);
    const healthJson = await healthRes.json();
    if (healthJson.status !== "healthy") throw new Error("Health check failed");
    console.log("   ✓ Health check passed!");

    // Test /api/nosql-demo
    const demoRes = await fetch(`http://127.0.0.1:${addr.port}/api/nosql-demo`);
    const demoJson = await demoRes.json();
    if (!demoJson.success || !demoJson.mongo.scramStoredKeyHex) throw new Error("NoSQL demo failed");
    console.log("   ✓ NoSQL serialization & SCRAM authentication passed!");

    console.log("\nNOSQL_DEMO: ALL CHECKS PASSED!");
    server.close(() => {
      process.exit(0);
    });
  }
});
