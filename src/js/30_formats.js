// malia.yaml and malia.toml -- built-in config format parsing.
// Eliminates js-yaml (70M/week) and @iarna/toml.
(function (globalThis) {
  const ops = Deno.core.ops;

  function makeFormat(parseFn, stringifyFn) {
    return {
      parse(input) {
        if (typeof input !== "string") throw new TypeError("input must be a string");
        return parseFn(input);
      },
      stringify(value) {
        return stringifyFn(value);
      },
    };
  }

  const yaml = makeFormat(ops.op_yaml_parse, ops.op_yaml_stringify);
  const toml = makeFormat(ops.op_toml_parse, ops.op_toml_stringify);

  globalThis.jse = globalThis.jse || {};
  globalThis.jse.yaml = yaml;
  globalThis.jse.toml = toml;
  globalThis.malia = globalThis.malia || globalThis.jse;
  if (globalThis.malia !== globalThis.jse) {
    globalThis.malia.yaml = yaml;
    globalThis.malia.toml = toml;
  }
})(globalThis);
