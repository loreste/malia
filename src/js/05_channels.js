// chan(): structured messaging between async tasks, backed by tokio mpsc.
// Values travel as V8 structured-clone binaries (op_serialize), so Map/Set,
// typed arrays, Dates and nested objects all round-trip. An empty payload
// signals end-of-channel.
"use strict";

((globalThis) => {
  const ops = Deno.core.ops;

  function chan(capacity = 0) {
    const cap = Math.max(0, Math.floor(capacity) || 0);
    const id = ops.op_chan_new(cap);
    let closed = false;
    return {
      get id() {
        return id;
      },
      get capacity() {
        return ops.op_chan_capacity(id);
      },
      get closed() {
        return closed;
      },
      async send(value) {
        if (closed) throw new Error("send on closed channel");
        const ok = await ops.op_chan_send(id, __jse.serialize(value));
        if (!ok) throw new Error("send on closed channel");
      },
      // Resolves to { value, done }. done=true once the channel is closed
      // and drained.
      async recv() {
        const bytes = await ops.op_chan_recv(id);
        if (bytes.length === 0) return { value: undefined, done: true };
        return { value: __jse.deserialize(bytes), done: false };
      },
      close() {
        closed = true;
        ops.op_chan_close(id);
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => this.recv(),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  globalThis.chan = chan;
})(globalThis);
