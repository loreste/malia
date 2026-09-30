// jse.serve fixture: JSON handler, text handler, streaming body, 404,
// concurrent requests, keep-alive (sequential fetches share a client).
function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const server = jse.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
  if (req.url.startsWith("/json")) {
    const body = req.method === "POST" ? await req.json() : null;
    return new Response(JSON.stringify({ ok: true, method: req.method, echo: body }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (req.url === "/stream") {
    async function* chunks() {
      yield "part1-";
      yield new Uint8Array([112, 97, 114, 116, 50]); // "part2"
      await sleep(1);
      yield "-part3";
    }
    return new Response(chunks(), { headers: { "content-type": "text/plain" } });
  }
  return new Response("not found", { status: 404 });
});

const base = `http://127.0.0.1:${server.port}`;

// Basic GET.
const r1 = await fetch(`${base}/json`);
assertEq(r1.status, 200, "GET status");
assertEq((await r1.json()).method, "GET", "GET method");

// POST with JSON request body (req.json()).
const r2 = await fetch(`${base}/json`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ n: 7 }),
});
assertEq((await r2.json()).echo.n, 7, "POST echo");

// Streaming response body.
const r3 = await fetch(`${base}/stream`);
let streamed = "";
let chunkCount = 0;
for await (const chunk of r3.body) {
  chunkCount++;
  streamed += new TextDecoder().decode(chunk);
}
assertEq(streamed, "part1-part2-part3", "streamed body");
if (chunkCount < 1) throw new Error("no chunks");

// 404.
const r4 = await fetch(`${base}/missing`);
assertEq(r4.status, 404, "404 status");

// Concurrency: 50 parallel requests all succeed.
const results = await Promise.all(
  Array.from({ length: 50 }, (_, i) => fetch(`${base}/json?i=${i}`).then((r) => r.json())),
);
for (const r of results) {
  if (!r.ok) throw new Error("concurrent request failed");
}

server.close();
console.log("SERVE: PASS");
