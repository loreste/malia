// Permission model demo.
//   jse run examples/permissions.js            -> PermissionDenied
//   jse run --allow-read examples/permissions.js -> works
import { readFileSync } from "node:fs";

const pkg = readFileSync("README.md", "utf8");
console.log(`read README.md: ${pkg.length} bytes (fs read allowed)`);
