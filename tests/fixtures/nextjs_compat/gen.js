"use strict";
// CommonJS writing ESM source in a template nested inside ${...} (as
// next/dist/build/utils.js does); must not be detected as ESM.
const esm = false;
exports.code = `${esm ? `
import path from 'node:path'
` : `const path = require('path')`}
`;
