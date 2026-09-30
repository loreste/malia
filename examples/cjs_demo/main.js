// npm interop demo: ESM import + CJS require of real packages.
// Run `npm install` in this directory first.
import _ from "lodash";
import chalk from "chalk";
import runMinimistDemo from "./use_packages.cjs";

console.log("lodash _.difference:", _.difference([3, 2, 1, 4], [2, 4]));
console.log("lodash _.capitalize:", _.capitalize("jse runtime"));
console.log(chalk.blue("chalk"), "loaded, version:", chalk.level >= 0 ? "ok" : "?");

runMinimistDemo();
