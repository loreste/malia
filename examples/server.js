// HTTP server, Deno style. Run: jse run --allow-net examples/server.js
// Try: curl http://127.0.0.1:8000/ ; curl http://127.0.0.1:8000/json ; curl http://127.0.0.1:8000/stream
const server = jse.serve({ port: 8000, hostname: "127.0.0.1" }, async (req) => {
  if (req.url === "/json") {
    return new Response(JSON.stringify({ hello: "world", time: new Date().toISOString() }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (req.url === "/stream") {
    async function* numbers() {
      for (let i = 1; i <= 5; i++) {
        yield `chunk ${i}\n`;
        await sleep(100);
      }
    }
    return new Response(numbers(), { headers: { "content-type": "text/plain" } });
  }
  if (req.url.startsWith("/echo") && req.method === "POST") {
    return new Response(await req.text(), { headers: { "content-type": "text/plain" } });
  }
  return new Response("hello from jse.serve\n", { headers: { "content-type": "text/plain" } });
});
console.log(`listening on http://${server.hostname}:${server.port}`);
