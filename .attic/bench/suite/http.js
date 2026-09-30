// HTTP client: 1k sequential fetch round-trips against the local bench
// server (started by run_suite.py). Shared jse/node — both have fetch.
const port = process.env.BENCH_HTTP_PORT ?? 18123;
const url = `http://127.0.0.1:${port}/`;

const t = performance.now();
let bytes = 0;
for (let i = 0; i < 1000; i++) {
  const res = await fetch(url);
  if (res.status !== 200) throw new Error("status " + res.status);
  bytes += (await res.text()).length;
}
const ms = performance.now() - t;
if (bytes !== 1000 * 28) throw new Error("bytes mismatch: " + bytes);
console.log(`RESULT requests=1000 ms=${ms.toFixed(1)}`);
