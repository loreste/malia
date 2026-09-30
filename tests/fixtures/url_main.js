// URL/URLSearchParams fixture.
import { fileURLToPath, pathToFileURL } from "node:url";

function assertEq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Parse + components.
const u = new URL("https://user:pw@example.com:8443/a/b?x=1&y=2#frag");
assertEq(u.protocol, "https:", "protocol");
assertEq(u.username, "user", "username");
assertEq(u.password, "pw", "password");
assertEq(u.hostname, "example.com", "hostname");
assertEq(u.port, "8443", "port");
assertEq(u.host, "example.com:8443", "host");
assertEq(u.pathname, "/a/b", "pathname");
assertEq(u.search, "?x=1&y=2", "search");
assertEq(u.hash, "#frag", "hash");
assertEq(u.origin, "https://example.com:8443", "origin");
assertEq(u.href, "https://user:pw@example.com:8443/a/b?x=1&y=2#frag", "href");

// Base resolution.
const rel = new URL("../up?q=yes", "https://a.b/c/d/e.html");
assertEq(rel.href, "https://a.b/c/up?q=yes", "relative resolution");

// Default port normalization.
assertEq(new URL("https://x.com:443/").host, "x.com", "default port dropped");

// Setters.
const s = new URL("https://example.com/");
s.pathname = "/new";
assertEq(s.pathname, "/new", "set pathname");
s.search = "?a=1";
assertEq(s.search, "?a=1", "set search");
s.hash = "#h";
assertEq(s.href, "https://example.com/new?a=1#h", "href after setters");
s.hostname = "other.org";
assertEq(s.host, "other.org", "set hostname");
s.port = "9090";
assertEq(s.host, "other.org:9090", "set port");

// canParse / parse.
if (!URL.canParse("https://ok.com")) throw new Error("canParse true");
if (URL.canParse("not a url")) throw new Error("canParse false");
if (URL.parse("http://") !== null) throw new Error("URL.parse invalid");
if (URL.parse("/rel", "https://base.com")?.href !== "https://base.com/rel") throw new Error("URL.parse base");

// URLSearchParams.
const p = new URLSearchParams("a=1&b=two+words&a=2");
assertEq(p.get("a"), "1", "params get first");
assertEq(p.getAll("a"), ["1", "2"], "params getAll");
assertEq(p.get("b"), "two words", "params + decode");
if (!p.has("b")) throw new Error("params has");
p.append("c", "3");
p.set("a", "only");
assertEq(p.getAll("a"), ["only"], "params set");
assertEq(p.size, 3, "params size");
p.delete("b");
assertEq(p.toString(), "a=only&c=3", "params toString");
assertEq(new URLSearchParams({ x: "1", y: "2" }).toString(), "x=1&y=2", "params from object");
const enc = new URLSearchParams([["k", "v & ü"]]);
assertEq(enc.toString(), "k=v+%26+%C3%BC", "params encode");
assertEq(new URLSearchParams("e=😀x").get("e"), "😀x", "params decode raw astral char");

// Iteration.
const seen = [];
for (const [k, v] of new URLSearchParams("m=1&n=2")) seen.push(k + v);
assertEq(seen.join(""), "m1n2", "params iterate");

// URL <-> searchParams sync.
const sync = new URL("https://x.com/?a=1");
sync.searchParams.set("b", "2");
assertEq(sync.search, "?a=1&b=2", "searchParams -> url sync");
assertEq(u.searchParams.get("y"), "2", "url.searchParams read");

// file URL helpers.
assertEq(fileURLToPath("file:///tmp/a%20b.txt"), "/tmp/a b.txt", "fileURLToPath");
assertEq(pathToFileURL("/tmp/a b.txt").href, "file:///tmp/a%20b.txt", "pathToFileURL");

console.log("URL: PASS");
