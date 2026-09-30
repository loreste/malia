// Server throughput bench (jse variant): JSON handler on jse.serve.
const port = Number(process.env.BENCH_SERVER_PORT ?? 18321);
const server = jse.serve({ port, hostname: "127.0.0.1" }, () => {
  return new Response(JSON.stringify({ hello: "world" }), {
    headers: { "content-type": "application/json" },
  });
});
console.log(`ready ${server.port}`);
