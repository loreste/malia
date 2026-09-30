// Load client for the server throughput row: 50 keep-alive connections,
// 20k requests total, reports req/sec + mean/p99 latency.
import http from "node:http";

const port = Number(process.env.BENCH_SERVER_PORT ?? 18321);
const CONNECTIONS = Number(process.env.BENCH_LOAD_CONNECTIONS ?? 50);
const TOTAL = Number(process.env.BENCH_LOAD_REQUESTS ?? 20000);

const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS });
const latencies = [];

function one() {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.get({ host: "127.0.0.1", port, agent, path: "/" }, (res) => {
      res.resume();
      res.on("end", () => {
        latencies.push(performance.now() - start);
        resolve();
      });
    });
    req.on("error", reject);
  });
}

let issued = 0;
const wall0 = performance.now();
await Promise.all(
  Array.from({ length: CONNECTIONS }, async () => {
    for (;;) {
      const n = issued++;
      if (n >= TOTAL) return;
      await one();
    }
  }),
);
const wall = performance.now() - wall0;
latencies.sort((a, b) => a - b);
const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))];
const rps = (latencies.length / (wall / 1000)).toFixed(0);
console.log(
  `RESULT requests=${latencies.length} rps=${rps} mean=${mean.toFixed(2)} p99=${p99.toFixed(2)}`,
);
agent.destroy();
