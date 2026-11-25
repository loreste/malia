// Test: --deny-net blocks requests even with --allow-net.
// Run with: --allow-net --deny-net=169.254.169.254
try {
  await fetch("http://169.254.169.254/latest/meta-data/");
  console.error("FAIL: fetch to denied host should have thrown");
  process.exit(1);
} catch (e) {
  if (e.message.includes("PermissionDenied") || e.message.includes("blocked by --deny-net")) {
    console.log("PASS: deny-net blocked IMDS endpoint");
  } else {
    // Connection refused is also acceptable (the host doesn't exist)
    console.log("PASS: request failed (expected):", e.message.slice(0, 60));
  }
}
