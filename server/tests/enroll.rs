//! Enrollment, end to end: mint a link, claim it, approve it on the board,
//! collect the machine's own key exactly once, report with it, revoke it.
//!
//! Same refusal to mock as tests/server.rs: real router, real socket, real
//! SQLite file.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Arc;
use tokenhud_server::{board, board::App, router, store::Store};

const KEY: &str = "test-board-key-not-a-real-one";

async fn start(name: &str) -> (u16, Arc<App>) {
    let dir = std::env::temp_dir().join(format!("tokenhud-enr-{}-{}", name, std::process::id()));
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

fn split(resp: &[u8]) -> (u16, Value) {
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
    let body = serde_json::from_slice(&resp[at + 4..]).unwrap_or(Value::Null);
    (code, body)
}

fn call(
    port: u16,
    method: &str,
    path: &str,
    key: Option<&str>,
    body: Option<&Value>,
) -> (u16, Value) {
    let payload = body
        .map(|b| serde_json::to_vec(b).unwrap())
        .unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n");
    if let Some(k) = key {
        req.push_str(&format!("X-TokenHUD-Key: {k}\r\n"));
    }
    if body.is_some() {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    req.push_str("\r\n");
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&payload);
    split(&raw(port, &bytes))
}

fn secret_of(install_id: &str) -> String {
    format!("poll-secret-for-{install_id}")
}

fn claim(port: u16, token: &str, install_id: &str, host: &str) -> (u16, Value) {
    call(
        port,
        "POST",
        "/api/v1/enroll",
        None,
        Some(&json!({
            "token": token,
            "secret": secret_of(install_id),
            "installId": install_id,
            "host": host,
            "platform": "testos",
            "agentVersion": "0.2.0-test",
            "manifestDigest": "abcdef1234567890",
            "assistants": [{"id": "claude-code", "name": "Claude Code", "hasData": true}],
        })),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_whole_enrollment_lifecycle() {
    let (port, _app) = start("lifecycle").await;

    // Minting needs the board key.
    let (code, _) = call(port, "POST", "/api/v1/enroll/new", None, None);
    assert_eq!(code, 401, "minting a link without the key must be refused");
    let (code, minted) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    assert_eq!(code, 200);
    let token = minted["token"].as_str().unwrap().to_string();
    let pair = minted["code"].as_str().unwrap().to_string();
    assert_eq!(
        pair,
        board::pairing_code(&token),
        "code derives from the token"
    );

    // A wrong token learns nothing but "unknown".
    let (code, _) = claim(port, "not-a-real-token-aaaaaaaa", "install-1234", "mac-a");
    assert_eq!(code, 410);

    // Claiming puts the machine on the board as pending, with its facts.
    let (code, claimed) = claim(port, &token, "install-1234", "mac-a");
    assert_eq!(code, 200, "claim: {claimed}");
    assert_eq!(claimed["status"], "pending");
    assert_eq!(claimed["code"], pair);
    // The machines list is for key holders only: open reads never see the
    // pairing codes or the fleet inventory.
    let (_, public) = call(port, "GET", "/api/v1/overview", None, None);
    assert!(
        public.get("machines").is_none(),
        "open reads must not carry the machines list"
    );
    let (_, overview) = call(port, "GET", "/api/v1/overview", Some(KEY), None);
    let machines = overview["machines"].as_array().unwrap();
    assert_eq!(machines.len(), 1);
    assert_eq!(machines[0]["status"], "pending");
    assert_eq!(
        machines[0]["code"], pair,
        "pending card carries the pairing code"
    );
    assert_eq!(machines[0]["manifestDigest"], "abcdef1234567890");

    // Before approval, the poll says pending and delivers nothing.
    let (code, state) = call(
        port,
        "GET",
        &format!(
            "/api/v1/enroll/await?token={token}&secret={}",
            secret_of("install-1234")
        ),
        None,
        None,
    );
    assert_eq!(code, 200);
    assert_eq!(state["status"], "pending");
    assert!(state.get("key").is_none());

    // Deciding needs the board key too.
    let decide = json!({"installId": "install-1234", "action": "approve"});
    let (code, _) = call(port, "POST", "/api/v1/machines/decide", None, Some(&decide));
    assert_eq!(code, 401);
    let (code, _) = call(
        port,
        "POST",
        "/api/v1/machines/decide",
        Some(KEY),
        Some(&decide),
    );
    assert_eq!(code, 200);

    // Approval delivers the machine key exactly once.
    let (code, state) = call(
        port,
        "GET",
        &format!(
            "/api/v1/enroll/await?token={token}&secret={}",
            secret_of("install-1234")
        ),
        None,
        None,
    );
    assert_eq!(code, 200);
    assert_eq!(state["status"], "approved");
    let machine_key = state["key"]
        .as_str()
        .expect("the key arrives on approval")
        .to_string();
    let (code, again) = call(
        port,
        "GET",
        &format!(
            "/api/v1/enroll/await?token={token}&secret={}",
            secret_of("install-1234")
        ),
        None,
        None,
    );
    // The token died with the delivery — a replayed link gets nothing.
    assert_eq!(code, 404, "second poll must not deliver again: {again}");

    // The machine key ingests, and identity comes from the key, not the body.
    let snap = json!({
        "host": "some-imaginative-claim",
        "agentVersion": "0.2.0-test",
        "collectedAt": "2026-08-24T10:00:00+00:00",
        "metrics": {"processes": []},
    });
    let body = serde_json::to_vec(&snap).unwrap();
    let req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {machine_key}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&body);
    let (code, accepted) = split(&raw(port, &bytes));
    assert_eq!(code, 202, "machine key must ingest: {accepted}");
    assert_eq!(
        accepted["host"], "mac-a",
        "the row is the machine's enrolled label, not the payload's claim"
    );

    // Revocation closes the door for that machine alone.
    let revoke = json!({"installId": "install-1234", "action": "revoke"});
    let (code, _) = call(
        port,
        "POST",
        "/api/v1/machines/decide",
        Some(KEY),
        Some(&revoke),
    );
    assert_eq!(code, 200);
    let req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {machine_key}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&body);
    let (code, _) = split(&raw(port, &bytes));
    assert_eq!(code, 401, "a revoked machine's key must be refused");

    // The board key still works — legacy agents are untouched.
    let req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {KEY}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&body);
    let (code, _) = split(&raw(port, &bytes));
    assert_eq!(code, 202);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_is_one_machine_and_hostnames_disambiguate() {
    let (port, app) = start("claims").await;

    let (_, minted) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token = minted["token"].as_str().unwrap().to_string();

    // First machine claims; a second machine on the same link is refused.
    let (code, _) = claim(port, &token, "install-aaaa", "MacBook-Pro.local");
    assert_eq!(code, 200);
    let (code, why) = claim(port, &token, "install-bbbb", "MacBook-Pro.local");
    assert_eq!(code, 410, "a used link must refuse a second machine: {why}");
    // The same machine retrying is a refresh, not an error.
    let (code, _) = claim(port, &token, "install-aaaa", "MacBook-Pro.local");
    assert_eq!(code, 200);

    // A second machine with the SAME hostname on its own link stays a
    // separate row, with a label that says which is which.
    let (_, minted2) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token2 = minted2["token"].as_str().unwrap().to_string();
    let (code, _) = claim(port, &token2, "install-bbbb", "MacBook-Pro.local");
    assert_eq!(code, 200);
    let (_, overview) = call(port, "GET", "/api/v1/overview", Some(KEY), None);
    let labels: Vec<String> = overview["machines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["label"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(labels.len(), 2);
    assert!(labels.contains(&"MacBook-Pro.local".to_string()));
    assert!(
        labels.contains(&"MacBook-Pro.local · inst".to_string()),
        "the second identical hostname gets a suffix: {labels:?}"
    );

    // Denial is terminal for the attempt: the poll reports it and no key
    // ever exists for that machine.
    let (_, minted3) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token3 = minted3["token"].as_str().unwrap().to_string();
    let (code, _) = claim(port, &token3, "install-cccc", "third");
    assert_eq!(code, 200);
    let deny = json!({"installId": "install-cccc", "action": "deny"});
    let (code, _) = call(
        port,
        "POST",
        "/api/v1/machines/decide",
        Some(KEY),
        Some(&deny),
    );
    assert_eq!(code, 200);
    let (code, state) = call(
        port,
        "GET",
        &format!(
            "/api/v1/enroll/await?token={token3}&secret={}",
            secret_of("install-cccc")
        ),
        None,
        None,
    );
    assert_eq!(code, 200);
    assert_eq!(state["status"], "denied");
    assert!(state.get("key").is_none());

    // Expiry: a token past its window refuses a claim outright.
    let hash = board::sha256_hex("expired-token-value-aaaa");
    app.store.enroll_mint(&hash, "XXX-XXX").unwrap();
    {
        // Reach into the store the ugly way tests are allowed to: age it.
        let db = rusqlite::Connection::open(app.store.path.clone()).unwrap();
        db.execute(
            "UPDATE enroll_tokens SET expires_at='2000-01-01T00:00:00+00:00' WHERE token_hash=?",
            [&hash],
        )
        .unwrap();
    }
    let (code, why) = claim(port, "expired-token-value-aaaa", "install-dddd", "late");
    assert_eq!(code, 410, "{why}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_review_findings_stay_fixed() {
    let (port, app) = start("findings").await;

    // A leaked link cannot collect the key: delivery demands the claim's
    // secret, and a poller without it learns nothing.
    let (_, minted) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token = minted["token"].as_str().unwrap().to_string();
    let (code, _) = claim(port, &token, "install-eeee", "eve-target");
    assert_eq!(code, 200);
    let approve = json!({"installId": "install-eeee", "action": "approve"});
    let (_, _) = call(
        port,
        "POST",
        "/api/v1/machines/decide",
        Some(KEY),
        Some(&approve),
    );
    let (code, spoils) = call(
        port,
        "GET",
        &format!("/api/v1/enroll/await?token={token}&secret=eve-does-not-know-this"),
        None,
        None,
    );
    assert_eq!(
        code, 404,
        "a thief with only the link gets nothing: {spoils}"
    );
    // The rightful claimer still collects.
    let (code, state) = call(
        port,
        "GET",
        &format!(
            "/api/v1/enroll/await?token={token}&secret={}",
            secret_of("install-eeee")
        ),
        None,
        None,
    );
    assert_eq!(code, 200);
    let machine_key = state["key"].as_str().expect("claimer collects").to_string();

    // An approved machine cannot be dragged back to pending by a fresh claim —
    // its working key survives until a person revokes it.
    let (_, minted2) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token2 = minted2["token"].as_str().unwrap().to_string();
    let (code, why) = claim(port, &token2, "install-eeee", "eve-target");
    assert_eq!(code, 410, "claim against an enrolled machine: {why}");
    let snap = json!({
        "host": "x", "agentVersion": "t", "collectedAt": "2026-08-24T10:00:00+00:00",
        "metrics": {"processes": []},
    });
    let body = serde_json::to_vec(&snap).unwrap();
    let req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {machine_key}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&body);
    let (code, _) = split(&raw(port, &bytes));
    assert_eq!(code, 202, "the approved machine's key still works");

    // An enrolling machine can never take a legacy shared-key host's name:
    // the label check covers the hosts table too.
    let legacy = json!({
        "host": "shared-legacy-box", "agentVersion": "t",
        "collectedAt": "2026-08-24T10:00:00+00:00", "metrics": {"processes": []},
    });
    let body = serde_json::to_vec(&legacy).unwrap();
    let req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {KEY}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&body);
    let (code, _) = split(&raw(port, &bytes));
    assert_eq!(code, 202);
    let (_, minted3) = call(port, "POST", "/api/v1/enroll/new", Some(KEY), None);
    let token3 = minted3["token"].as_str().unwrap().to_string();
    let (code, _) = claim(port, &token3, "install-ffff", "shared-legacy-box");
    assert_eq!(code, 200);
    let (_, overview) = call(port, "GET", "/api/v1/overview", Some(KEY), None);
    let label = overview["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["installId"] == "install-ffff")
        .unwrap()["label"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(
        label, "shared-legacy-box",
        "an enrolled machine must not claim a legacy host's row"
    );
    assert!(label.starts_with("shared-legacy-box · "));

    // Denial burns the link: the denied machine cannot re-claim its way back
    // onto the pending list.
    let deny = json!({"installId": "install-ffff", "action": "deny"});
    let (code, _) = call(
        port,
        "POST",
        "/api/v1/machines/decide",
        Some(KEY),
        Some(&deny),
    );
    assert_eq!(code, 200);
    let (code, why) = claim(port, &token3, "install-ffff", "shared-legacy-box");
    assert_eq!(code, 410, "a denied machine's link must be dead: {why}");

    // A non-object body under a machine key is refused, not a panic.
    let body = b"[1,2,3]".to_vec();
    let req = format!(
        "POST /api/v1/ingest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-TokenHUD-Key: {machine_key}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(&body);
    let (code, _) = split(&raw(port, &bytes));
    assert_eq!(code, 400, "a JSON array is refused, never a panic");

    // Stream tokens: minted with the key, redeemable exactly once.
    let (code, _) = call(port, "POST", "/api/v1/stream-token", None, None);
    assert_eq!(code, 401);
    let (code, st) = call(port, "POST", "/api/v1/stream-token", Some(KEY), None);
    assert_eq!(code, 200);
    let t = st["token"].as_str().unwrap();
    assert!(app.take_stream_token(t), "a fresh token redeems");
    assert!(!app.take_stream_token(t), "and only once");
}
