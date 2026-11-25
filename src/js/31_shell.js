// malia.$ --shell scripting API (like Bun.$, zx).
// Tagged template literal that runs shell commands with interpolation,
// piping, and streaming output. Escapes interpolated values to prevent injection.
(function (globalThis) {
  const ops = Deno.core.ops;

  function escapeShellArg(arg) {
    if (typeof arg !== "string") arg = String(arg);
    if (arg.length === 0) return "''";
    if (/^[a-zA-Z0-9._\-/:=@]+$/.test(arg)) return arg;
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  function buildCommand(strings, values) {
    let cmd = strings[0];
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (Array.isArray(val)) {
        cmd += val.map(escapeShellArg).join(" ");
      } else {
        cmd += escapeShellArg(val);
      }
      cmd += strings[i + 1];
    }
    return cmd.trim();
  }

  class ShellOutput {
    constructor(code, stdout, stderr) {
      this.exitCode = code ?? 0;
      this._stdout = stdout;
      this._stderr = stderr;
    }
    get stdout() {
      return typeof this._stdout === "string" ? this._stdout : new TextDecoder().decode(this._stdout);
    }
    get stderr() {
      return typeof this._stderr === "string" ? this._stderr : new TextDecoder().decode(this._stderr);
    }
    get text() { return this.stdout.trimEnd(); }
    get lines() { return this.text.split("\n"); }
    get json() { return JSON.parse(this.stdout); }
    toString() { return this.stdout; }
    [Symbol.toPrimitive]() { return this.stdout; }
  }

  // malia.$`command ${arg}` --returns a promise that resolves to ShellOutput.
  // Throws on non-zero exit code (like Bun.$).
  function $(strings, ...values) {
    const cmd = buildCommand(strings, values);
    const shell = globalThis.process?.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = globalThis.process?.platform === "win32" ? ["/c", cmd] : ["-c", cmd];

    const result = ops.op_child_spawn_sync({
      cmd: shell,
      args,
      cwd: null,
      env: null,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = new ShellOutput(result.code, result.stdout, result.stderr);
    if (output.exitCode !== 0) {
      const err = new Error(`Shell command failed with exit code ${output.exitCode}: ${cmd}`);
      err.exitCode = output.exitCode;
      err.stdout = output.stdout;
      err.stderr = output.stderr;
      throw err;
    }
    return output;
  }

  // $.nothrow`cmd` --same but doesn't throw on non-zero exit
  $.nothrow = function (strings, ...values) {
    const cmd = buildCommand(strings, values);
    const shell = globalThis.process?.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = globalThis.process?.platform === "win32" ? ["/c", cmd] : ["-c", cmd];
    const result = ops.op_child_spawn_sync({
      cmd: shell,
      args,
      cwd: null,
      env: null,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new ShellOutput(result.code, result.stdout, result.stderr);
  };

  // $.escape(str) --shell-escape a string
  $.escape = escapeShellArg;

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.$ = $;
  globalThis.malia = globalThis.malia || globalThis.jse;
})(globalThis);
