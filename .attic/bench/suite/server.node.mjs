// Server throughput bench (node variant): JSON handler on http.createServer.
import http from "node:http";
const port = Number(process.env.BENCH_SERVER_PORT ?? 18321);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hello: "world" }));
});
server.listen(port, "127.0.0.1", () => console.log(`ready ${port}`));
