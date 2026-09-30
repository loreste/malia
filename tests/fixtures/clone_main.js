// Structured-clone messaging: Map/Set/Uint8Array/Date/nested objects must
// round-trip through both channels and workers (V8 binary serialization).
function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

const payload = {
  map: new Map([["k", { deep: [1, 2, 3] }]]),
  set: new Set([1, "two", 3n]),
  bytes: new Uint8Array([1, 2, 250, 255]),
  f64: new Float64Array([1.5, -2.25]),
  when: new Date("2026-09-28T12:34:56.789Z"),
  nested: { a: [{ b: "c" }], n: 42, flag: true, nil: null },
};

function checkRoundTrip(v, via) {
  if (!(v.map instanceof Map) || v.map.get("k").deep[2] !== 3) throw new Error(`${via}: map broken`);
  if (!(v.set instanceof Set) || !v.set.has("two") || !v.set.has(3n)) throw new Error(`${via}: set broken`);
  if (!(v.bytes instanceof Uint8Array) || v.bytes[2] !== 250) throw new Error(`${via}: bytes broken`);
  if (!(v.f64 instanceof Float64Array) || v.f64[1] !== -2.25) throw new Error(`${via}: f64 broken`);
  if (!(v.when instanceof Date) || v.when.toISOString() !== "2026-09-28T12:34:56.789Z") {
    throw new Error(`${via}: date broken: ${v.when}`);
  }
  assertEq(v.nested.a[0].b, "c", `${via} nested`);
}

// 1. structuredClone global itself.
checkRoundTrip(structuredClone(payload), "structuredClone");

// 2. Through a channel.
{
  const c = chan();
  await c.send(payload);
  const { value, done } = await c.recv();
  if (done) throw new Error("channel closed early");
  checkRoundTrip(value, "chan");
  c.close();
  const end = await c.recv();
  if (!end.done) throw new Error("channel did not close");
}

// 3. Through a worker (parent -> child -> parent).
{
  const workerUrl = import.meta.url.replace(/[^/]*$/, "clone_worker.js");
  const w = new Worker(workerUrl);
  w.postMessage(payload);
  const { data } = await w.receive();
  checkRoundTrip(data, "worker");
  w.terminate();
}

console.log("CLONE: PASS");
