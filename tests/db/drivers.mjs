// Real database drivers against real servers: each block runs when its
// connection variable is set (CI starts the servers as service containers).
//
//   JSE_PG_URL        postgres://postgres:secret@127.0.0.1:5432/postgres
//   JSE_MYSQL_URL     mysql://root:secret@127.0.0.1:3306/app
//   JSE_REDIS_URL     redis://127.0.0.1:6379
//   JSE_MONGO_URL     mongodb://root:secret@127.0.0.1:27017/?authSource=admin
//   JSE_DYNAMO_URL    http://127.0.0.1:8000
//   JSE_ES_URL        http://127.0.0.1:9200
//   JSE_CASSANDRA     127.0.0.1:9042
import assert from "node:assert/strict";

const env = process.env;
const ran = [];
const id = `${process.pid}_${Date.now()}`;

async function check(name, variable, fn) {
  if (!env[variable]) {
    console.log(`skip ${name} (${variable} not set)`);
    return;
  }
  await fn(env[variable]);
  ran.push(name);
  console.log(`ok ${name}`);
}

await check("pg", "JSE_PG_URL", async (url) => {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  const { rows } = await pool.query("SELECT $1::int + 1 AS n, now() AS t", [41]);
  assert.equal(rows[0].n, 42);
  assert.ok(rows[0].t instanceof Date);
  await pool.query(`CREATE TABLE t_${id} (id serial PRIMARY KEY, data jsonb, bin bytea)`);
  await pool.query(`INSERT INTO t_${id} (data, bin) VALUES ($1, $2)`, [{ a: [1, 2] }, Buffer.from([0, 255])]);
  const row = (await pool.query(`SELECT data, bin FROM t_${id}`)).rows[0];
  assert.deepEqual(row.data, { a: [1, 2] });
  assert.deepEqual([...row.bin], [0, 255]);
  await pool.query(`DROP TABLE t_${id}`);
  await pool.end();
});

await check("postgres (postgres.js)", "JSE_PG_URL", async (url) => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url);
  const [row] = await sql`SELECT ${"hi"}::text AS s, ${2}::int * 3 AS n`;
  assert.deepEqual({ ...row }, { s: "hi", n: 6 });
  await sql.end();
});

await check("knex (pg)", "JSE_PG_URL", async (url) => {
  const { default: knex } = await import("knex");
  const db = knex({ client: "pg", connection: url });
  await db.schema.createTable(`k_${id}`, (t) => {
    t.increments("id");
    t.string("name");
  });
  await db(`k_${id}`).insert([{ name: "a" }, { name: "b" }]);
  assert.deepEqual((await db(`k_${id}`).select("name").orderBy("id")).map((r) => r.name), ["a", "b"]);
  await db.schema.dropTable(`k_${id}`);
  await db.destroy();
});

await check("drizzle-orm (pg)", "JSE_PG_URL", async (url) => {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { pgTable, serial, text } = await import("drizzle-orm/pg-core");
  const { eq } = await import("drizzle-orm");
  const pool = new pg.Pool({ connectionString: url });
  await pool.query(`CREATE TABLE d_${id} (id serial PRIMARY KEY, name text)`);
  const users = pgTable(`d_${id}`, { id: serial("id").primaryKey(), name: text("name") });
  const db = drizzle(pool);
  await db.insert(users).values({ name: "drizzle" });
  const found = await db.select().from(users).where(eq(users.name, "drizzle"));
  assert.equal(found[0].name, "drizzle");
  await pool.query(`DROP TABLE d_${id}`);
  await pool.end();
});

await check("mysql2", "JSE_MYSQL_URL", async (url) => {
  const { default: mysql } = await import("mysql2/promise");
  const conn = await mysql.createConnection(url); // caching_sha2_password (MySQL 8 default)
  const [rows] = await conn.query("SELECT ? + 1 AS n, VERSION() AS v", [41]);
  assert.equal(rows[0].n, 42);
  await conn.query(`CREATE TABLE m_${id} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20), b BLOB)`);
  await conn.execute(`INSERT INTO m_${id} (name, b) VALUES (?, ?)`, ["x", Buffer.from([1, 2])]); // binary protocol
  const [[row]] = await conn.execute(`SELECT name, b FROM m_${id}`);
  assert.equal(row.name, "x");
  assert.deepEqual([...row.b], [1, 2]);
  await conn.query(`DROP TABLE m_${id}`);
  await conn.end();
});

await check("ioredis", "JSE_REDIS_URL", async (url) => {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url);
  await redis.set(`k:${id}`, "v", "EX", 60);
  assert.equal(await redis.get(`k:${id}`), "v");
  const results = await redis.pipeline().incr(`c:${id}`).incr(`c:${id}`).exec();
  assert.deepEqual(results.map(([, n]) => n), [1, 2]);
  const sub = new Redis(url);
  const message = new Promise((resolve) => sub.on("message", (_ch, m) => resolve(m)));
  await sub.subscribe(`ch:${id}`);
  await redis.publish(`ch:${id}`, "pubsub");
  assert.equal(await message, "pubsub");
  await redis.del(`k:${id}`, `c:${id}`);
  sub.disconnect();
  redis.disconnect();
});

await check("redis (node-redis)", "JSE_REDIS_URL", async (url) => {
  const { createClient } = await import("redis");
  const client = createClient({ url });
  await client.connect();
  await client.hSet(`h:${id}`, { a: "1", b: "2" });
  assert.deepEqual({ ...(await client.hGetAll(`h:${id}`)) }, { a: "1", b: "2" });
  await client.del(`h:${id}`);
  await client.quit();
});

await check("mongodb", "JSE_MONGO_URL", async (url) => {
  const { MongoClient } = await import("mongodb"); // SCRAM-SHA-256 auth
  const client = new MongoClient(url);
  await client.connect();
  const col = client.db("jse").collection(`c_${id}`);
  await col.insertMany([{ n: 1, big: 2n ** 40n }, { n: 2 }]);
  const docs = await col.find({}, { useBigInt64: true }).sort({ n: 1 }).toArray();
  assert.deepEqual(docs.map((d) => d.n), [1, 2]);
  assert.equal(docs[0].big, 2n ** 40n);
  await col.drop();
  await client.close();
});

await check("mongoose", "JSE_MONGO_URL", async (url) => {
  const { default: mongoose } = await import("mongoose");
  await mongoose.connect(url, { dbName: "jse" });
  const Cat = mongoose.model(`Cat_${id}`, new mongoose.Schema({ name: String, age: Number }));
  await Cat.create({ name: "tom", age: 3 });
  const cat = await Cat.findOne({ name: "tom" }).lean();
  assert.equal(cat.age, 3);
  await Cat.collection.drop();
  await mongoose.disconnect();
});

await check("@aws-sdk/client-dynamodb", "JSE_DYNAMO_URL", async (url) => {
  const { DynamoDBClient, CreateTableCommand, PutItemCommand, GetItemCommand, DeleteTableCommand } = await import(
    "@aws-sdk/client-dynamodb"
  );
  // SigV4 request signing with static credentials against DynamoDB Local.
  const client = new DynamoDBClient({ endpoint: url, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const TableName = `t_${id}`;
  await client.send(new CreateTableCommand({
    TableName,
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  }));
  await client.send(new PutItemCommand({ TableName, Item: { pk: { S: "k" }, v: { N: "7" } } }));
  const { Item } = await client.send(new GetItemCommand({ TableName, Key: { pk: { S: "k" } } }));
  assert.equal(Item.v.N, "7");
  await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
});

await check("@elastic/elasticsearch", "JSE_ES_URL", async (url) => {
  const { Client } = await import("@elastic/elasticsearch");
  const client = new Client({ node: url });
  const index = `i_${id}`.toLowerCase();
  await client.bulk({ refresh: true, operations: [{ index: { _index: index } }, { title: "hello" }, { index: { _index: index } }, { title: "world" }] });
  const result = await client.search({ index, query: { match: { title: "hello" } } });
  assert.equal(result.hits.hits[0]._source.title, "hello");
  await client.indices.delete({ index });
  await client.close();
});

await check("cassandra-driver", "JSE_CASSANDRA", async (hostPort) => {
  const { default: cassandra } = await import("cassandra-driver");
  const client = new cassandra.Client({ contactPoints: [hostPort], localDataCenter: "datacenter1" });
  await client.connect();
  const ks = `ks_${id}`;
  await client.execute(`CREATE KEYSPACE ${ks} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`);
  await client.execute(`CREATE TABLE ${ks}.t (id uuid PRIMARY KEY, name text)`);
  const uuid = cassandra.types.Uuid.random();
  await client.execute(`INSERT INTO ${ks}.t (id, name) VALUES (?, ?)`, [uuid, "cql"], { prepare: true });
  const rs = await client.execute(`SELECT name FROM ${ks}.t WHERE id = ?`, [uuid], { prepare: true });
  assert.equal(rs.first().name, "cql");
  await client.execute(`DROP KEYSPACE ${ks}`);
  await client.shutdown();
});

if (env.JSE_DB_REQUIRE_ALL === "1") {
  // In CI every server is up, so nothing may be skipped.
  assert.equal(ran.length, 12, `only ran: ${ran.join(", ")}`);
}
console.log(`database drivers: ${ran.length} checked`);
