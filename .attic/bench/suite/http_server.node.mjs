// HTTP bench server (node:http) shared by both client variants.
// Serves a fixed small body, keep-alive on.
import { createServer } from "node:http";

const port = Number(process.env.BENCH_HTTP_PORT ?? 18123);
const body = "hello from the bench server\n";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "content-length": body.length });
  res.end(body);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`ready ${port}`);
});
