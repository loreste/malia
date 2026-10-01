import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
const context = new AsyncLocalStorage();
let waiting = [];
function barrier() {
  return new Promise(resolve => {
    waiting.push(resolve);
    if (waiting.length === 2) { const pair = waiting; waiting = []; pair.forEach(release => release()); }
  });
}
const server = jse.serve({ hostname: '127.0.0.1', port: 0, limits: {
  maxBodyBytes: 1024, maxRequests: 2, bodyTimeoutMs: 200, requestTimeoutMs: 200
}}, async req => {
  if (req.url.endsWith('/context')) {
    const id = req.headers.get('x-request-id');
    const result = context.run(id, () => jse.trace.startSpan(id, async span => {
      assert.equal(span.parentSpanId, null);
      await barrier();
      assert.equal(context.getStore(), id);
      await new Promise(resolve => setTimeout(resolve, 1));
      await readFile('tests/fixtures/data.json');
      const response = await fetch(`http://127.0.0.1:${server.port}/nested`);
      await response.text();
      assert.equal(context.getStore(), id);
      assert.equal(jse.trace.activeSpan().name, id);
      return new Response(id);
    }));
    assert.equal(context.getStore(), undefined);
    assert.equal(jse.trace.activeSpan(), null);
    return result;
  }
  if (req.url.endsWith('/wait')) await new Promise(() => {});
  return new Response('ok');
});
console.log(server.port);
