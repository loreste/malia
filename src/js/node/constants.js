// node:constants — System and library constants.
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";

export const osConstants = os.constants || {};
export const fsConstants = fs.constants || {};
export const cryptoConstants = crypto.constants || {};
export const zlibConstants = zlib.constants || {};

export default {
  ...osConstants,
  ...fsConstants,
  ...cryptoConstants,
  ...zlibConstants,
};
