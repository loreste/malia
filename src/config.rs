use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

pub static CONFIG_ENV: LazyLock<RwLock<HashMap<String, String>>> = LazyLock::new(|| RwLock::new(HashMap::new()));

fn non_null_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
  deserializer: D,
) -> Result<Option<T>, D::Error> {
  T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigPermissions {
  #[serde(default, deserialize_with = "non_null_option")]
  pub all: Option<bool>,
  #[serde(default, deserialize_with = "non_null_option")]
  pub net: Option<serde_json::Value>, // bool or array of strings
  #[serde(default, deserialize_with = "non_null_option")]
  pub read: Option<serde_json::Value>, // bool or array of strings
  #[serde(default, deserialize_with = "non_null_option")]
  pub write: Option<serde_json::Value>, // bool or array of strings
  #[serde(default, deserialize_with = "non_null_option")]
  pub run: Option<serde_json::Value>, // bool or array of strings
  #[serde(default, deserialize_with = "non_null_option")]
  pub env: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfigPermissionsField {
  Preset(String), // "all", "allow-all", "strict", "permissive", "none"
  Detailed(Box<ConfigPermissions>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfigWatch {
  Enabled(bool),
  Detailed {
    paths: Option<Vec<String>>,
    extensions: Option<Vec<String>>,
  },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfigCluster {
  Auto(String), // "auto"
  Workers(usize),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigProduction {
  pub port: Option<u16>,
  pub metrics: Option<bool>,
  pub log_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JseConfig {
  #[serde(rename = "$schema")]
  pub schema: Option<String>,
  pub name: Option<String>,
  pub version: Option<String>,
  pub description: Option<String>,
  pub entry: Option<String>,
  pub env: Option<HashMap<String, serde_json::Value>>,
  pub env_file: Option<String>,
  #[serde(default, deserialize_with = "non_null_option")]
  pub permissions: Option<ConfigPermissionsField>,
  pub watch: Option<ConfigWatch>,
  pub cluster: Option<ConfigCluster>,
  pub paths: Option<HashMap<String, serde_json::Value>>,
  pub alias: Option<HashMap<String, String>>,
  pub production: Option<ConfigProduction>,
  pub scripts: Option<HashMap<String, String>>,
}

// Minimal schema for fallback package.json parsing
#[derive(Debug, Clone, Deserialize)]
struct PackageJsonFallback {
  name: Option<String>,
  version: Option<String>,
  main: Option<String>,
  module: Option<String>,
  scripts: Option<HashMap<String, String>>,
}

/// Strip // line comments, /* */ block comments, and trailing commas from JSON
/// while strictly preserving string literals and escapes.
pub fn strip_comments_and_trailing_commas(input: &str) -> String {
  let mut output = String::with_capacity(input.len());
  let chars: Vec<char> = input.chars().collect();
  let len = chars.len();
  let mut i = 0;
  let mut in_string = false;
  let mut escape = false;

  while i < len {
    let c = chars[i];

    if in_string {
      output.push(c);
      if escape {
        escape = false;
      } else if c == '\\' {
        escape = true;
      } else if c == '"' {
        in_string = false;
      }
      i += 1;
      continue;
    }

    if c == '"' {
      in_string = true;
      output.push(c);
      i += 1;
      continue;
    }

    // Line comment //
    if c == '/' && i + 1 < len && chars[i + 1] == '/' {
      i += 2;
      while i < len && chars[i] != '\n' {
        i += 1;
      }
      continue;
    }

    // Block comment /* ... */
    if c == '/' && i + 1 < len && chars[i + 1] == '*' {
      i += 2;
      while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
        if chars[i] == '\n' {
          output.push('\n');
        }
        i += 1;
      }
      i = (i + 2).min(len);
      continue;
    }

    // Trailing comma check before '}' or ']'
    if c == ',' {
      let mut j = i + 1;
      let mut is_trailing = false;
      while j < len {
        let next_c = chars[j];
        if next_c.is_whitespace() {
          j += 1;
        } else if next_c == '/' && j + 1 < len && chars[j + 1] == '/' {
          j += 2;
          while j < len && chars[j] != '\n' {
            j += 1;
          }
        } else if next_c == '/' && j + 1 < len && chars[j + 1] == '*' {
          j += 2;
          while j + 1 < len && !(chars[j] == '*' && chars[j + 1] == '/') {
            j += 1;
          }
          j = (j + 2).min(len);
        } else if next_c == '}' || next_c == ']' {
          is_trailing = true;
          break;
        } else {
          break;
        }
      }

      if is_trailing {
        i += 1;
        continue;
      }
    }

    output.push(c);
    i += 1;
  }

  output
}

/// Expand environment variables matching ${NAME} or ${NAME:-default}
pub fn expand_env_vars(input: &str, env_lookup: &HashMap<String, String>) -> String {
  let mut result = String::with_capacity(input.len());
  let mut chars = input.chars().peekable();

  while let Some(c) = chars.next() {
    if c == '$' && chars.peek() == Some(&'{') {
      chars.next(); // consume '{'
      let mut var_expr = String::new();
      while let Some(&vc) = chars.peek() {
        chars.next();
        if vc == '}' {
          break;
        }
        var_expr.push(vc);
      }

      let (var_name, default_val) = if let Some((name, def)) = var_expr.split_once(":-") {
        (name.trim(), Some(def.trim()))
      } else {
        (var_expr.trim(), None)
      };

      let val = std::env::var(var_name)
        .ok()
        .or_else(|| env_lookup.get(var_name).cloned())
        .or_else(|| default_val.map(|s| s.to_string()))
        .unwrap_or_default();

      result.push_str(&val);
    } else {
      result.push(c);
    }
  }

  result
}

impl JseConfig {
  /// Parse JSON string with comments (JSONC) and trailing comma relaxation
  pub fn parse_json(content: &str) -> Result<Self, serde_json::Error> {
    let cleaned = strip_comments_and_trailing_commas(content);
    serde_json::from_str(&cleaned)
  }

  /// Discover and load a config file starting in `start_dir` and traversing up.
  /// Checks in order: malia.json, malia.toml, malia.config.json, jse.json, jse.toml, jse.config.json, and package.json fallback.
  pub fn discover(start_dir: &Path) -> anyhow::Result<Option<(PathBuf, Self)>> {
    use anyhow::Context;
    let mut current = start_dir.to_path_buf();
    loop {
      for name in [
        "malia.json",
        "malia.toml",
        "malia.config.json",
        "jse.json",
        "jse.toml",
        "jse.config.json",
      ] {
        let path = current.join(name);
        if !path.exists() {
          continue;
        }
        let content = std::fs::read_to_string(&path).with_context(|| format!("read config {}", path.display()))?;
        let config: Self = if name.ends_with(".toml") {
          toml::from_str(&content).with_context(|| format!("invalid config {}", path.display()))?
        } else {
          Self::parse_json(&content).with_context(|| format!("invalid config {}", path.display()))?
        };
        config
          .build_permissions()
          .with_context(|| format!("invalid permissions in {}", path.display()))?;
        return Ok(Some((path, config)));
      }
      let path = current.join("package.json");
      if path.is_file() {
        let content = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let pkg: PackageJsonFallback =
          serde_json::from_str(&content).with_context(|| format!("invalid {}", path.display()))?;
        return Ok(Some((
          path,
          Self {
            name: pkg.name,
            version: pkg.version,
            entry: pkg.main.or(pkg.module),
            scripts: pkg.scripts,
            ..Default::default()
          },
        )));
      }
      if !current.pop() {
        break;
      }
    }
    Ok(None)
  }

  /// Load environment variables defined in inline `env` or `.env` files.
  pub fn apply_env(&self, base_dir: &Path) {
    let mut intermediate_env = HashMap::new();

    // 1. Load from custom env_file or default .env if present
    let dotenv_path = if let Some(custom) = &self.env_file {
      base_dir.join(custom)
    } else {
      base_dir.join(".env")
    };

    if dotenv_path.is_file()
      && let Ok(content) = std::fs::read_to_string(&dotenv_path)
    {
      Self::parse_dotenv_into(&content, &mut intermediate_env);
    }

    // 2. Load inline env map (overrides .env)
    if let Some(map) = &self.env {
      for (k, v) in map {
        let val_str = match v {
          serde_json::Value::String(s) => s.clone(),
          other => other.to_string(),
        };
        intermediate_env.insert(k.clone(), val_str);
      }
    }

    // 3. Expand variables (e.g. ${PORT:-3000}) and store into CONFIG_ENV
    if let Ok(mut lock) = CONFIG_ENV.write() {
      for (k, v) in &intermediate_env {
        let expanded = expand_env_vars(v, &intermediate_env);
        lock.insert(k.clone(), expanded);
      }
    }
  }

  /// Parse .env key=value pairs into map
  fn parse_dotenv_into(content: &str, out: &mut HashMap<String, String>) {
    for line in content.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() || trimmed.starts_with('#') {
        continue;
      }
      if let Some((key, val)) = trimmed.split_once('=') {
        let key = key.trim();
        let mut val = val.trim();
        if ((val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')))
          && val.len() >= 2
        {
          val = &val[1..val.len() - 1];
        }
        if !key.is_empty() {
          out.insert(key.to_string(), val.to_string());
        }
      }
    }
  }

  /// Resolve application entry point
  pub fn resolve_entry(&self, base_dir: &Path) -> Option<PathBuf> {
    if let Some(entry_str) = &self.entry {
      let p = base_dir.join(entry_str);
      if p.exists() {
        return Some(p);
      }
    }

    // Common conventions
    let candidates = [
      "src/index.ts",
      "src/index.js",
      "src/main.ts",
      "src/main.js",
      "src/app.ts",
      "src/app.js",
      "index.ts",
      "index.js",
      "main.ts",
      "main.js",
      "app.ts",
      "app.js",
    ];

    for c in candidates {
      let p = base_dir.join(c);
      if p.is_file() {
        return Some(p);
      }
    }

    None
  }

  /// Build permissions from configuration file
  pub fn build_permissions(&self) -> anyhow::Result<Option<crate::permissions::Permissions>> {
    use crate::permissions::{PermFlag, Permissions};
    let Some(field) = &self.permissions else {
      return Ok(None);
    };
    let permissions = match field {
      ConfigPermissionsField::Preset(p) => match p.as_str() {
        "all" | "allow-all" | "permissive" | "true" => Permissions::allow_all(),
        "none" | "strict" | "false" => Permissions::default(),
        _ => anyhow::bail!("unknown permission preset {p:?}"),
      },
      ConfigPermissionsField::Detailed(perms) => {
        let mut flags = Vec::new();
        for (name, value) in [
          ("allow-read", &perms.read),
          ("allow-write", &perms.write),
          ("allow-net", &perms.net),
          ("allow-run", &perms.run),
        ] {
          let Some(value) = value else {
            continue;
          };
          let scope = match value {
            serde_json::Value::Bool(false) => continue,
            serde_json::Value::Bool(true) => None,
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(items) => {
              anyhow::ensure!(!items.is_empty(), "{name}: empty allowlist; use false to deny");
              let mut strings = Vec::new();
              for item in items {
                let item = item
                  .as_str()
                  .ok_or_else(|| anyhow::anyhow!("{name}: entries must be strings"))?;
                anyhow::ensure!(
                  !item.trim().is_empty() && !item.contains(','),
                  "{name}: invalid allowlist entry"
                );
                strings.push(item);
              }
              Some(strings.join(","))
            }
            _ => anyhow::bail!("{name}: expected boolean, string or string array"),
          };
          if let Some(scope) = &scope {
            anyhow::ensure!(
              scope.split(',').all(|s| !s.trim().is_empty()),
              "{name}: empty allowlist entry"
            );
          }
          flags.push(crate::permissions::parse_flag(name, scope.as_deref()).expect("known permission flag"));
        }
        if perms.env == Some(true) {
          flags.push(PermFlag::Env);
        }
        // Validate every granular rule even when all is explicit.
        if perms.all == Some(true) {
          Permissions::allow_all()
        } else {
          crate::permissions::from_flags(flags)
        }
      }
    };
    Ok(Some(permissions))
  }

  /// Get specific value by key path (e.g., "entry", "name", "env.PORT")
  pub fn get_value(&self, key: &str) -> Option<String> {
    match key {
      "name" => self.name.clone(),
      "version" => self.version.clone(),
      "entry" => self.entry.clone(),
      "description" => self.description.clone(),
      k if k.starts_with("env.") => {
        let env_key = &k[4..];
        self.env.as_ref().and_then(|m| m.get(env_key)).map(|v| match v {
          serde_json::Value::String(s) => s.clone(),
          other => other.to_string(),
        })
      }
      "permissions" => match &self.permissions {
        Some(ConfigPermissionsField::Preset(p)) => Some(p.clone()),
        Some(ConfigPermissionsField::Detailed(d)) => serde_json::to_string(d).ok(),
        None => None,
      },
      _ => None,
    }
  }

  /// Generate a starter template for `malia.json` (or `jse.json`)
  pub fn default_template() -> &'static str {
    r#"{
  "$schema": "https://malia.dev/schema.json",
  "name": "my-app",
  "version": "1.0.0",

  // Application entry point (.ts, .js, .tsx, .jsx)
  "entry": "src/index.ts",

  // Environment variables loaded automatically into process.env
  "env": {
    "PORT": 3000,
    "NODE_ENV": "development",
  },

  // Security permissions: "all", "strict", or granular rules
  "permissions": "all",

  // Path aliases
  "paths": {
    "@/*": "./src/*",
  },

  // Scripts executed with `malia <script>` or `jse <script>`
  "scripts": {
    "dev": "malia dev",
    "start": "malia start",
    "build": "malia build",
    "test": "malia test",
  },

  // Production telemetry and observability
  "production": {
    "port": 3000,
    "metrics": true,
    "logLevel": "info",
  },
}
"#
  }

  /// Generate a starter template for `malia.toml` (or `jse.toml`)
  pub fn default_toml_template() -> &'static str {
    r#"# malia.toml configuration
name = "my-app"
version = "1.0.0"
entry = "src/index.ts"
permissions = "all"

[env]
PORT = "3000"
NODE_ENV = "development"

[paths]
"@/*" = "./src/*"

[scripts]
dev = "malia dev"
start = "malia start"
build = "malia build"
test = "malia test"

[production]
port = 3000
metrics = true
logLevel = "info"
"#
  }
}
