"use strict";
// Required at runtime by a computed path; its own relative require must
// resolve from sub/, not from the parent's directory.
exports.sibling = require("./sibling.js").name;
