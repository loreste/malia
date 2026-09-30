// Ping-pong between two async tasks over channels.
const toBob = chan();
const toAlice = chan();

async function alice() {
  for (let i = 1; i <= 5; i++) {
    await toBob.send({ from: "alice", n: i });
    const { value } = await toAlice.recv();
    console.log(`alice got: ${value.from} #${value.n}`);
  }
  toBob.close();
}

async function bob() {
  while (true) {
    const { value, done } = await toBob.recv();
    if (done) break;
    console.log(`bob got:   ${value.from} #${value.n}`);
    await toAlice.send({ from: "bob", n: value.n });
  }
}

await Promise.all([alice(), bob()]);
console.log("ping-pong complete");
