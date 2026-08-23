//! TokenHUD server — takes what agents send, keeps it, serves the board.
//!
//! ```text
//! tokenhud-server --new-key            print a key, then set TOKENHUD_KEY
//! TOKENHUD_KEY=… tokenhud-server       http://127.0.0.1:8787
//! ```
//!
//! SQLite for storage, and it binds loopback by default — set TOKENHUD_BIND
//! deliberately, and read the note below before you do.
//!
//! ## On exposing this
//!
//! The ingest key is a bearer secret in a header. Over plain HTTP on a LAN that
//! is adequate against accident and useless against anyone listening. If this
//! server ever leaves your machine, put it behind TLS — a reverse proxy is the
//! easy answer — and treat TOKENHUD_KEY as a real credential.
//!
//! Defaults are chosen so that doing nothing is safe: loopback bind, key
//! required for writes, no CORS, and the agent sends no prompt text.

use std::path::PathBuf;
use tokenhud_server::{board, router, store};

fn env_or(name: &str, dflt: &str) -> String {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v,
        _ => dflt.to_string(),
    }
}

/// 32 bytes of OS randomness, base64url, unpadded — the shape Python's
/// `secrets.token_urlsafe(32)` produces, so a key from either server is a key
/// for either server.
fn new_key() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut buf = [0u8; 32];
    if unsafe { libc::getentropy(buf.as_mut_ptr() as *mut libc::c_void, buf.len()) } != 0 {
        eprintln!("could not read randomness from the OS — refusing to invent a key");
        std::process::exit(1);
    }
    let mut out = String::new();
    for chunk in buf.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let take = chunk.len() + 1; // 3 bytes -> 4 chars, 2 -> 3, 1 -> 2
        for i in 0..take {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3F) as usize] as char);
        }
    }
    out
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "--new-key") {
        println!("{}", new_key());
        return;
    }

    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let bind = env_or("TOKENHUD_BIND", "127.0.0.1");
    let port: u16 = env_or("TOKENHUD_PORT", "8787").parse().unwrap_or(8787);
    let key = std::env::var("TOKENHUD_KEY").unwrap_or_default();
    let db = PathBuf::from(env_or(
        "TOKENHUD_DB",
        root.join("data")
            .join("tokenhud.db")
            .to_string_lossy()
            .as_ref(),
    ));
    let web = PathBuf::from(env_or(
        "TOKENHUD_WEB",
        root.join("web").to_string_lossy().as_ref(),
    ));
    let retention: i64 = env_or("TOKENHUD_RETENTION_DAYS", "30")
        .parse()
        .unwrap_or(30);
    // Reads are open by default so the dashboard needs no secret in the browser.
    let protect_reads = std::env::var("TOKENHUD_PROTECT_READS").unwrap_or_default() == "1";
    // Every reader of the event stream holds a task for as long as it watches.
    // Cheap here — a task, not a thread — but still bounded rather than hoped
    // about: past the cap the endpoint says no and the board falls back to
    // polling, which still works and is what it did before.
    let max_streams: u64 = env_or("TOKENHUD_MAX_STREAMS", "64").parse().unwrap_or(64);

    if key.is_empty() {
        println!("TOKENHUD_KEY is not set — ingest will reject every agent.");
        println!("Generate one:  tokenhud-server --new-key");
        println!("Then:          export TOKENHUD_KEY=<that value>\n");
    }
    if bind != "127.0.0.1" {
        println!("! binding {bind} — this server is reachable from the network.");
        println!("! put TLS in front of it before sending a real key over the wire.\n");
    }

    let store = match store::Store::open(&db, retention) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("could not open {}: {e}", db.display());
            std::process::exit(1);
        }
    };
    let app = board::App::new(store, key, protect_reads, max_streams, web);

    let router = router(app.clone());

    // Retention runs on a timer, not per request. Once at startup so a
    // long-stopped server catches up, then hourly — the horizon is 30 days, so
    // the exact cadence is irrelevant and the cost of getting it wrong on the
    // ingest path is not.
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let app = app.clone();
                let _ = tokio::task::spawn_blocking(move || match app.store.prune() {
                    Ok(n) if n > 0 => println!("  pruned {n} rows past retention"),
                    Ok(_) => {}
                    Err(e) => eprintln!("  prune failed: {e}"),
                })
                .await;
            }
        });
    }

    let addr = format!("{bind}:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("could not bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!("TOKENHUD server on http://{addr}");
    println!("  db        {}", db.display());
    println!("  retention {retention} days");
    println!("  ctrl-c to stop");

    let serve = axum::serve(listener, router);
    if let Err(e) = serve.with_graceful_shutdown(shutdown()).await {
        eprintln!("server error: {e}");
    }
    println!("\nstopped");
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
