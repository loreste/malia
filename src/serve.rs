// HTTP server machinery (hyper 1.x, HTTP/1.1) backing jse.serve and
// node:http. One tokio task per connection drives hyper; each incoming
// request is collected (headers + whole body) and forwarded over an mpsc
// queue to the isolate's event loop, where an async op hands it to JS. The
// JS handler's response travels back through a oneshot; streaming bodies
// are piped chunk-by-chunk through a second channel.
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Full;
use http_body_util::StreamBody;
use http_body_util::combinators::BoxBody;
use hyper::Request;
use hyper::Response;
use hyper::body::Frame;
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use rustls_pki_types::CertificateDer;
use rustls_pki_types::PrivateKeyDer;
use rustls_pki_types::pem::PemObject;
use tokio::sync::Mutex as TokioMutex;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use futures_util::FutureExt;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

#[derive(serde::Serialize)]
pub struct ServeRequest {
  pub id: u32,
  pub method: String,
  pub url: String,
  pub headers: Vec<(String, String)>,
  #[serde(with = "serde_bytes")]
  pub body: Vec<u8>,
  pub is_websocket: bool,
}

pub enum ServeBody {
  Full(Vec<u8>),
  /// Chunks from JS; the stream ends when the sender is dropped.
  Stream(mpsc::UnboundedReceiver<Vec<u8>>),
}

pub struct ServeResponse {
  pub status: u16,
  pub headers: Vec<(String, String)>,
  pub body: ServeBody,
}

type PendingMap = Arc<StdMutex<HashMap<u32, oneshot::Sender<ServeResponse>>>>;

/// WebSocket upgrades waiting for JS acceptance (req_id -> OnUpgrade + key).
pub type UpgradeMap =
  Arc<StdMutex<HashMap<u32, (hyper::upgrade::OnUpgrade, String)>>>;

/// One bound listener: the request queue the JS side drains, the pending
/// response map, and task handles (aborted on close). Connection tasks are
/// tracked because idle keep-alive connections hold request-queue senders;
/// without aborting them the JS pull loop would never observe end-of-queue.
pub struct Listener {
  pub req_rx: Arc<TokioMutex<mpsc::UnboundedReceiver<ServeRequest>>>,
  pub pending: PendingMap,
  pub upgrades: UpgradeMap,
  pub accept_task: tokio::task::JoinHandle<Result<(), std::io::Error>>,
  pub conn_tasks: Arc<StdMutex<Vec<tokio::task::JoinHandle<()>>>>,
}

/// Pack a batch of requests into one binary blob (no serde):
/// u32 count, then per request: u32 id, u16 method_len + method,
/// u16 url_len + url, u32 headers_len + headers ("name: value" joined by
/// CRLF, both forbidden inside values), u32 body_len + body.
pub fn pack_requests(requests: &[ServeRequest]) -> Vec<u8> {
  let mut out = Vec::with_capacity(192 * requests.len() + 4);
  out.extend_from_slice(&(requests.len() as u32).to_le_bytes());
  for req in requests {
    out.extend_from_slice(&req.id.to_le_bytes());
    out.extend_from_slice(&(req.method.len() as u16).to_le_bytes());
    out.extend_from_slice(req.method.as_bytes());
    out.extend_from_slice(&(req.url.len() as u16).to_le_bytes());
    out.extend_from_slice(req.url.as_bytes());
    let mut headers_len = 0usize;
    for (name, value) in &req.headers {
      headers_len += name.len() + 2 + value.len() + 2;
    }
    let headers_len = headers_len.saturating_sub(2);
    out.extend_from_slice(&(headers_len as u32).to_le_bytes());
    let mut first = true;
    for (name, value) in &req.headers {
      if !first {
        out.extend_from_slice(b"\r\n");
      }
      first = false;
      out.extend_from_slice(name.as_bytes());
      out.extend_from_slice(b": ");
      out.extend_from_slice(value.as_bytes());
    }
    out.extend_from_slice(&(req.body.len() as u32).to_le_bytes());
    out.extend_from_slice(&req.body);
  }
  out
}

/// Split a CRLF-joined header block back into pairs.
pub fn split_headers(blob: &str) -> Vec<(String, String)> {
  if blob.is_empty() {
    return Vec::new();
  }
  blob
    .split("\r\n")
    .filter_map(|line| {
      line
        .split_once(": ")
        .map(|(name, value)| (name.to_string(), value.to_string()))
    })
    .collect()
}

fn full_body(bytes: Vec<u8>) -> BoxBody<Bytes, hyper::Error> {
  Full::new(Bytes::from(bytes))
    .map_err(|e| match e {})
    .boxed()
}

fn error_response(status: u16, message: &'static str) -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .status(status)
    .body(full_body(message.as_bytes().to_vec()))
    .unwrap()
}

async fn handle_request(
  mut req: Request<Incoming>,
  id: u32,
  req_tx: mpsc::UnboundedSender<ServeRequest>,
  pending: PendingMap,
  upgrades: UpgradeMap,
  remote: &str,
) -> Result<Response<BoxBody<Bytes, hyper::Error>>, hyper::Error> {
  let start = std::time::Instant::now();
  // WebSocket upgrade? Capture the OnUpgrade handle and the client key
  // before the request is disassembled; JS accepts via op_ws_upgrade.
  let ws_key = req
    .headers()
    .get("upgrade")
    .and_then(|v| v.to_str().ok())
    .filter(|v| v.eq_ignore_ascii_case("websocket"))
    .and_then(|_| req.headers().get("sec-websocket-key"))
    .and_then(|v| v.to_str().ok())
    .map(str::to_string);
  let is_websocket = ws_key.is_some();
  if let Some(key) = ws_key {
    let on_upgrade = hyper::upgrade::on(&mut req);
    upgrades.lock().unwrap().insert(id, (on_upgrade, key));
  }
  let (parts, body) = req.into_parts();
  let method = parts.method.to_string();
  let url = parts.uri.to_string();
  let body_bytes = body.collect().await?.to_bytes().to_vec();
  let headers = parts
    .headers
    .iter()
    .map(|(name, value)| {
      (
        name.as_str().to_string(),
        value.to_str().unwrap_or("").to_string(),
      )
    })
    .collect();
  let (tx, rx) = oneshot::channel();
  pending.lock().unwrap().insert(id, tx);
  let served = ServeRequest {
    id,
    method: method.clone(),
    url: url.clone(),
    headers,
    body: body_bytes,
    is_websocket,
  };
  if req_tx.send(served).is_err() {
    let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
    crate::logger::log_http(&method, &url, 500, duration_ms, remote, 24);
    return Ok(error_response(500, "server is shutting down"));
  }
  let (status, body_len, res) = match rx.await {
    Ok(resp) => {
      let status = resp.status;
      let body_len = match &resp.body {
        ServeBody::Full(b) => b.len(),
        ServeBody::Stream(_) => 0,
      };
      (status, body_len, Ok(build_response(resp)))
    }
    Err(_) => {
      crate::logger::log(
        crate::logger::LogLevel::Error,
        "http",
        &format!("Request {id} ({method} {url}) failed: handler went away or threw unhandled error"),
      );
      (500, 24, Ok(error_response(500, "Internal Server Error\n")))
    }
  };
  let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
  crate::logger::log_http(&method, &url, status, duration_ms, remote, body_len);
  res
}

fn build_response(resp: ServeResponse) -> Response<BoxBody<Bytes, hyper::Error>> {
  let mut builder = Response::builder().status(resp.status);
  for (name, value) in resp.headers {
    builder = builder.header(name, value);
  }
  let body = match resp.body {
    ServeBody::Full(bytes) => full_body(bytes),
    ServeBody::Stream(rx) => {
      let stream = UnboundedReceiverStream::new(rx)
        .map(|chunk| Ok::<_, hyper::Error>(Frame::data(Bytes::from(chunk))));
      StreamBody::new(stream).boxed()
    }
  };
  builder.body(body).unwrap()
}

/// Dedicated multi-thread runtime for all hyper accept/connection work.
/// Parse/write of every request happens on these threads, in parallel;
/// only the request/response handoff crosses to the isolate's event loop
/// via channels. This keeps hyper off the (single) JS thread.
fn serve_runtime() -> &'static tokio::runtime::Runtime {
  static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
  RT.get_or_init(|| {
    tokio::runtime::Builder::new_multi_thread()
      .enable_all()
      .thread_name("jse-serve")
      .build()
      .expect("serve runtime")
  })
}

/// Build a rustls server config from PEM strings.
pub fn tls_config(cert_pem: &str, key_pem: &str) -> Result<Arc<rustls::ServerConfig>, String> {
  let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| format!("invalid certificate PEM: {e}"))?;
  if certs.is_empty() {
    return Err("no certificates found in PEM".to_string());
  }
  let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
    .map_err(|e| format!("invalid private key PEM: {e}"))?;
  // Both aws-lc-rs and ring are in the tree (via reqwest), so rustls
  // cannot pick a process-level provider automatically: be explicit.
  let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
  let mut config = rustls::ServerConfig::builder_with_provider(provider)
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("invalid TLS configuration: {e}"))?
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .map_err(|e| format!("invalid TLS configuration: {e}"))?;
  config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
  Ok(Arc::new(config))
}

/// Spawn the accept loop for an already-bound std listener on the serve
/// runtime (the tokio registration must happen there, not on the isolate's
/// runtime).
pub fn start_listener(
  std_listener: std::net::TcpListener,
  tls: Option<Arc<rustls::ServerConfig>>,
) -> Listener {
  let (req_tx, req_rx) = mpsc::unbounded_channel::<ServeRequest>();
  let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
  let upgrades: UpgradeMap = Arc::new(StdMutex::new(HashMap::new()));
  let conn_tasks: Arc<StdMutex<Vec<tokio::task::JoinHandle<()>>>> =
    Arc::new(StdMutex::new(Vec::new()));
  let accept_task = serve_runtime().spawn({
    let pending = pending.clone();
    let upgrades = upgrades.clone();
    let conn_tasks = conn_tasks.clone();
    async move {
      let tls_acceptor = tls.map(tokio_rustls::TlsAcceptor::from);
      let listener = tokio::net::TcpListener::from_std(std_listener)?;
      // Request ids are unique per request, not per connection (keep-alive
      // connections serve many requests).
      let next_id = Arc::new(AtomicU32::new(1));
      #[allow(unused_variables)]
      let upgrades = upgrades;
      loop {
        let (stream, peer) = match listener.accept().await {
          Ok(accepted) => accepted,
          Err(err) => {
            crate::logger::log(
              crate::logger::LogLevel::Error,
              "http",
              &format!("Server accept error: {err}"),
            );
            break;
          }
        };
        let remote_str = peer.to_string();
        let req_tx = req_tx.clone();
        let pending = pending.clone();
        let next_id = next_id.clone();
        let upgrades = upgrades.clone();
        let tls_acceptor = tls_acceptor.clone();
        let task = tokio::spawn(async move {
          let remote_for_svc = remote_str.clone();
          let service = hyper::service::service_fn(move |req: Request<Incoming>| {
            let req_tx = req_tx.clone();
            let pending = pending.clone();
            let upgrades = upgrades.clone();
            let id = next_id.fetch_add(1, Ordering::SeqCst);
            let remote = remote_for_svc.clone();
            async move { handle_request(req, id, req_tx, pending, upgrades, &remote).await }
          });
          let remote_for_err = remote_str.clone();
          let conn_fut = async move {
            if let Some(acceptor) = tls_acceptor {
              let tls_stream = match acceptor.accept(stream).await {
                Ok(stream) => stream,
                Err(err) => {
                  crate::logger::log(
                    crate::logger::LogLevel::Warn,
                    "http",
                    &format!("TLS handshake failed for {remote_for_err}: {err}"),
                  );
                  return;
                }
              };
              let is_h2 = tls_stream.get_ref().1.alpn_protocol() == Some(b"h2");
              if is_h2 {
                let _ = hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
                  .serve_connection(TokioIo::new(tls_stream), service)
                  .await;
              } else {
                let _ = hyper::server::conn::http1::Builder::new()
                  .keep_alive(true)
                  .pipeline_flush(true)
                  .serve_connection(TokioIo::new(tls_stream), service)
                  .with_upgrades()
                  .await;
              }
            } else {
              let mut preface = [0u8; 24];
              let is_h2 = stream
                .peek(&mut preface)
                .await
                .map(|n| n == 24 && &preface == b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
                .unwrap_or(false);
              if is_h2 {
                let _ = hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
                  .serve_connection(TokioIo::new(stream), service)
                  .await;
              } else {
                let _ = hyper::server::conn::http1::Builder::new()
                  .keep_alive(true)
                  // Buffer response writes and flush once per pipeline step
                  // instead of per message.
                  .pipeline_flush(true)
                  .serve_connection(TokioIo::new(stream), service)
                  .with_upgrades()
                  .await;
              }
            }
          };

          // Panic isolation: catch unwinds in connection task
          let wrapped = std::panic::AssertUnwindSafe(conn_fut);
          if wrapped.catch_unwind().await.is_err() {
            crate::logger::log(
              crate::logger::LogLevel::Error,
              "http",
              &format!("Connection handler for {remote_str} panicked; isolated safely"),
            );
          }
        });
        let mut tasks = conn_tasks.lock().unwrap();
        tasks.retain(|t| !t.is_finished());
        tasks.push(task);
      }
      Ok::<(), std::io::Error>(())
    }
  });
  Listener {
    req_rx: Arc::new(TokioMutex::new(req_rx)),
    pending,
    upgrades,
    accept_task,
    conn_tasks,
  }
}
