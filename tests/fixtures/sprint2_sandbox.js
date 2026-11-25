// Test: --sandbox blocks file access
// Run with: --sandbox
import fs from "node:fs";
try {
  fs.readFileSync("/etc/hosts");
  console.error("FAIL: sandbox should deny file read");
  process.exit(1);
} catch (e) {
  if (e.message.includes("PermissionDenied")) {
    console.log("PASS: sandbox denies file read");
  } else {
    console.error("FAIL: unexpected error:", e.message);
    process.exit(1);
  }
}
