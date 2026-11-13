"use strict";
// res._implicitHeader() sends the status and headers, as in Node: headersSent
// is true, and later writes and end() complete the response. Next.js calls it
// before streaming every page.
const assert = require("assert");
const http = require("http");

const srv = http.createServer((req, res) => {
  res.statusCode = 201;
  res.setHeader("x-test", "1");
  res._implicitHeader();
  assert.strictEqual(res.headersSent, true);
  if (req.url === "/write") res.write("a");
  res.end(req.url === "/write" ? "b" : undefined);
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    const r = http.get({ port, path, host: "127.0.0.1" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, header: res.headers["x-test"], body }));
    });
    r.on("error", reject);
    r.setTimeout(3000, () => reject(new Error("no response for " + path)));
  });
}

srv.listen(0, "127.0.0.1", async () => {
  const { port } = srv.address();
  assert.deepStrictEqual(await get(port, "/write"), { status: 201, header: "1", body: "ab" });
  assert.deepStrictEqual(await get(port, "/empty"), { status: 201, header: "1", body: "" });
  srv.close();
  console.log("ok");
});
