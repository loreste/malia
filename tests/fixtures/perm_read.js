// Permission probe: reads a file relative to the process cwd.
import { readFileSync } from "node:fs";
readFileSync("Cargo.toml", "utf8");
console.log("READ OK");
