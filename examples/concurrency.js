// 10k concurrent sleep tasks complete in ~sleep time; completion is
// counted through a channel.
const TASKS = 10_000;
const SLEEP_MS = 100;

const counter = chan();

async function task() {
  await sleep(SLEEP_MS);
  await counter.send(1);
}

const start = performance.now();
for (let i = 0; i < TASKS; i++) task();

let done = 0;
while (done < TASKS) {
  const { value, done: closed } = await counter.recv();
  if (closed) break;
  done += value;
}

const elapsed = performance.now() - start;
console.log(`${done}/${TASKS} tasks completed in ${elapsed.toFixed(1)}ms (sleep was ${SLEEP_MS}ms)`);
if (done !== TASKS) throw new Error("lost tasks");
