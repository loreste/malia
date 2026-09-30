// Permission bypass probes. Run with --allow-read/--allow-write=<dir>/ok,
// --allow-run=sh, --allow-net=0.0.0.0,127.0.0.1; prints "<probe>: ALLOWED|DENIED|ERR".
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const [dir, port] = process.argv.slice(2);

function report(name, err) {
  if (!err) return console.log(`${name}: ALLOWED`);
  const msg = String(err?.message ?? err);
  console.log(`${name}: ${msg.includes("PermissionDenied") ? "DENIED" : "ERR " + msg}`);
}

function probe(name, fn) {
  try {
    fn();
    report(name);
  } catch (err) {
    report(name, err);
  }
}

function spawnOk(opts) {
  const r = spawnSync("sh", ["-c", "exit 0"], opts);
  if (r.error) throw r.error;
}

probe("write-inside", () => fs.writeFileSync(`${dir}/ok/new.txt`, "x"));
probe("write-traversal", () => fs.writeFileSync(`${dir}/ok/../escape.txt`, "x"));
probe("write-dangling-symlink", () => fs.writeFileSync(`${dir}/ok/link`, "x"));
probe("sqlite-outside", () => new DatabaseSync(`${dir}/outside.db`));
probe("run-allowed", () => spawnOk());
probe("run-path-override", () => spawnOk({ env: { PATH: `${dir}/evil` } }));

// An allowed host must not be able to redirect to a denied one.
// The server listens on all interfaces so the denied target is reachable.
jse.serve({ port: Number(port), hostname: "0.0.0.0" }, (req) =>
  req.url.endsWith("/final")
    ? new Response("final")
    : new Response(null, { status: 302, headers: { location: `http://localhost:${port}/final` } })
);
try {
  const res = await fetch(`http://127.0.0.1:${port}/start`);
  report("fetch-redirect", res.status === 200 ? undefined : new Error(`status ${res.status}`));
} catch (err) {
  report("fetch-redirect", err);
}
process.exit(0);
