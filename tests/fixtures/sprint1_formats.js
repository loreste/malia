// Test: malia.yaml and malia.toml parsing/stringify.
const yaml = malia.yaml;
const toml = malia.toml;

// YAML
const yamlData = yaml.parse("name: malia\nversion: 1\nitems:\n  - a\n  - b\n");
if (yamlData.name !== "malia" || yamlData.version !== 1 || yamlData.items.length !== 2) {
  console.error("FAIL: yaml.parse", yamlData);
  process.exit(1);
}
const yamlStr = yaml.stringify({ hello: "world", n: 42 });
if (!yamlStr.includes("hello") || !yamlStr.includes("42")) {
  console.error("FAIL: yaml.stringify", yamlStr);
  process.exit(1);
}
console.log("PASS: yaml parse/stringify");

// TOML
const tomlData = toml.parse('[server]\nhost = "0.0.0.0"\nport = 3000\n');
if (tomlData.server.host !== "0.0.0.0" || tomlData.server.port !== 3000) {
  console.error("FAIL: toml.parse", tomlData);
  process.exit(1);
}
const tomlStr = toml.stringify({ app: { name: "test", debug: true } });
if (!tomlStr.includes("name") || !tomlStr.includes("test")) {
  console.error("FAIL: toml.stringify", tomlStr);
  process.exit(1);
}
console.log("PASS: toml parse/stringify");
