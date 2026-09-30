// node:child_process fixture: spawn/execFile/execFileSync/spawnSync/execSync,
// output capture, non-zero exit, error events, kill, env/cwd options.
import { spawn, execFile, execFileSync, spawnSync, execSync } from "node:child_process";

function assertEq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// 1. spawn /bin/echo, capture via close + stdout stream.
{
  const child = spawn("/bin/echo", ["hello", "world"]);
  const [code, stdoutText] = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stdout.on("end", () => resolve([code, text]));
    });
  });
  assertEq(code, 0, "echo exit code");
  assertEq(stdoutText, "hello world\n", "echo stdout");
}

// 2. execFile on node itself, callback style.
{
  const { stdout } = await new Promise((resolve, reject) => {
    execFile("node", ["-e", "process.stdout.write('cb works')"], (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
  assertEq(String(stdout), "cb works", "execFile callback");
}

// 3. execFile promise style + env option.
{
  const { stdout } = await execFile("/bin/sh", ["-c", "echo $JSE_CP_TEST"], {
    env: { JSE_CP_TEST: "env-ok", PATH: "/usr/bin:/bin" },
  });
  assertEq(String(stdout).trim(), "env-ok", "env option");
}

// 4. Non-zero exit propagates.
{
  const child = spawn("/bin/sh", ["-c", "exit 3"]);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assertEq(code, 3, "non-zero exit");
}

// 5. spawnSync + encoding option.
{
  const result = spawnSync("/bin/echo", ["sync-ok"], { encoding: "utf8" });
  assertEq(result.status, 0, "spawnSync status");
  assertEq(result.stdout.trim(), "sync-ok", "spawnSync stdout");
  if (typeof result.stdout !== "string") throw new Error("encoding option ignored");
}

// 6. execFileSync + execSync failure.
{
  const out = execFileSync("/bin/echo", ["direct"]);
  assertEq(String(out).trim(), "direct", "execFileSync");
  let threw = null;
  try {
    execSync("exit 5");
  } catch (err) {
    threw = err;
  }
  assertEq(threw?.status, 5, "execSync failure status");
}

// 7. Missing binary emits 'error'.
{
  const child = spawn("/nonexistent-binary-xyz");
  const err = await new Promise((resolve) => child.on("error", resolve));
  if (!err) throw new Error("no error event for missing binary");
}

// 8. kill() terminates a long-running child.
{
  const child = spawn("/bin/sleep", ["30"]);
  child.kill();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  // SIGKILL => no exit code (null), but the process is gone.
  if (code === 0) throw new Error("killed child exited cleanly");
}

console.log("CHILD_PROCESS: PASS");
