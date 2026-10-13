"use strict";
// Loaded only through a computed require: its own builtin requires must work
// even though no statically-scanned module imported them.
const zlib = require("node:zlib");
const { createHash } = require("crypto");
exports.ok = typeof zlib.gzipSync === "function" && createHash("sha256").update("x").digest("hex").length === 64;
