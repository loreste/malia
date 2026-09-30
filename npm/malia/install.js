"use strict";

const fs = require("fs");
const path = require("path");

function postinstall() {
  const binName = process.platform === "win32" ? "malia.exe" : "malia";
  const localTarget = path.join(__dirname, "..", "..", "target", "release", binName);
  const vendorDir = path.join(__dirname, "vendor");

  if (!fs.existsSync(vendorDir)) {
    try {
      fs.mkdirSync(vendorDir, { recursive: true });
    } catch (_) {}
  }

  // If built locally in workspace, copy into vendor
  if (fs.existsSync(localTarget)) {
    const dest = path.join(vendorDir, binName);
    try {
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(localTarget, dest);
        if (process.platform !== "win32") {
          fs.chmodSync(dest, 0o755);
        }
      }
    } catch (_) {}
  }

  // Ensure bin/malia.js is executable
  const wrapper = path.join(__dirname, "bin", "malia.js");
  if (fs.existsSync(wrapper) && process.platform !== "win32") {
    try {
      fs.chmodSync(wrapper, 0o755);
    } catch (_) {}
  }
}

try {
  postinstall();
} catch (_) {}
