//! The server, end to end, on a real socket.
//!
//! These came from a Python suite that no longer exists, where they ran
//! against the Python server this one replaced. Same assertions, same refusal
//! to mock: the router is the real one,
//! the port is a real ephemeral port, and the store is a real SQLite file.
//!
//! The last one is the seam nothing else covers — a reading from the real
//! agent binary going in the front door.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Arc;
use tokenhud_server::{board::App, router, store::Store};

const KEY: &str = "test-key-not-a-real-one";

struct Harness {
    port: u16,
    _dir: std::path::PathBuf,
    app: Arc<App>,
}

async fn start(name: &str) -> Harness {
    let dir = std::env::temp_dir().join(format!("tokenhud-srv-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("t.db"), 30).unwrap();
    let app = App::new(store, KEY.into(), false, 8, true, String::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let r = router(app.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, r).await;
    });
    Harness {
        port,
        _dir: dir,
        app,
    }
}

/// A raw client, because two of these checks are about the bytes on the wire
/// and a library that helpfully decodes them would hide the thing being tested.
///
/// Blocking, which is why every test here asks for a multi-threaded runtime: on
/// the default current-thread runtime this call parks the only thread there is
/// and the server task it is waiting for never gets to run.
fn raw(port: u16, request: &[u8]) -> Vec<u8> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    s.write_all(request).unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    out
}

fn post(port: u16, body: &[u8], key: &str, gzip: bool) -> (u16, Vec<u8>) {
    let mut req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {key}\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if gzip {
        req.push_str("Content-Encoding: gzip\r\n");
    }
    req.push_str("\r\n");
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(body);
    let resp = raw(port, &bytes);
    split(&resp)
}

fn get(port: u16, path: &str, accept_gzip: bool) -> (u16, String, Vec<u8>) {
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n");
    if accept_gzip {
        req.push_str("Accept-Encoding: gzip\r\n");
    }
    req.push_str("\r\n");
    let resp = raw(port, req.as_bytes());
    let (code, body) = split(&resp);
    let head = String::from_utf8_lossy(
        &resp[..resp.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(0)],
    )
    .to_lowercase();
    (code, head, body)
}

fn split(resp: &[u8]) -> (u16, Vec<u8>) {
    let at = resp
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a response has a head");
    let head = String::from_utf8_lossy(&resp[..at]).to_string();
    let code = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let mut body = resp[at + 4..].to_vec();
    if head.to_lowercase().contains("content-encoding: gzip") {
        let mut out = Vec::new();
        if flate2::read::GzDecoder::new(&body[..])
            .read_to_end(&mut out)
            .is_ok()
        {
            body = out;
        }
    }
    (code, body)
}

fn gz(v: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    e.write_all(v).unwrap();
    e.finish().unwrap()
}

fn snap(host: &str, at: &str, pids: &[i64], pad: usize) -> Value {
    json!({
        "host": host, "agentVersion": "test", "collectedAt": at,
        "metrics": {
            "processes": pids.iter().map(|p| json!({
                "pid": p, "kind": "test", "elapsed": "01:00:00", "cmd": "x"})).collect::<Vec<_>>(),
            "filler": vec!["compressible ".repeat(8); pad],
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn key_gzip_ingest_and_endings() {
    let h = start("e2e").await;
    let now = chrono::Utc::now();
    let at = |s: i64| tokenhud_server::store::iso(now + chrono::Duration::seconds(s));

    let body = serde_json::to_vec(&snap("h", &at(0), &[1], 40)).unwrap();
    let (code, _) = post(h.port, &body, "wrong-key", false);
    assert_eq!(code, 401, "a wrong key should be 401");

    let b1 = serde_json::to_vec(&snap("h", &at(0), &[1, 2], 40)).unwrap();
    let b2 = serde_json::to_vec(&snap("h", &at(30), &[1], 40)).unwrap();
    assert_eq!(post(h.port, &b1, KEY, false).0, 202);
    assert_eq!(post(h.port, &b2, KEY, false).0, 202);

    // Small responses must NOT be compressed; large ones must be.
    let (_, head, _) = get(h.port, "/healthz", true);
    assert!(
        !head.contains("content-encoding: gzip"),
        "a two-byte response was gzipped, which costs more than it saves"
    );

    let (code, head, body) = get(h.port, "/api/v1/overview", true);
    assert_eq!(code, 200);
    assert!(
        head.contains("content-encoding: gzip"),
        "a large overview was not compressed"
    );
    assert!(
        head.contains("vary: accept-encoding"),
        "compressed responses must Vary"
    );
    let d: Value = serde_json::from_slice(&body).unwrap();

    // …and a client that does not ask for gzip must not get it.
    let (_, head, _) = get(h.port, "/api/v1/overview", false);
    assert!(
        !head.contains("content-encoding: gzip"),
        "gzip was sent unasked"
    );

    assert_eq!(
        d["hosts"][0]["status"], "up",
        "a fresh reading should read as up"
    );
    let endings = d["endings"].as_array().unwrap();
    assert_eq!(
        endings.len(),
        1,
        "the server should have noticed pid 2 ending"
    );
    assert_eq!(endings[0]["pid"], 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ingest_accepts_gzip_and_plain() {
    // The agent gzips its upload; anything older or hand-rolled does not.
    let h = start("encodings").await;
    let now = tokenhud_server::store::iso(chrono::Utc::now());
    let raw_body = serde_json::to_vec(&snap("plain-host", &now, &[1], 40)).unwrap();
    assert_eq!(post(h.port, &raw_body, KEY, false).0, 202, "plain rejected");

    let raw_body2 = serde_json::to_vec(&snap("gzip-host", &now, &[1], 40)).unwrap();
    let packed = gz(&raw_body2);
    assert!(
        packed.len() < raw_body2.len(),
        "the fixture should compress"
    );
    assert_eq!(post(h.port, &packed, KEY, true).0, 202, "gzip rejected");

    let hosts: Vec<String> = h
        .app
        .store
        .hosts()
        .iter()
        .map(|r| r["host"].as_str().unwrap().into())
        .collect();
    assert!(hosts.contains(&"plain-host".to_string()) && hosts.contains(&"gzip-host".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_event_stream_pushes() {
    let h = start("stream").await;
    let now = tokenhud_server::store::iso(chrono::Utc::now());
    assert_eq!(
        post(
            h.port,
            &serde_json::to_vec(&snap("h", &now, &[1], 40)).unwrap(),
            KEY,
            false
        )
        .0,
        202
    );

    let mut s = std::net::TcpStream::connect(("127.0.0.1", h.port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    s.write_all(b"GET /api/v1/stream HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();

    let mut buf = Vec::new();
    let mut tmp = [0u8; 65536];
    // The state on connect, so joining is a resync rather than a gap.
    while !buf.windows(2).any(|w| w == b"\n\n") {
        match s.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf).to_lowercase();
    assert!(
        text.contains("content-type: text/event-stream"),
        "not an event stream"
    );
    assert!(
        text.contains("transfer-encoding: chunked"),
        "a stream of unknown length must be chunked"
    );
    assert!(
        String::from_utf8_lossy(&buf).contains("event: reading\ndata: "),
        "the stream must open with the current state"
    );

    // …and a new reading is pushed, not waited for.
    let now2 = tokenhud_server::store::iso(chrono::Utc::now() + chrono::Duration::seconds(30));
    let before = buf.len();
    assert_eq!(
        post(
            h.port,
            &serde_json::to_vec(&snap("h", &now2, &[1], 40)).unwrap(),
            KEY,
            false
        )
        .0,
        202
    );
    let mut pushed = false;
    for _ in 0..40 {
        match s.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > before
                    && String::from_utf8_lossy(&buf[before..]).contains("event: reading")
                {
                    pushed = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        pushed,
        "an ingest must reach an open stream without waiting for a timer"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reading_from_the_real_agent_is_accepted() {
    // The two are separate programs. This is the only place they meet before a
    // user is watching one of them.
    let agent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("agent/target/release/tokenhud-agent");
    if !agent.is_file() {
        eprintln!("  skip · no agent binary built — ./scripts/build.sh");
        return;
    }
    let h = start("seam").await;
    let state = std::env::temp_dir().join(format!("tokenhud-seam-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&state);

    let out = std::process::Command::new(&agent)
        .arg("--dry-run")
        .env("TOKENHUD_STATE", &state)
        .env("TOKENHUD_SCAN_BUDGET_MB", "4")
        .output()
        .expect("the agent runs");
    let _ = std::fs::remove_dir_all(&state);
    assert!(
        out.status.success(),
        "the agent exited {:?}",
        out.status.code()
    );

    let snap: Value = serde_json::from_slice(&out.stdout).expect("the agent emits JSON");
    let host = snap["host"]
        .as_str()
        .expect("a reading carries a host")
        .to_string();
    let (code, _) = post(h.port, &out.stdout, KEY, false);
    assert_eq!(code, 202, "the server refused a real agent reading");

    let hosts: Vec<String> = h
        .app
        .store
        .hosts()
        .iter()
        .map(|r| r["host"].as_str().unwrap().into())
        .collect();
    assert!(hosts.contains(&host), "the reading did not land");
}
