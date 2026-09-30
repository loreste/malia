#!/usr/bin/env node
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

function getPlatformPackage() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin") {
    return arch === "arm64" ? "@malia/darwin-arm64" : "@malia/darwin-x64";
  }
  if (platform === "linux") {
    const isMusl = () => {
      try {
        const report = process.report?.getReport();
        if (typeof report === "object" && report.header?.glibcVersionRuntime) {
          return false;
        }
      } catch (_) {}
      return false;
    };
    const libc = isMusl() ? "musl" : "gnu";
    return arch === "arm64" ? `@malia/linux-arm64-${libc}` : `@malia/linux-x64-${libc}`;
  }
  if (platform === "win32") {
    return "@malia/win32-x64";
  }
  throw new Error(`Unsupported platform for malia: ${platform} ${arch}`);
}

function resolveBinary() {
  const isWin = process.platform === "win32";
  const binName = isWin ? "malia.exe" : "malia";
  const altBinName = isWin ? "jse.exe" : "jse";
  const pkg = getPlatformPackage();

  // 1. Check vendor directory
  const vendorBinary = path.join(__dirname, "..", "vendor", binName);
  if (fs.existsSync(vendorBinary)) {
    return vendorBinary;
  }
  const vendorAlt = path.join(__dirname, "..", "vendor", altBinName);
  if (fs.existsSync(vendorAlt)) {
    return vendorAlt;
  }

  // 2. Try resolving platform package
  try {
    const pkgPath = require.resolve(`${pkg}/package.json`);
    const binary = path.join(path.dirname(pkgPath), "bin", binName);
    if (fs.existsSync(binary)) {
      return binary;
    }
    const altBinary = path.join(path.dirname(pkgPath), "bin", altBinName);
    if (fs.existsSync(altBinary)) {
      return altBinary;
    }
  } catch (_) {}

  // 3. Check local target directory if built from source
  const root = path.join(__dirname, "..", "..", "..");
  const candidates = [
    path.join(root, "target", "release", binName),
    path.join(root, "target", "release", altBinName),
    path.join(root, "target", "debug", binName),
    path.join(root, "target", "debug", altBinName),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }

  // 4. Also check system PATH for malia or jse
  try {
    const checkCmd = isWin ? "where" : "which";
    const out = spawnSync(checkCmd, [binName], { encoding: "utf8" });
    if (out.status === 0 && out.stdout.trim()) {
      const p = out.stdout.trim().split("\n")[0].trim();
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}

  throw new Error(
    `[malia] Native binary not found for platform '${pkg}'.\n` +
    `Install using the installer script:\n` +
    `  curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh`
  );
}

try {
  const binary = resolveBinary();
  const result = spawnSync(binary, process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[malia] Failed to execute binary: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.status ?? 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
