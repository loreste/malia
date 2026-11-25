// Test: malia.$ shell scripting API
const result = malia.$`echo hello world`;
if (result.text !== "hello world") {
  console.error("FAIL: expected 'hello world', got:", JSON.stringify(result.text));
  process.exit(1);
}
console.log("PASS: basic shell command");

// Test interpolation with escaping
const name = "it's a test";
const r2 = malia.$`echo ${name}`;
if (!r2.text.includes("it's a test")) {
  console.error("FAIL: interpolation, got:", JSON.stringify(r2.text));
  process.exit(1);
}
console.log("PASS: shell interpolation with escaping");

// Test $.nothrow
const r3 = malia.$.nothrow`false`;
if (r3.exitCode === 0) {
  console.error("FAIL: expected non-zero exit code");
  process.exit(1);
}
console.log("PASS: $.nothrow returns non-zero exit code");

// Test that $ throws on failure
try {
  malia.$`false`;
  console.error("FAIL: should have thrown");
  process.exit(1);
} catch (e) {
  if (!e.message.includes("exit code")) {
    console.error("FAIL: wrong error:", e.message);
    process.exit(1);
  }
  console.log("PASS: $ throws on non-zero exit");
}
