// Measures: HTTP request/response throughput (localhost)
import http from "node:http";

const body = JSON.stringify({ status: "ok", ts: Date.now() });
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const total = 2000;
const concurrency = 50;
let completed = 0;
const start = performance.now();

async function worker() {
  while (completed < total) {
    completed++;
    const res = await fetch(url);
    await res.text();
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsed = performance.now() - start;

server.close();
console.log(`http: ${total} requests in ${elapsed.toFixed(1)}ms (${(total / elapsed * 1000).toFixed(0)} req/s)`);
