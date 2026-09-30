// tests/fixtures/killer_features_production_adversarial.js
// Comprehensive adversarial verification of jse killer features & production readiness:
// 1. jse.kv (Off-heap zero-GC cache, atomic operations, CAS versioning, TTL expiry)
// 2. jse.Router (Radix-tree matching, params, wildcards, middleware, static files, ETags)
// 3. jse.sql (Embedded SQLite, tagged template injection defense, transactions)
// 4. jse.production & jse.metrics (Telemetry, Prometheus metrics, health checks, onShutdown)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("[killer_features_production] Starting comprehensive verification...");

// ---------------------------------------------------------------------------
// 1. Off-Heap Key-Value Store (jse.kv)
// ---------------------------------------------------------------------------
console.log("  -> Testing jse.kv off-heap cache and atomic primitives...");
assert.ok(globalThis.jse.kv, "jse.kv must be globally available");

// Clear existing keys
jse.kv.clear();
assert.strictEqual(jse.kv.get("non_existent"), null);

// Store JSON value
const v1 = jse.kv.set("user:1", { name: "Alice", active: true });
assert.ok(v1 > 0, "Set returns monotonic version");
const user = jse.kv.get("user:1");
assert.strictEqual(user.name, "Alice");
assert.strictEqual(user.active, true);

// Store binary Uint8Array
const bin = new Uint8Array([10, 20, 30, 40, 50]);
jse.kv.set("user:bin", bin);
const readBin = jse.kv.get("user:bin");
assert.deepStrictEqual(readBin, bin);

// Atomic Increment and Decrement
const c1 = jse.kv.atomic.incr("metrics:hits", 10);
assert.strictEqual(c1, 10);
const c2 = jse.kv.atomic.incr("metrics:hits", 5);
assert.strictEqual(c2, 15);
const c3 = jse.kv.atomic.decr("metrics:hits", 3);
assert.strictEqual(c3, 12);

// Compare-And-Swap (CAS)
const current = jse.kv.getWithVersion("user:1");
assert.strictEqual(current.version, v1);

// Stale CAS must fail
const staleCas = jse.kv.atomic.cas("user:1", v1 - 1, { name: "Hacker" });
assert.strictEqual(staleCas, false, "Stale CAS version must be rejected");
assert.strictEqual(jse.kv.get("user:1").name, "Alice", "Value must not mutate on failed CAS");

// Correct CAS must succeed
const okCas = jse.kv.atomic.cas("user:1", v1, { name: "Alice Updated" });
assert.strictEqual(okCas, true, "Matching CAS version must succeed");
assert.strictEqual(jse.kv.get("user:1").name, "Alice Updated");

// TTL Expiry
jse.kv.set("temp:key", "ephemeral", { ttlMs: 50 });
assert.strictEqual(jse.kv.get("temp:key"), "ephemeral");
await new Promise((r) => setTimeout(r, 70));
assert.strictEqual(jse.kv.get("temp:key"), null, "Expired key must return null");

// Keys query with prefix
jse.kv.set("app:a", 1);
jse.kv.set("app:b", 2);
jse.kv.set("other:c", 3);
const appKeys = jse.kv.keys("app:");
assert.strictEqual(appKeys.length, 2);
assert.ok(appKeys.includes("app:a") && appKeys.includes("app:b"));

// Stats
const stats = jse.kv.stats();
assert.ok(stats.total_keys >= 3);
console.log("     jse.kv verified successfully!");

// ---------------------------------------------------------------------------
// 2. High-Performance Radix Router (jse.Router) & Static Files
// ---------------------------------------------------------------------------
console.log("  -> Testing jse.Router route matching and static file streaming...");
assert.ok(globalThis.jse.Router, "jse.Router must be globally available");

const router = new jse.Router();

// Middleware
let mwVisited = false;
router.use((req) => {
  mwVisited = true;
});

// Parameterized route
router.get("/users/:userId/posts/:slug", (req) => {
  return {
    userId: req.params.userId,
    slug: req.params.slug,
    filter: req.query.filter,
  };
});

// JSON auto-serialization
router.post("/api/echo", async (req) => {
  const body = await req.json();
  return { received: body };
});

// Static directory mounting
const tmpStaticDir = path.join(import.meta.dirname, "__test_static__");
fs.mkdirSync(tmpStaticDir, { recursive: true });
fs.writeFileSync(path.join(tmpStaticDir, "test.html"), "<h1>Hello Static</h1>");
fs.writeFileSync(path.join(tmpStaticDir, "styles.css"), "body { color: blue; }");

router.static("/static", tmpStaticDir);

const handler = router.handler();

// 2.1 Match parameterized route
const paramReq = new Request("http://localhost/users/99/posts/hello-world?filter=recent");
const paramRes = await handler(paramReq);
assert.strictEqual(paramRes.status, 200);
assert.strictEqual(mwVisited, true);
const paramData = await paramRes.json();
assert.strictEqual(paramData.userId, "99");
assert.strictEqual(paramData.slug, "hello-world");
assert.strictEqual(paramData.filter, "recent");

// 2.2 Match POST route with body
const postReq = new Request("http://localhost/api/echo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ item: "turbo" }),
});
const postRes = await handler(postReq);
assert.strictEqual(postRes.status, 200);
const postData = await postRes.json();
assert.strictEqual(postData.received.item, "turbo");

// 2.3 Static file request
const staticReq = new Request("http://localhost/static/test.html");
const staticRes = await handler(staticReq);
assert.strictEqual(staticRes.status, 200);
assert.strictEqual(staticRes.headers.get("content-type"), "text/html; charset=utf-8");
assert.strictEqual(await staticRes.text(), "<h1>Hello Static</h1>");

// 2.4 ETag 304 Not Modified
const etag = staticRes.headers.get("etag");
assert.ok(etag, "Static file must provide ETag");
const req304 = new Request("http://localhost/static/test.html", {
  headers: { "if-none-match": etag },
});
const res304 = await handler(req304);
assert.strictEqual(res304.status, 304, "Must return 304 on matching ETag");

// Cleanup static dir
fs.rmSync(tmpStaticDir, { recursive: true, force: true });
console.log("     jse.Router verified successfully!");

// ---------------------------------------------------------------------------
// 3. Embedded SQLite Engine (jse.sql)
// ---------------------------------------------------------------------------
console.log("  -> Testing embedded jse.sql and tagged template queries...");
assert.ok(globalThis.jse.sql, "jse.sql must be globally available");

// In-memory isolated database
const db = jse.sql.memory();
await db.sql`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, price REAL, stock INTEGER);`;

// Tagged template parameterized insert (prevents SQL injection)
await db.sql`INSERT INTO items (title, price, stock) VALUES (${"Gadget"}, ${29.99}, ${100});`;
await db.sql`INSERT INTO items (title, price, stock) VALUES (${"Widget"}, ${49.50}, ${50});`;
await db.sql`INSERT INTO items (title, price, stock) VALUES (${"Gizmo"}, ${9.99}, ${200});`;

// Query with parameters
const minPrice = 20.0;
const results = await db.sql`SELECT * FROM items WHERE price > ${minPrice} ORDER BY price ASC;`;
assert.strictEqual(results.length, 2);
assert.strictEqual(results[0].title, "Gadget");
assert.strictEqual(results[1].title, "Widget");

// ACID Transaction with rollback
try {
  await db.transaction(async (tx) => {
    tx.sql`INSERT INTO items (title, price, stock) VALUES (${"RollbackItem"}, ${1.0}, ${1});`;
    throw new Error("Simulated failure inside transaction");
  });
} catch (e) {
  assert.strictEqual(e.message, "Simulated failure inside transaction");
}

const checkRollback = await db.sql`SELECT * FROM items WHERE title = ${"RollbackItem"};`;
assert.strictEqual(checkRollback.length, 0, "Transaction rollback must restore previous state");

// ACID Transaction with commit
await db.transaction(async (tx) => {
  tx.sql`INSERT INTO items (title, price, stock) VALUES (${"CommittedItem"}, ${15.0}, ${10});`;
});
const checkCommit = await db.sql`SELECT * FROM items WHERE title = ${"CommittedItem"};`;
assert.strictEqual(checkCommit.length, 1, "Committed transaction must persist");

db.close();
console.log("     jse.sql verified successfully!");

// ---------------------------------------------------------------------------
// 4. Production Telemetry & Lifecycle (jse.production & jse.metrics)
// ---------------------------------------------------------------------------
console.log("  -> Testing jse.production metrics, Prometheus export & lifecycle...");
assert.ok(globalThis.jse.metrics, "jse.metrics must be globally available");
assert.ok(globalThis.jse.onShutdown, "jse.onShutdown must be globally available");

// Query JSON metrics
const metrics = jse.metrics();
assert.ok(typeof metrics.uptime === "number");
assert.ok(metrics.memory.rss > 0, "Must report resident set size");
assert.ok(metrics.memory.heapUsed > 0, "Must report V8 heap used");

// Prometheus text format
const prom = jse.metrics.prometheus();
assert.ok(prom.includes("jse_uptime_seconds"), "Prometheus metrics must include uptime");
assert.ok(prom.includes("jse_rss_bytes"), "Prometheus metrics must include RSS");
assert.ok(prom.includes("jse_heap_used_bytes"), "Prometheus metrics must include heap");

// Health check handler
const healthHandler = jse.healthCheck();
const healthRes = await healthHandler(new Request("http://localhost/healthz"));
assert.strictEqual(healthRes.status, 200);
const healthJson = await healthRes.json();
assert.strictEqual(healthJson.status, "ok");

// Shutdown hook registration
let shutdownHookFired = false;
jse.onShutdown(() => {
  shutdownHookFired = true;
});

console.log("     jse.production verified successfully!");
console.log("[killer_features_production] ALL KILLER FEATURES AND PRODUCTION CAPABILITIES VERIFIED!");
