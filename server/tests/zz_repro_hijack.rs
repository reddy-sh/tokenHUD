use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Arc;
use tokenhud_server::{board::App, router, store::Store};

const KEY: &str = "test-board-key-not-a-real-one";

async fn start(name: &str) -> (u16, Arc<App>) {
    let dir = std::env::temp_dir().join(format!("tokenhud-repro-{}-{}", name, std::process::id()));
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
    (port, app)
}

fn raw(port: u16, request: &[u8]) -> Vec<u8> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
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

fn split(resp: &[u8]) -> (u16, Value) {
    let at = resp.windows(4).position(|w| w == b"\r\n\r\n").expect("head");
    let head = String::from_utf8_lossy(&resp[..at]).to_string();
    let code = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = serde_json::from_slice(&resp[at + 4..]).unwrap_or(Value::Null);
    (code, body)
}

fn call(port: u16, method: &str, path: &str, key: Option<&str>, body: Option<&Value>) -> (u16, Value) {
    let payload = body.map(|b| serde_json::to_vec(b).unwrap()).unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n");
    if let Some(k) = key {
        req.push_str(&format!("X-TokenHUD-Key: {k}\r\n"));
    }
    if body.is_some() {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", payload.len()));
    }
    req.push_str("\r\n");
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&payload);
    split(&raw(port, &bytes))
}

fn secret_of(id: &str) -> String { format!("poll-secret-for-{id}") }

fn enroll(port: u16, install_id: &str, host: &str) -> String {
    let (_, minted) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token = minted["token"].as_str().unwrap().to_string();
    let (c, claimed) = call(port, "POST", "/api/v1/enroll", None, Some(&json!({
        "token": token, "secret": secret_of(install_id), "installId": install_id,
        "host": host, "platform": "testos", "agentVersion": "0.2.0-test",
        "manifestDigest": "abc", "assistants": []
    })));
    assert_eq!(c, 200, "claim {claimed}");
    let (c, _) = call(port, "POST", "/api/v1/machines/decide", Some(KEY),
        Some(&json!({"installId": install_id, "action": "approve"})));
    assert_eq!(c, 200);
    let (c, state) = call(port, "GET",
        &format!("/api/v1/enroll/await?token={token}&secret={}", secret_of(install_id)), None, None);
    assert_eq!(c, 200, "await {state}");
    state["key"].as_str().expect("key").to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hijack() {
    let (port, _app) = start("hijack").await;
    let key_v = enroll(port, "install-victim1", "victim-box");
    let key_a = enroll(port, "install-attack1", "attacker-box");

    // Victim reports twice.
    for t in ["2026-08-25T10:00:00Z", "2026-08-25T10:01:00Z"] {
        let (c, b) = call(port, "POST", "/api/v1/ingest", Some(&key_v), Some(&json!({
            "host": "ignored", "machineId": "install-victim1", "collectedAt": t,
            "metrics": {"processes": []}
        })));
        println!("victim ingest -> {c} {b}");
    }

    // Unauthenticated overview leaks machine_id?
    let (c, pub_ov) = call(port, "GET", "/api/v1/overview", None, None);
    println!("PUBLIC overview {c}: hosts={}", pub_ov["hosts"]);
    assert!(pub_ov.get("machines").is_none());

    // Attacker ingest claiming victim's machineId.
    let (c, b) = call(port, "POST", "/api/v1/ingest", Some(&key_a), Some(&json!({
        "host": "whatever", "machineId": "install-victim1", "collectedAt": "2026-08-25T10:02:00Z",
        "metrics": {"processes": []}
    })));
    println!("ATTACK ingest -> {c} {b}");

    let (_, ov) = call(port, "GET", "/api/v1/overview", Some(KEY), None);
    println!("AFTER hosts = {}", ov["hosts"]);
    let (_, h1) = call(port, "GET", "/api/v1/history?host=victim-box", Some(KEY), None);
    let (_, h2) = call(port, "GET", "/api/v1/history?host=attacker-box", Some(KEY), None);
    println!("history victim-box = {} rows", h1["snapshots"].as_array().map(|a| a.len()).unwrap_or(0));
    println!("history attacker-box = {} rows", h2["snapshots"].as_array().map(|a| a.len()).unwrap_or(0));

    // Now the victim reports again -> ping-pong back?
    let (c, b) = call(port, "POST", "/api/v1/ingest", Some(&key_v), Some(&json!({
        "host": "ignored", "machineId": "install-victim1", "collectedAt": "2026-08-25T10:03:00Z",
        "metrics": {"processes": []}
    })));
    println!("victim re-ingest -> {c} {b}");
    let (_, ov) = call(port, "GET", "/api/v1/overview", Some(KEY), None);
    println!("AFTER2 hosts = {}", ov["hosts"]);
    let (_, h1) = call(port, "GET", "/api/v1/history?host=victim-box", Some(KEY), None);
    println!("history victim-box now = {} rows", h1["snapshots"].as_array().map(|a| a.len()).unwrap_or(0));
}
