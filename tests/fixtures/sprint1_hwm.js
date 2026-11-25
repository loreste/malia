// Test: stream HWM should be 64KB (not 16KB).
import { Readable } from "node:stream";

const r = new Readable({ read() {} });
const hwm = r.readableHighWaterMark;
console.log("hwm=" + hwm);
if (hwm !== 65536) {
  console.error("FAIL: expected 65536, got " + hwm);
  process.exit(1);
}
console.log("PASS: stream HWM is 64KB");
