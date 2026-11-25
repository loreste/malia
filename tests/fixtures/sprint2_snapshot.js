// Test: snapshot testing in node:test
import { test, snapshot } from "node:test";

test("snapshot test", (t) => {
  t.snapshot({ name: "malia", version: 3 }, "config_snapshot");
});

// Direct snapshot API
snapshot([1, 2, 3], "array_snapshot");

console.log("PASS: snapshot tests completed");
