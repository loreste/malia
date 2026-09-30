// Cluster worker fixture
import cluster from "node:cluster";
import http from "node:http";

process.on("message", (msg) => {
  if (msg.cmd === "ping") {
    process.send({ cmd: "pong", payload: msg.payload });
  } else if (msg.cmd === "start_server") {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`worker-${cluster.worker?.id || 1}`);
    });
    server.listen(msg.port, "127.0.0.1", () => {
      process.send({ cmd: "server_started", port: msg.port });
    });
  } else if (msg.cmd === "shutdown") {
    process.exit(0);
  }
});
