// node:http fixture: createServer with req body capture, writeHead,
// chunked write() streaming, status codes, server.close().
import { createServer } from "node:http";

function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, echo: body }));
    } else if (req.url === "/stream") {
      res.setHeader("content-type", "text/plain");
      res.write("one-");
      res.write("two");
      res.end("-three");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
if (port <= 0) throw new Error("no bound port");
const base = `http://127.0.0.1:${port}`;

const r1 = await fetch(`${base}/json`, { method: "POST", body: "ping" });
const j = await r1.json();
assertEq(j.method, "POST", "method");
assertEq(j.echo, "ping", "body echo");

const r2 = await fetch(`${base}/stream`);
assertEq(await r2.text(), "one-two-three", "chunked writes");

const r3 = await fetch(`${base}/other`);
assertEq(r3.status, 404, "404");

server.close();
console.log("NODE-HTTP: PASS");
