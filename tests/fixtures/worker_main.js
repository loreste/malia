// Worker round-trip fixture.
const workerUrl = import.meta.url.replace(/[^/]*$/, "echo_worker.js");
const w = new Worker(workerUrl);

w.postMessage({ hello: "world", n: 21 });
const { data } = await w.receive();
if (data.n !== 42 || data.hello !== "world") {
  throw new Error("bad echo: " + JSON.stringify(data));
}

// onmessage-style delivery + terminate.
let got = null;
w.onmessage = (e) => {
  got = e.data;
};
w.postMessage(7);
while (got === null) {
  await sleep(5);
}
if (got !== 14) throw new Error("onmessage delivery failed");
w.terminate();
console.log("WORKER: PASS");
