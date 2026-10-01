// V8 Inspector server: --inspect / --inspect-brk support.
// Listens on a TCP port (default 9229), serves Chrome DevTools Protocol
// over WebSocket, proxying CDP messages to/from deno_core's
// JsRuntimeInspector.
use deno_core::InspectorMsg;
use deno_core::InspectorMsgKind;
use deno_core::InspectorSessionChannels;
use deno_core::InspectorSessionKind;
use deno_core::InspectorSessionProxy;
use deno_core::futures::channel::mpsc as futures_mpsc;
use futures_util::{SinkExt, StreamExt};

/// Start the inspector server. Returns (bound_port, join_handle).
pub fn start(
  host: &str,
  port: u16,
  wait_for_debugger: bool,
  session_tx: futures_mpsc::UnboundedSender<InspectorSessionProxy>,
) -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
  let listener = std::net::TcpListener::bind((host, port))?;
  listener.set_nonblocking(true)?;
  let bound_port = listener.local_addr()?.port();
  let uuid = uuid_v4();

  let host_display = if host == "0.0.0.0" || host == "::" {
    "127.0.0.1"
  } else {
    host
  };
  eprintln!("Debugger listening on ws://{host_display}:{bound_port}/{uuid}");
  eprintln!("For help, see: https://nodejs.org/en/docs/inspector");
  if wait_for_debugger {
    eprintln!("Waiting for debugger to connect...");
  }

  let host_json = host_display.to_string();
  let handle = tokio::spawn(async move {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
      return;
    };
    loop {
      let Ok((stream, _)) = listener.accept().await else {
        break;
      };
      let session_tx = session_tx.clone();
      let uuid = uuid.clone();
      let host_json = host_json.clone();
      tokio::spawn(async move {
        handle_connection(stream, session_tx, &uuid, &host_json, bound_port).await;
      });
    }
  });
  Ok((bound_port, handle))
}

async fn handle_connection(
  stream: tokio::net::TcpStream,
  session_tx: futures_mpsc::UnboundedSender<InspectorSessionProxy>,
  uuid: &str,
  host: &str,
  port: u16,
) {
  // Peek to distinguish plain HTTP (/json/list) from WebSocket upgrade.
  let mut peek = [0u8; 512];
  let n = match stream.peek(&mut peek).await {
    Ok(n) => n,
    Err(_) => return,
  };
  let head = String::from_utf8_lossy(&peek[..n]);

  // If the request is NOT a WebSocket upgrade, handle as HTTP.
  if !head.contains("Upgrade: websocket") && !head.contains("upgrade: websocket") {
    let path = head.split_whitespace().nth(1).unwrap_or("/");
    let body = if path == "/json/list" || path == "/json" {
      serde_json::json!([{
        "description": "malia instance",
        "devtoolsFrontendUrl": format!("devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws={host}:{port}/{uuid}"),
        "id": uuid,
        "title": "malia",
        "type": "node",
        "url": "file://",
        "webSocketDebuggerUrl": format!("ws://{host}:{port}/{uuid}"),
      }]).to_string()
    } else if path == "/json/version" {
      serde_json::json!({
        "Browser": "malia/0.1.0",
        "Protocol-Version": "1.3",
        "V8-Version": "15.0.4",
      })
      .to_string()
    } else {
      "Not Found".to_string()
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = stream;
    let mut buf = vec![0u8; 4096];
    let _ = stream.read(&mut buf).await; // consume the request
    let resp = format!(
      "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
      body.len(),
      body
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    return;
  }

  // WebSocket upgrade for CDP.
  let ws = match tokio_tungstenite::accept_async(stream).await {
    Ok(ws) => ws,
    Err(_) => return,
  };
  let (mut ws_tx, mut ws_rx) = ws.split();

  // Create channel pair for the inspector session.
  // session_to_client: V8 sends InspectorMsg, we read and forward to WS
  // client_to_session: we send String commands, V8 reads them
  let (s2c_tx, mut s2c_rx) = futures_mpsc::unbounded::<InspectorMsg>();
  let (c2s_tx, c2s_rx) = futures_mpsc::unbounded::<String>();

  let proxy = InspectorSessionProxy {
    channels: InspectorSessionChannels::Regular { tx: s2c_tx, rx: c2s_rx },
    kind: InspectorSessionKind::NonBlocking {
      wait_for_disconnect: false,
    },
  };

  if session_tx.unbounded_send(proxy).is_err() {
    return;
  }

  // Bridge loop: WS <-> V8 inspector
  loop {
    tokio::select! {
      biased;
      // V8 -> WebSocket
      msg = s2c_rx.next() => {
        match msg {
          Some(inspector_msg) => {
            let text = match inspector_msg.kind {
              InspectorMsgKind::Notification => {
                inspector_msg.content.to_string()
              }
              _ => inspector_msg.content.to_string(),
            };
            if ws_tx.send(tokio_tungstenite::tungstenite::Message::Text(text.into())).await.is_err() {
              break;
            }
          }
          None => break,
        }
      }
      // WebSocket -> V8
      msg = ws_rx.next() => {
        match msg {
          Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
            if c2s_tx.unbounded_send(text.to_string()).is_err() {
              break;
            }
          }
          Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => break,
          _ => {}
        }
      }
    }
  }
}

fn uuid_v4() -> String {
  let mut b = [0u8; 16];
  getrandom::fill(&mut b).ok();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  format!(
    "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
    b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
  )
}
