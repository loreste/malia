// Express demo app exercising: routing (params + query), express.json()
// body parsing, a custom middleware, express.static, and an error handler.
import express from "express";

const app = express();

// Custom middleware: request logging header.
app.use((req, res, next) => {
  res.setHeader("x-powered-by", "jse-express-demo");
  next();
});

// JSON body parsing.
app.use(express.json());

// Static files from ./public.
app.use("/static", express.static(new URL("./public", import.meta.url).pathname));

app.get("/", (req, res) => {
  res.json({ hello: "world", framework: "express" });
});

app.get("/users/:id", (req, res) => {
  res.json({
    id: req.params.id,
    q: req.query.q ?? null,
    tags: req.query.tag ?? null,
  });
});

app.post("/echo", (req, res) => {
  res.json({ you_sent: req.body });
});

app.get("/boom", (req, res, next) => {
  next(new Error("deliberate failure"));
});

// 404 handler.
app.use((req, res) => {
  res.status(404).json({ error: "not found", path: req.path });
});

// Error handler.
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.DEMO_PORT ?? 3000);
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`ready ${server.address().port}`);
  if (process.argv.includes("--selftest")) selftest();
});

async function selftest() {
  const base = `http://127.0.0.1:${server.address().port}`;
  const expect = async (path, init, wanted) => {
    const resp = await fetch(base + path, init);
    const text = await resp.text();
    if (text !== wanted) {
      throw new Error(`${path}: expected ${wanted}, got ${text}`);
    }
  };
  await expect("/", undefined, '{"hello":"world","framework":"express"}');
  await expect("/users/42?q=yes&tag=a&tag=b", undefined, '{"id":"42","q":"yes","tags":["a","b"]}');
  await expect(
    "/echo",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"n":1}' },
    '{"you_sent":{"n":1}}',
  );
  const staticText = await (await fetch(`${base}/static/hello.txt`)).text();
  if (!staticText.includes("static file served")) throw new Error("static failed: " + staticText);
  await expect("/boom", undefined, '{"error":"deliberate failure"}');
  await expect("/nope", undefined, '{"error":"not found","path":"/nope"}');
  server.close();
  console.log("EXPRESS: PASS");
}
