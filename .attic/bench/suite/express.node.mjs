// Express throughput bench (node): JSON route.
import express from "../../examples/express_demo/node_modules/express/index.js";
const port = Number(process.env.BENCH_SERVER_PORT ?? 18321);
const app = express();
app.get("/", (req, res) => {
  res.json({ hello: "world" });
});
app.listen(port, "127.0.0.1", () => console.log(`ready ${port}`));
