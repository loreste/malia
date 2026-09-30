// child_process. Run: jse run --allow-run examples/child_process.js
import { spawn, execFile, spawnSync } from "node:child_process";

// spawn with events (stdout/stderr materialize as streams at close)
const child = spawn("/bin/echo", ["hello from spawn"]);
await new Promise((resolve) => child.on("close", (code) => {
  console.log("exit code:", code);
  resolve();
}));
child.stdout.on("data", (chunk) => process.stdout.write("stdout: " + chunk));

// execFile with promise
const { stdout } = await execFile("node", ["-e", "console.log('hello from execFile')"]);
console.log(String(stdout).trim());

// spawnSync
const result = spawnSync("/bin/sh", ["-c", "echo sync && exit 0"], { encoding: "utf8" });
console.log("sync:", result.stdout.trim(), "status:", result.status);
