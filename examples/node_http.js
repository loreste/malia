// HTTP server, Node style. Run: jse run --allow-net examples/node_http.js
// Try: curl http://127.0.0.1:8001/ ; curl -X POST -d 'ping' http://127.0.0.1:8001/echo
import { createServer } from "node:http";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`you said: ${body}\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world", via: "node:http" }));
    }
  });
});

server.listen(8001, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${server.address().port}`);
});
