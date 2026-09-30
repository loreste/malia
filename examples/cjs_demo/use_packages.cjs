// CommonJS module: require() of an npm package with its own dependency
// tree (minimist) and of lodash.
const minimist = require("minimist");
const _ = require("lodash");

module.exports = function runMinimistDemo() {
  const args = minimist(["--engine", "v8", "--turbo", "-x", "3"]);
  console.log("minimist parsed:", JSON.stringify(args));
  console.log("lodash from CJS:", _.snakeCase("helloFromCjs"));
};
