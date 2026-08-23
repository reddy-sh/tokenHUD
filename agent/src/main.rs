//! TokenHUD agent — runs on a machine, reads it, ships it.
//!
//!     TOKENHUD_SERVER=http://127.0.0.1:8787 TOKENHUD_KEY=… tokenhud-agent
//!
//! The agent is the only thing that touches your machine. It knows nothing
//! about storage or the dashboard: it collects a snapshot, POSTs it, forgets
//! it. That separation is the point.
//!
//! The three properties the Python file argues for are the ones to preserve:
//!
//!   · **It buffers.** A laptop that closes its lid mid-post must not lose the
//!     reading. Failed snapshots queue on disk (bounded) and go out with the
//!     next successful post — a flaky network shows as a gap that fills in.
//!
//!   · **It never crashes the loop.** Any failure in a cycle is logged and the
//!     loop continues, panics included. A monitoring agent that dies on the one
//!     day something goes wrong is worse than no agent.
//!
//!   · **It sends no secrets.** Prompt text is opt-in and command lines are
//!     truncated. See `collect.rs`.

use tokenhud_agent::{collect, manifest, transcripts};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// Consent, recorded against what was disclosed.
///
/// A one-time "I agree" is worth very little if the thing agreed to can change
/// underneath it. So the record stores the manifest digest, and a release that
/// reads something new produces a different digest and asks again. That is the
/// difference between asking permission and collecting a signature.
mod consent {
    use super::*;

    fn path() -> PathBuf {
        transcripts::state_dir().join("consent.json")
    }

    /// The digest the user last agreed to, if any.
    fn recorded() -> Option<String> {
        let text = fs::read_to_string(path()).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        v.get("manifest")?.as_str().map(str::to_string)
    }

    pub fn granted() -> bool {
        recorded().as_deref() == Some(manifest::digest().as_str())
    }

    pub fn record(how: &str) -> std::io::Result<()> {
        let p = path();
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir)?;
        }
        let body = serde_json::json!({
            "manifest": manifest::digest(),
            "agent": collect::AGENT_VERSION,
            "at": collect::now_iso(),
            "how": how,
        });
        fs::write(&p, serde_json::to_string_pretty(&body).unwrap_or_default())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// Ask, if there is someone there to ask. Returns true when it may proceed.
    pub fn obtain() -> bool {
        if granted() {
            return true;
        }
        print!("{}", manifest::render());

        let interactive = std::io::IsTerminal::is_terminal(&std::io::stdin());
        if !interactive {
            eprintln!(
                "\nNothing has been read yet, and nothing will be until you agree.\n\
                 There is no terminal here to ask on, so agree explicitly:\n\n  \
                 tokenhud-agent --accept\n"
            );
            return false;
        }

        print!(
            "\nRead these and report to {}? [y/N] ",
            env_or("TOKENHUD_SERVER", "http://127.0.0.1:8787")
        );
        let _ = std::io::Write::flush(&mut std::io::stdout());
        let mut answer = String::new();
        if std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut answer).is_err() {
            return false;
        }
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!(
                "\nNot agreed. Nothing was read. Run --what-i-read any time to see this again."
            );
            return false;
        }
        match record("interactive") {
            Ok(()) => {
                println!("\nAgreed. Recorded in ~/.tokenhud/consent.json — delete it to revoke.\n");
                true
            }
            Err(e) => {
                eprintln!("could not record consent: {e}");
                false
            }
        }
    }
}

const SPOOL_MAX: usize = 500; // snapshots; ~a few MB, bounded on purpose

struct Config {
    server: String,
    key: String,
    interval: u64,
    once: bool,
    dry: bool,
    spool: PathBuf,
}

fn env_or(name: &str, default: &str) -> String {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v,
        _ => default.to_string(),
    }
}

impl Config {
    fn load() -> Config {
        let args: Vec<String> = std::env::args().collect();
        let state = transcripts::state_dir();
        Config {
            server: env_or("TOKENHUD_SERVER", "http://127.0.0.1:8787")
                .trim_end_matches('/')
                .to_string(),
            key: std::env::var("TOKENHUD_KEY").unwrap_or_default(),
            interval: env_or("TOKENHUD_INTERVAL", "30").parse().unwrap_or(30),
            once: args.iter().any(|a| a == "--once")
                || std::env::var("TOKENHUD_ONCE").unwrap_or_default() == "1",
            dry: args.iter().any(|a| a == "--dry-run"),
            spool: match std::env::var("TOKENHUD_SPOOL") {
                Ok(v) if !v.is_empty() => transcripts::expand_tilde(&v),
                _ => state.join("spool.jsonl"),
            },
        }
    }
}

/// stderr, so `tokenhud-agent --dry-run | jq` is a pipeline and not a puzzle.
fn log(msg: &str) {
    eprintln!("{} {}", chrono::Local::now().format("%H:%M:%S"), msg);
}

fn gzip(raw: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut e = GzEncoder::new(Vec::new(), Compression::new(6));
    e.write_all(raw)?;
    e.finish()
}

fn post(cfg: &Config, snapshot: &Value) -> bool {
    let raw = match serde_json::to_vec(snapshot) {
        Ok(r) => r,
        Err(e) => {
            log(&format!("could not serialise snapshot: {e}"));
            return false;
        }
    };
    // Compress the UPLOAD, not just the download. A snapshot is ~60 KB of
    // highly repetitive JSON and gzips about 5:1. On loopback that is a
    // rounding error; over a network — which is where this is heading — it is
    // the difference between a rounding error and a bill. The server accepts
    // both, so an old agent talking to a new server still works.
    let gz = gzip(&raw).ok();
    let (body, gzipped) = match &gz {
        // Tiny payloads can grow; do not bother.
        Some(g) if g.len() < raw.len() => (g.as_slice(), true),
        _ => (raw.as_slice(), false),
    };

    let url = format!("{}/api/v1/ingest", cfg.server);
    let mut req = ureq::post(&url)
        .config()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .header("Content-Type", "application/json")
        .header("X-TokenHUD-Key", cfg.key.as_str())
        .header(
            "User-Agent",
            &format!("tokenhud-agent/{}", collect::AGENT_VERSION),
        );
    if gzipped {
        req = req.header("Content-Encoding", "gzip");
    }

    match req.send(body) {
        Ok(res) => (200..300).contains(&res.status().as_u16()),
        Err(ureq::Error::StatusCode(code)) => {
            // A 401 is a configuration mistake, not a blip — say so plainly
            // rather than spooling forever against a server that will never
            // accept us.
            log(&format!("server refused: {code}"));
            false
        }
        Err(e) => {
            log(&format!("post failed: {e}"));
            false
        }
    }
}

// ── the spool ───────────────────────────────────────────────────────────

fn spool_read(cfg: &Config) -> Vec<Value> {
    let text = match fs::read_to_string(&cfg.spool) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log(&format!("spool read failed: {e}"));
            return Vec::new();
        }
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn spool_write(cfg: &Config, rows: &[Value]) -> std::io::Result<()> {
    if let Some(dir) = cfg.spool.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut out = String::new();
    for r in rows {
        out.push_str(&serde_json::to_string(r).unwrap_or_default());
        out.push('\n');
    }
    fs::write(&cfg.spool, out)
}

fn spool_add(cfg: &Config, snapshot: &Value) {
    let mut rows = spool_read(cfg);
    rows.push(snapshot.clone());
    if rows.len() > SPOOL_MAX {
        rows.drain(..rows.len() - SPOOL_MAX);
    }
    if let Err(e) = spool_write(cfg, &rows) {
        log(&format!("spool write failed: {e}"));
    }
}

fn spool_flush(cfg: &Config) {
    let rows = spool_read(cfg);
    if rows.is_empty() {
        return;
    }
    log(&format!("flushing {} buffered snapshot(s)", rows.len()));
    let mut left: &[Value] = &[];
    for (i, row) in rows.iter().enumerate() {
        if !post(cfg, row) {
            left = &rows[i..];
            break;
        }
    }
    if left.is_empty() {
        let _ = fs::remove_file(&cfg.spool);
    } else {
        let _ = spool_write(cfg, left);
    }
}

// ── one cycle ───────────────────────────────────────────────────────────

fn cycle(cfg: &Config) {
    let mut snap = collect::collect();
    // The board schedules its next fetch from this. Only the agent knows how
    // often it reports, so only the agent can say it; without it a dashboard
    // has to guess a poll rate and is wrong in one of two directions. Stamped
    // per snapshot rather than sent once, so changing TOKENHUD_INTERVAL takes
    // effect on the next cycle.
    snap["intervalSeconds"] = serde_json::json!(cfg.interval);

    if cfg.dry {
        println!(
            "{}",
            serde_json::to_string_pretty(&snap).unwrap_or_default()
        );
        return;
    }
    if post(cfg, &snap) {
        spool_flush(cfg);
        let procs = snap["metrics"]["processes"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0);
        let projects = snap["metrics"]["projects"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0);
        log(&format!("sent · {procs} proc · {projects} projects"));
    } else {
        spool_add(cfg, &snap);
        log("buffered (server unreachable)");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let has = |f: &str| args.iter().any(|a| a == f);

    // Show what would be read, and read nothing. Needs no key and no consent —
    // it is the thing you run *before* deciding.
    if has("--what-i-read") || has("--what-it-reads") {
        print!("{}", manifest::render());
        return;
    }

    if has("--accept") {
        match consent::record("--accept") {
            Ok(()) => {
                print!("{}", manifest::render());
                println!("\nAgreed, and recorded in ~/.tokenhud/consent.json.");
                println!(
                    "Manifest {} · delete that file to revoke.",
                    manifest::digest()
                );
            }
            Err(e) => {
                eprintln!("could not record consent: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    if has("--help") || has("-h") {
        println!("tokenhud-agent {}\n", collect::AGENT_VERSION);
        println!("  --what-i-read   every file it opens, resolved against this machine");
        println!("  --dry-run       print the reading it would send, and send nothing");
        println!("  --accept        agree to the manifest without being prompted");
        println!("  --once          one cycle, then exit");
        println!("\nConfigured by TOKENHUD_SERVER, TOKENHUD_KEY, TOKENHUD_INTERVAL.");
        println!("See agent/INSTALL.md for the rest.");
        return;
    }

    let cfg = Config::load();

    // Consent gates sending, not looking. --dry-run reads your files and prints
    // the result to your own terminal, which is you inspecting your own machine;
    // nothing leaves it, so nothing needs agreeing to.
    if !cfg.dry && !consent::obtain() {
        std::process::exit(2);
    }

    if !cfg.dry && cfg.key.is_empty() {
        log("TOKENHUD_KEY is not set — the server will refuse this agent.");
        log("Generate one with: tokenhud-server --new-key");
        std::process::exit(2);
    }

    log(&format!(
        "tokenhud-agent {} (rust) · host={}",
        collect::AGENT_VERSION,
        collect::host_id()
    ));
    if !cfg.dry {
        log(&format!("server={} interval={}s", cfg.server, cfg.interval));
    }

    loop {
        // Never die on one bad cycle. A `Result` covers what this code knows
        // can fail; the unwind covers what it does not.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cycle(&cfg)));
        if r.is_err() {
            log("cycle error: panic (continuing)");
        }
        if cfg.once || cfg.dry {
            return;
        }
        std::thread::sleep(Duration::from_secs(cfg.interval));
    }
}
