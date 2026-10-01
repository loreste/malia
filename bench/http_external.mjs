// Run with Node: node bench/http_external.mjs /absolute/path/to/runtime [seconds=30] [concurrency=16] [repetitions=3]
// Closed-loop load. No performance acceptance decision is inferred from results.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const runtime = process.argv[2];
const seconds = Number(process.argv[3] ?? 30);
const concurrency = Number(process.argv[4] ?? 16);
const repetitions = Number(process.argv[5] ?? 3);
if (!runtime || ![seconds, concurrency, repetitions].every(n => Number.isInteger(n) && n > 0)) {
  throw new Error('Expected runtime and positive integer duration, concurrency, repetitions');
}
const node = /^node(?:\.exe)?$/.test(path.basename(runtime));
const results = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  const child = spawn(runtime, [...(node ? [] : ['run', '--allow-all']), 'bench/http_external_server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-8192); });
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const watchdog = setTimeout(() => child.kill(), (seconds + 30) * 1000);
  try {
    const port = await Promise.race([
      once(child.stdout, 'data').then(([bytes]) => Number(bytes.toString().trim())),
      once(child, 'exit').then(() => { throw new Error(`Server failed: ${errors}`); }),
    ]);
    const request = (endpoint = '/') => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: endpoint, agent, timeout: 5000 }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; });
        res.on('error', reject); res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve(JSON.parse(body));
        });
      });
      req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject);
    });
    async function load(duration, measured) {
      const until = performance.now() + duration;
      const histogram = new Map(); let count = 0, failures = 0;
      const started = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (performance.now() < until) {
          const start = performance.now();
          try { if ((await request()).ok !== true) throw new Error('incorrect response'); count++; }
          catch { failures++; }
          if (measured) {
            const bucket = Math.ceil(Math.log(Math.max(1, (performance.now() - start) * 1000)) / Math.log(1.01));
            histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
          }
        }
      }));
      const elapsedMs = performance.now() - started;
      const buckets = [...histogram].sort((a, b) => a[0] - b[0]);
      const percentile = p => {
        let total = 0;
        for (const [bucket, n] of buckets) { total += n; if (total >= (count + failures) * p) return 1.01 ** bucket / 1000; }
        return null;
      };
      return { count, failures, elapsedMs, throughput: count / (elapsedMs / 1000),
        latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), bucketRelativeError: .01 },
        histogram: buckets.map(([bucket, count]) => ({ upperBoundUs: 1.01 ** bucket, count })) };
    }
    await load(2000, false);
    const before = await request('/metrics');
    const result = await load(seconds * 1000, true);
    const after = await request('/metrics');
    results.push({ repetition, ...result, before, after });
  } finally { clearTimeout(watchdog); agent.destroy(); child.kill(); }
}
console.log(JSON.stringify({ runtime, version: execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(),
  client: process.version, platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model,
  totalMemory: os.totalmem(), seconds, concurrency, repetitions, warmupSeconds: 2,
  mode: 'external closed-loop client; memory snapshots are not peak RSS; no release acceptance budget applied', results }, null, 2));
