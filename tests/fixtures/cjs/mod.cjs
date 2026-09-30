const { add } = require("./other.cjs");
const data = require("./data.json");
const path = require("path");
const events = require("events");

const emitter = new events.EventEmitter();
let fired = null;
emitter.on("x", (v) => {
  fired = v;
});
emitter.emit("x", 9);

module.exports = {
  sum: add(1, 2),
  jsonAnswer: data.answer,
  base: path.basename(__filename),
  filename: __filename,
  dirname: __dirname,
  fired,
};
