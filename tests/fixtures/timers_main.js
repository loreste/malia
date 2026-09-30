// Timer heap fixture: ordering, cancellation, clearTimeout-before-fire,
// sleep(0), setInterval, coalescing of identical deadlines.
function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// 1. Out-of-order deadlines fire in order.
{
  const fired = [];
  setTimeout(() => fired.push("c"), 30);
  setTimeout(() => fired.push("a"), 5);
  setTimeout(() => fired.push("b"), 15);
  await sleep(60);
  assertEq(fired.join(""), "abc", "out-of-order deadlines");
}

// 2. clearTimeout before fire suppresses the callback.
{
  let fired = false;
  const id = setTimeout(() => {
    fired = true;
  }, 10);
  clearTimeout(id);
  await sleep(30);
  assertEq(fired, false, "clearTimeout before fire");
}

// 3. Clearing the earliest timer re-arms the pump to the next one.
{
  const order = [];
  const far = setTimeout(() => order.push("far"), 40);
  setTimeout(() => order.push("near"), 10);
  clearTimeout(far);
  await sleep(60);
  assertEq(order.join(""), "near", "clear earliest re-arms");
}

// 4. sleep(0) yields but does not meaningfully delay.
{
  const t0 = performance.now();
  await sleep(0);
  const elapsed = performance.now() - t0;
  if (elapsed > 25) throw new Error(`sleep(0) took ${elapsed.toFixed(1)}ms`);
}

// 5. setInterval fires repeatedly and clearInterval stops it.
{
  let ticks = 0;
  const id = setInterval(() => {
    ticks += 1;
    if (ticks === 3) clearInterval(id);
  }, 5);
  await sleep(60);
  assertEq(ticks, 3, "setInterval ticks");
}

// 6. 10k identical-deadline sleeps coalesce (heap, single armed op) and all
// resolve on time.
{
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 10_000 }, () => sleep(20)));
  const elapsed = performance.now() - t0;
  if (elapsed > 100) throw new Error(`10k sleep(20) took ${elapsed.toFixed(1)}ms`);
}

// 7. A cleared far timer must not hold the event loop open (the Rust test
// asserts the whole fixture finishes well under the far deadline).
{
  const id = setTimeout(() => {
    throw new Error("cleared timer fired");
  }, 5_000);
  clearTimeout(id);
}

// 8. Sleeping past an already-elapsed deadline resolves immediately.
{
  await sleep(-5);
}

console.log("TIMERS: PASS");
