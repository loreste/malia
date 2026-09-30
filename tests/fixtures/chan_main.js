// Channel fixture: producer/consumer + concurrent sleep tasks.
const ch = chan();

async function producer() {
  for (let i = 1; i <= 100; i++) await ch.send(i);
  ch.close();
}

let sum = 0;
const p = producer();
for await (const v of ch) {
  sum += v;
}
await p;
if (sum !== 5050) throw new Error("bad sum: " + sum);

// 1000 concurrent sleepers counted via a channel.
const counter = chan();
const N = 1000;
for (let i = 0; i < N; i++) {
  (async () => {
    await sleep(20);
    await counter.send(1);
  })();
}
let done = 0;
while (done < N) {
  const { value } = await counter.recv();
  done += value;
}
if (done !== N) throw new Error("lost tasks");

// Bounded channel backpressure test:
const bch = chan(2);
if (bch.capacity !== 2) throw new Error("bad capacity: " + bch.capacity);
let sent = [];
(async () => {
  for (let i = 1; i <= 5; i++) {
    await bch.send(i);
    sent.push(i);
  }
  bch.close();
})();

await sleep(15);
// Because buffer capacity is 2, exactly 2 items should have been sent:
if (sent.length !== 2) throw new Error("backpressure failed, sent length was " + sent.length);

const received = [];
for await (const val of bch) {
  received.push(val);
  await sleep(2);
}
if (received.length !== 5 || received[4] !== 5) throw new Error("bad received: " + JSON.stringify(received));
if (sent.length !== 5) throw new Error("bad sent: " + JSON.stringify(sent));

// Closed channel test:
const closedCh = chan(1);
closedCh.close();
if (!closedCh.closed) throw new Error("expected closedCh.closed to be true");
let sendFailed = false;
try {
  await closedCh.send(42);
} catch {
  sendFailed = true;
}
if (!sendFailed) throw new Error("send on closed channel should throw");

// Bounded channel drain on close:
const drainCh = chan(2);
await drainCh.send("a");
await drainCh.send("b");
drainCh.close();
const r1 = await drainCh.recv();
const r2 = await drainCh.recv();
const r3 = await drainCh.recv();
if (r1.value !== "a" || r2.value !== "b" || !r3.done) {
  throw new Error("drain failed: " + JSON.stringify([r1, r2, r3]));
}

console.log("CHANNELS: PASS");

