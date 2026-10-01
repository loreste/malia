import assert from 'node:assert/strict';
const trace = jse.trace;
trace.clear();
let release;
const gate = new Promise(r => { release = r; });
const a = trace.startSpan('A', async parent => {
  await gate;
  trace.startSpan('A-child', child => {
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.parentSpanId, parent.spanId);
  });
});
assert.equal(trace.activeSpan(), null);
const b = trace.startSpan('B', async parent => {
  assert.equal(parent.parentSpanId, null);
  await gate;
  trace.startSpan('B-child', child => assert.equal(child.traceId, parent.traceId));
});
release();
await Promise.all([a, b]);
assert.equal(trace.activeSpan(), null);
assert.equal(trace.extract({ traceparent: '00-invalid-invalid-01' }), null);
assert.equal(trace.extract({ traceparent: `00-${'0'.repeat(32)}-${'1'.repeat(16)}-01` }), null);
const carrier = new Headers({ traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00` });
const incoming = trace.extract(carrier);
assert.equal(incoming.flags, '00');
const span = trace.startSpan('remote', incoming);
assert.equal(span.toTraceparent().slice(-2), '00');
span.setAttribute('integer', 42).setAttribute('fraction', 1.5).setAttribute('bool', true).end();
const exported = trace.export().resourceSpans[0].scopeSpans[0].spans;
assert.equal(typeof exported[0].startTimeUnixNano, 'string');
assert.equal(typeof exported[0].status.code, 'number');
const attrs = exported.find(s => s.name === 'remote').attributes;
assert.equal(attrs.find(a => a.key === 'integer').value.intValue, '42');
assert.equal(attrs.find(a => a.key === 'fraction').value.doubleValue, 1.5);
assert.equal(attrs.find(a => a.key === 'bool').value.boolValue, true);
console.log('MAL_008_OK');
