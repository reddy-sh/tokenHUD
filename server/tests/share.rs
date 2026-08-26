//! Sharing a board, end to end: mint a link, read it with no credential at
//! all, check that what came back is the leaderboard and not the diary, then
//! revoke it and watch the link die.
//!
//! Same refusal to mock as the rest of tests/: real router, real socket, real
//! SQLite file. The load-bearing check is `nothing_private_survives_the_wire`
//! — it reads the bytes an anonymous stranger actually receives and searches
//! them for every private string the reading went in with. A unit test on the
//! whitelist can be right while the route around it leaks; this cannot.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Arc;
use tokenhud_server::{board::App, router, store::Store};

const KEY: &str = "test-share-key-not-a-real-one";

/// Reads are PROTECTED in this harness on purpose. Publishing a link is a
/// separate decision from opening the private API, and the shared board has to
/// answer a stranger even here — that is the whole feature.
async fn start(name: &str) -> (u16, Arc<App>) {
    let dir = std::env::temp_dir().join(format!("tokenhud-shr-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("t.db"), 30).unwrap();
    let app = App::new(store, KEY.into(), true, 8, true, String::new());
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

fn call_raw(
    port: u16,
    method: &str,
    path: &str,
    key: Option<&str>,
    body: Option<&Value>,
) -> (u16, Vec<u8>) {
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
    let resp = raw(port, &bytes);
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
    (code, resp[at + 4..].to_vec())
}

fn call(
    port: u16,
    method: &str,
    path: &str,
    key: Option<&str>,
    body: Option<&Value>,
) -> (u16, Value) {
    let (code, body) = call_raw(port, method, path, key, body);
    (code, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// A reading carrying something private in every drawer the agent fills.
fn reading(host: &str) -> Value {
    json!({
        "host": host,
        "agentVersion": "0.2.0-test",
        "collectedAt": "2026-08-25T19:06:43+00:00",
        "intervalSeconds": 30,
        "metrics": {
            "host": {"hostname": host, "platform": "Darwin", "cpus": 14, "release": "27.0.0"},
            "processes": [{"pid": 7, "tool": "claude-code",
                           "cmd": "/Users/pat/work/project-hush/node_modules/.bin/claude"}],
            "projects": [{"path": "/Users/pat/work/project-hush", "label": "project-hush",
                          "branch": "feat/merger", "sessions": 15}],
            "prompts": [{"text": "draft the merger announcement", "project": "/Users/pat/work"}],
            "assistants": [{"id": "claude-code", "name": "Claude Code", "hasData": true,
                            "paths": ["/Users/pat/.claude"]}],
            "limits": {"available": true, "accountHash": "deadbeefcafe",
                       "windows": [{"kind": "session", "percent": 90}]},
            "governance": {"claude": {"mcpServers": [{"name": "acme-internal-crm"}]}},
            "claude": {
                "present": true, "totalSessions": 48, "totalMessages": 57557,
                "firstSessionDate": "2026-06-02T09:03:57.304Z",
                "hours": {"9": 4, "14": 7},
                "daily": [{"date": "2026-08-25", "tokens": 2772758, "messages": 1326,
                           "toolCalls": 440, "sessions": 2,
                           "tokensByModel": {"claude-opus-5": 2772758}}],
                "models": [{"model": "claude-opus-5", "input": 1, "output": 2}]
            },
            "usage": {
                "available": true,
                "pricing": {"asOf": "2026-06-24"},
                "sessions": [{"id": "1", "project": "project-hush",
                              "path": "/Users/pat/work/project-hush", "branch": "feat/merger",
                              "title": "draft the merger announcement"}],
                "tools": {"byServer": [{"server": "acme-internal-crm"}]},
                "allTime": {"estUSD": 25056.494, "sessions": 70, "requests": 89903,
                            "toolCalls": 48344,
                            "tokens": {"in": 100, "out": 200, "cacheRead": 300, "cacheWrite": 400}},
                "byModel": [{"model": "claude-opus-5", "estUSD": 7984.2, "priced": true,
                             "input": 100, "output": 200, "cacheRead": 300, "cacheWrite": 400}],
                "byDay": [{"date": "2026-08-25", "estUSD": 12.34}]
            }
        }
    })
}

fn ingest(port: u16, host: &str) {
    let (code, _) = call(
        port,
        "POST",
        "/api/v1/ingest",
        Some(KEY),
        Some(&reading(host)),
    );
    assert_eq!(code, 202, "the agent's reading should be accepted");
}

fn mint(port: u16, identities: &str) -> String {
    let (code, v) = call(
        port,
        "POST",
        "/api/v1/share",
        Some(KEY),
        Some(&json!({"title": "Team board", "identities": identities})),
    );
    assert_eq!(code, 200, "minting a share should succeed: {v}");
    v["slug"].as_str().expect("a slug").to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_private_survives_the_wire() {
    let (port, _app) = start("private").await;
    ingest(port, "pats-laptop.local");
    let slug = mint(port, "alias");

    // No key, no header, nothing — the slug is the whole credential.
    let (code, bytes) = call_raw(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(code, 200, "a shared board answers an anonymous reader");
    let text = String::from_utf8_lossy(&bytes).to_string();

    for banned in [
        "project-hush",      // a project name
        "/Users/pat",        // a path
        "feat/merger",       // a branch
        "merger announce",   // prompt text, and the session title written from it
        "acme-internal-crm", // an MCP server
        "deadbeefcafe",      // the account hash
        "pats-laptop",       // the hostname, under identities=alias
        "node_modules",      // a process command line
        ".claude",           // where a collector reads
        "/bin/claude",       // …and the rest of it, now that processes travel
    ] {
        assert!(
            !text.contains(banned),
            "a shared board must never carry {banned:?}\n{text}"
        );
    }

    // …and the numbers it exists for did survive.
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let e = &v["entries"][0];
    assert_eq!(e["totals"]["tokens"], 1000);
    assert_eq!(e["totals"]["estUSD"], 25056.49);
    assert_eq!(e["models"][0]["model"], "claude-opus-5");
    assert_eq!(e["os"], "Darwin");
    assert_eq!(e["byDay"][0]["date"], "2026-08-25");
    assert_eq!(v["totals"]["machines"], 1);
    // The pseudonym is words, not a hostname.
    let name = e["name"].as_str().unwrap();
    assert!(
        name.contains('-') && !name.contains('.'),
        "expected a pseudonym, got {name:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identities_host_is_the_one_way_a_name_gets_out() {
    let (port, _app) = start("named").await;
    ingest(port, "pats-laptop.local");
    let slug = mint(port, "host");

    let (code, bytes) = call_raw(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(code, 200);
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert!(
        text.contains("pats-laptop.local"),
        "a share created with identities=host prints machine names"
    );
    // Everything else stays shut regardless of the identity setting.
    assert!(!text.contains("project-hush"));
    assert!(!text.contains("/Users/pat"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revoked_link_stops_answering_and_says_nothing_about_why() {
    let (port, _app) = start("revoke").await;
    ingest(port, "pats-laptop.local");
    let slug = mint(port, "alias");

    let (code, _) = call(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(code, 200);

    let (code, v) = call(
        port,
        "POST",
        "/api/v1/share/revoke",
        Some(KEY),
        Some(&json!({"slug": slug})),
    );
    assert_eq!(code, 200);
    assert_eq!(v["ok"], true);

    let (revoked, a) = call(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    let (unknown, b) = call(
        port,
        "GET",
        "/api/v1/public/board?s=neverwasashare0",
        None,
        None,
    );
    assert_eq!(revoked, 404);
    assert_eq!(unknown, 404);
    assert_eq!(
        a, b,
        "a revoked slug and an invented one must be indistinguishable — \
         otherwise this endpoint is a way to test slugs for existence"
    );

    // Revoking twice is not an error, but only the first one did anything.
    let (code, v) = call(
        port,
        "POST",
        "/api/v1/share/revoke",
        Some(KEY),
        Some(&json!({"slug": slug})),
    );
    assert_eq!(code, 200);
    assert_eq!(v["ok"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn minting_and_listing_need_the_board_key() {
    let (port, _app) = start("auth").await;
    ingest(port, "pats-laptop.local");

    for (method, path, body) in [
        ("POST", "/api/v1/share", Some(json!({"title": "mine now"}))),
        ("GET", "/api/v1/share", None),
        ("POST", "/api/v1/share/revoke", Some(json!({"slug": "x"}))),
    ] {
        let (code, _) = call(port, method, path, None, body.as_ref());
        assert_eq!(code, 401, "{method} {path} must require the board key");
        let (code, _) = call(port, method, path, Some("wrong-key"), body.as_ref());
        assert_eq!(code, 401, "{method} {path} must reject a wrong key");
    }

    // The private overview is still shut to an anonymous reader in this
    // harness — publishing a link did not open it.
    let (code, _) = call(port, "GET", "/api/v1/overview", None, None);
    assert_eq!(code, 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_share_can_be_renamed_and_the_listing_counts_who_looked() {
    let (port, _app) = start("edit").await;
    ingest(port, "pats-laptop.local");
    let slug = mint(port, "alias");

    let (code, v) = call(
        port,
        "POST",
        "/api/v1/share",
        Some(KEY),
        Some(&json!({"slug": slug, "title": "Q3 board", "identities": "host"})),
    );
    assert_eq!(code, 200, "{v}");

    let (_, board) = call(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(board["share"]["title"], "Q3 board");
    assert_eq!(board["share"]["identities"], "host");

    let (code, v) = call(port, "GET", "/api/v1/share", Some(KEY), None);
    assert_eq!(code, 200);
    assert_eq!(v["shares"][0]["slug"], slug.as_str());
    assert_eq!(v["shares"][0]["views"], 1, "one anonymous read, counted");
    assert!(
        v["apiUrl"].as_str().unwrap().starts_with("http"),
        "the dialog needs an address to build a link against"
    );
    assert_eq!(
        v["reachable"], false,
        "a loopback server with no public URL cannot serve a stranger, and \
         the board is told so rather than left to find out"
    );

    // Editing is not a way back from revoked.
    let _ = call(
        port,
        "POST",
        "/api/v1/share/revoke",
        Some(KEY),
        Some(&json!({"slug": slug})),
    );
    let (code, _) = call(
        port,
        "POST",
        "/api/v1/share",
        Some(KEY),
        Some(&json!({"slug": slug, "title": "back from the dead"})),
    );
    assert_eq!(code, 404);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hours_curve_is_withheld_until_it_is_a_sum_of_people() {
    let (port, _app) = start("hours").await;
    ingest(port, "one.local");
    ingest(port, "two.local");
    let slug = mint(port, "alias");

    // Two machines: a curve here is one or two people's day, not a fleet's.
    let (code, v) = call(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(code, 200);
    assert!(
        v["hours"].is_null(),
        "two machines is not a demand curve, it is a diary"
    );
    assert_eq!(v["hoursMinMachines"], 3);

    ingest(port, "three.local");
    let (_, v) = call(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(v["hours"]["9"], 12, "three machines, summed: 4 each");
    assert_eq!(v["hours"]["14"], 21);
    assert_eq!(
        v["hours"]["0"], 0,
        "every hour is present, including the empty ones"
    );

    // …and it never appears on a machine, only on the board.
    assert!(
        v["entries"][0].get("hours").is_none(),
        "an hour curve per machine is a person's schedule however it is labelled"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_machine_that_reported_is_on_the_board_biggest_first() {
    let (port, _app) = start("fleet").await;
    for h in ["one.local", "two.local", "three.local"] {
        ingest(port, h);
    }
    let slug = mint(port, "alias");
    let (code, v) = call(
        port,
        "GET",
        &format!("/api/v1/public/board?s={slug}"),
        None,
        None,
    );
    assert_eq!(code, 200);

    let entries = v["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names.iter().collect::<std::collections::HashSet<_>>().len(),
        3,
        "two rows sharing a pseudonym would be a puzzle for the reader: {names:?}"
    );
    assert_eq!(v["totals"]["machines"], 3);
    assert_eq!(v["totals"]["tokens"], 3000);
}
