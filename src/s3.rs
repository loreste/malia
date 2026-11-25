// Built-in S3 client: GET, PUT, DELETE, LIST, presigned URLs.
// SigV4 signing using ring HMAC-SHA256. Works with AWS S3, R2, MinIO.
// Eliminates @aws-sdk/client-s3 (massive dependency tree).

use std::io::Write;

use deno_core::OpState;
use deno_core::op2;
use deno_error::JsErrorBox;
use ring::hmac;

// ---------------------------------------------------------------------------
// SigV4 signing helpers
// ---------------------------------------------------------------------------

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
  let k = hmac::Key::new(hmac::HMAC_SHA256, key);
  hmac::sign(&k, data).as_ref().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
  use sha2::Digest;
  let hash = sha2::Sha256::digest(data);
  hex::encode(hash)
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
  let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
  let k_region = hmac_sha256(&k_date, region.as_bytes());
  let k_service = hmac_sha256(&k_region, service.as_bytes());
  hmac_sha256(&k_service, b"aws4_request")
}

fn utc_now() -> (String, String) {
  // ISO 8601 timestamps for SigV4
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs();
  // Simple UTC formatting without chrono
  let secs = now;
  let days = secs / 86400;
  let time_of_day = secs % 86400;
  let hours = time_of_day / 3600;
  let minutes = (time_of_day % 3600) / 60;
  let seconds = time_of_day % 60;

  // Days since epoch to y/m/d (simplified)
  let mut y = 1970i64;
  let mut remaining = days as i64;
  loop {
    let year_days = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
      366
    } else {
      365
    };
    if remaining < year_days {
      break;
    }
    remaining -= year_days;
    y += 1;
  }
  let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
  let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let mut m = 0;
  for (i, &md) in month_days.iter().enumerate() {
    if remaining < md as i64 {
      m = i + 1;
      break;
    }
    remaining -= md as i64;
  }
  let d = remaining + 1;

  let date = format!("{y:04}{m:02}{d:02}");
  let datetime = format!("{date}T{hours:02}{minutes:02}{seconds:02}Z");
  (date, datetime)
}

fn hex_encode(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// A minimal hex module since we don't want to add a crate for this
mod hex {
  pub fn encode(data: impl AsRef<[u8]>) -> String {
    data.as_ref().iter().map(|b| format!("{b:02x}")).collect()
  }
}

// ---------------------------------------------------------------------------
// S3 client
// ---------------------------------------------------------------------------

struct S3Client {
  endpoint: String, // e.g. "https://s3.us-east-1.amazonaws.com"
  bucket: String,
  region: String,
  access_key: String,
  secret_key: String,
}

impl S3Client {
  fn sign_request(
    &self,
    method: &str,
    path: &str,
    query: &str,
    body: &[u8],
  ) -> Result<Vec<(String, String)>, JsErrorBox> {
    let (date, datetime) = utc_now();
    let host = self
      .endpoint
      .replace("https://", "")
      .replace("http://", "")
      .trim_end_matches('/')
      .to_string();
    let payload_hash = sha256_hex(body);

    // Canonical request
    let canonical_headers = format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{datetime}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical = format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");

    let scope = format!("{date}/{}/{}/aws4_request", self.region, "s3");
    let string_to_sign = format!(
      "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
      sha256_hex(canonical.as_bytes())
    );

    let key = signing_key(&self.secret_key, &date, &self.region, "s3");
    let signature = hex_encode(&hmac_sha256(&key, string_to_sign.as_bytes()));

    let auth = format!(
      "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
      self.access_key
    );

    Ok(vec![
      ("Authorization".into(), auth),
      ("x-amz-date".into(), datetime),
      ("x-amz-content-sha256".into(), payload_hash),
      ("Host".into(), host),
    ])
  }

  fn url(&self, key: &str) -> String {
    format!(
      "{}/{}/{}",
      self.endpoint.trim_end_matches('/'),
      self.bucket,
      key.trim_start_matches('/')
    )
  }

  fn http(&self, method: &str, key: &str, body: &[u8]) -> Result<(u16, String), JsErrorBox> {
    let path = format!("/{}/{}", self.bucket, key.trim_start_matches('/'));
    let headers = self.sign_request(method, &path, "", body)?;
    let url = self.url(key);

    // Use curl for HTTP (consistent with pkg.rs)
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["-sS", "-X", method, "-o", "-", "-w", "\n%{http_code}"]);
    for (k, v) in &headers {
      cmd.args(["-H", &format!("{k}: {v}")]);
    }
    if !body.is_empty() {
      cmd.args(["--data-binary", "@-"]);
      cmd.stdin(std::process::Stdio::piped());
    }
    cmd.arg(&url);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
      .spawn()
      .map_err(|e| JsErrorBox::generic(format!("S3 request failed: {e}")))?;

    if !body.is_empty()
      && let Some(mut stdin) = child.stdin.take()
    {
      let _ = stdin.write_all(body);
    }

    let output = child
      .wait_with_output()
      .map_err(|e| JsErrorBox::generic(format!("S3 request: {e}")))?;
    let full = String::from_utf8_lossy(&output.stdout);
    // Last line is the HTTP status code
    let (body_str, code_str) = full.rsplit_once('\n').unwrap_or(("", &full));
    let status: u16 = code_str.trim().parse().unwrap_or(0);
    Ok((status, body_str.to_string()))
  }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

struct S3Table {
  clients: Vec<S3Client>,
}

fn s3_table(state: &mut OpState) -> &mut S3Table {
  if !state.has::<S3Table>() {
    state.put(S3Table { clients: Vec::new() });
  }
  state.borrow_mut::<S3Table>()
}

#[op2(fast)]
pub fn op_s3_connect(
  state: &mut OpState,
  #[string] endpoint: String,
  #[string] bucket: String,
  #[string] region: String,
  #[string] access_key: String,
  #[string] secret_key: String,
) -> Result<u32, JsErrorBox> {
  let table = s3_table(state);
  let id = table.clients.len() as u32;
  table.clients.push(S3Client {
    endpoint,
    bucket,
    region,
    access_key,
    secret_key,
  });
  Ok(id)
}

#[op2]
#[serde]
pub fn op_s3_get(state: &mut OpState, id: u32, #[string] key: String) -> Result<serde_json::Value, JsErrorBox> {
  let table = s3_table(state);
  let client = table
    .clients
    .get(id as usize)
    .ok_or_else(|| JsErrorBox::generic("Invalid S3 client ID"))?;
  let (status, body) = client.http("GET", &key, &[])?;
  if status >= 400 {
    return Err(JsErrorBox::generic(format!("S3 GET {key}: HTTP {status}")));
  }
  Ok(serde_json::json!({ "status": status, "body": body }))
}

#[op2]
#[serde]
pub fn op_s3_put(
  state: &mut OpState,
  id: u32,
  #[string] key: String,
  #[buffer] data: &[u8],
) -> Result<serde_json::Value, JsErrorBox> {
  let table = s3_table(state);
  let client = table
    .clients
    .get(id as usize)
    .ok_or_else(|| JsErrorBox::generic("Invalid S3 client ID"))?;
  let (status, body) = client.http("PUT", &key, data)?;
  if status >= 400 {
    return Err(JsErrorBox::generic(format!("S3 PUT {key}: HTTP {status} {body}")));
  }
  Ok(serde_json::json!({ "status": status }))
}

#[op2]
#[serde]
pub fn op_s3_delete(state: &mut OpState, id: u32, #[string] key: String) -> Result<serde_json::Value, JsErrorBox> {
  let table = s3_table(state);
  let client = table
    .clients
    .get(id as usize)
    .ok_or_else(|| JsErrorBox::generic("Invalid S3 client ID"))?;
  let (status, _) = client.http("DELETE", &key, &[])?;
  Ok(serde_json::json!({ "status": status }))
}

#[op2]
#[string]
pub fn op_s3_presign(
  state: &mut OpState,
  id: u32,
  #[string] key: String,
  expires_secs: u32,
) -> Result<String, JsErrorBox> {
  let table = s3_table(state);
  let client = table
    .clients
    .get(id as usize)
    .ok_or_else(|| JsErrorBox::generic("Invalid S3 client ID"))?;
  let (date, datetime) = utc_now();
  let path = format!("/{}/{}", client.bucket, key.trim_start_matches('/'));
  let scope = format!("{date}/{}/s3/aws4_request", client.region);
  let query = format!(
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential={}/{scope}&X-Amz-Date={datetime}&X-Amz-Expires={expires_secs}&X-Amz-SignedHeaders=host",
    urlenc(&client.access_key)
  );
  let host = client
    .endpoint
    .replace("https://", "")
    .replace("http://", "")
    .trim_end_matches('/')
    .to_string();
  let canonical = format!("GET\n{path}\n{query}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD");
  let sts = format!(
    "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
    sha256_hex(canonical.as_bytes())
  );
  let sig_key = signing_key(&client.secret_key, &date, &client.region, "s3");
  let sig = hex_encode(&hmac_sha256(&sig_key, sts.as_bytes()));
  Ok(format!("{}{path}?{query}&X-Amz-Signature={sig}", client.endpoint))
}

fn urlenc(s: &str) -> String {
  let mut result = String::new();
  for b in s.bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
        result.push(b as char);
      }
      _ => {
        result.push_str(&format!("%{b:02X}"));
      }
    }
  }
  result
}
