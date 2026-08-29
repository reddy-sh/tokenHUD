//! TokenHUD agent - runs on a machine, reads it, ships it.
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
//!     next successful post - a flaky network shows as a gap that fills in.
//!
//!   · **It never crashes the loop.** Any failure in a cycle is logged and the
//!     loop continues, panics included. A monitoring agent that dies on the one
//!     day something goes wrong is worse than no agent.
//!
//!   · **It sends no secrets.** Prompt text is opt-in and command lines are
//!     truncated. See `collect.rs`.

use tokenhud_agent::{collect, enable, limits, manifest, transcripts};

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
                println!("\nAgreed. Recorded in ~/.tokenhud/consent.json - delete it to revoke.\n");
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

/// This machine's own identity and enrollment.
///
/// `~/.tokenhud/id` is random, minted once, derived from nothing - hostnames
/// collide and get renamed, and an identity that survives both is the whole
/// reason this file exists. `~/.tokenhud/machine.json` is what `enroll` wrote:
/// which server this machine reports to, and the key that is this machine's
/// alone. Both are declared in the manifest like every other write.
mod machine {
    use super::*;

    pub fn cfg_path() -> PathBuf {
        transcripts::state_dir().join("machine.json")
    }

    fn write_private(path: &PathBuf, body: &str) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn ensure_id() -> String {
        let p = transcripts::state_dir().join("id");
        if let Ok(s) = fs::read_to_string(&p) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
        let id = limits::random_hex(16);
        if let Err(e) = write_private(&p, &id) {
            log(&format!("could not write {}: {e}", p.display()));
        }
        id
    }

    pub struct Enrollment {
        pub server: String,
        pub install_id: String,
        pub key: String,
    }

    pub fn load() -> Option<Enrollment> {
        let text = fs::read_to_string(cfg_path()).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let s = |k: &str| -> Option<String> { v.get(k)?.as_str().map(str::to_string) };
        Some(Enrollment {
            server: s("server")?,
            install_id: s("installId")?,
            key: s("key")?,
        })
    }

    pub fn save(server: &str, install_id: &str, key: &str) -> std::io::Result<()> {
        write_private(
            &cfg_path(),
            &serde_json::to_string_pretty(&serde_json::json!({
                "server": server,
                "installId": install_id,
                "key": key,
                "enrolledAt": collect::now_iso(),
            }))
            .unwrap_or_default(),
        )
    }
}

struct Config {
    server: String,
    key: String,
    install_id: Option<String>,
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
        // Environment beats enrollment beats defaults: an operator who sets
        // TOKENHUD_SERVER or TOKENHUD_KEY is overriding on purpose, and an
        // enrolled machine with neither set just works.
        let enrolled = machine::load();
        let env_server = matches!(std::env::var("TOKENHUD_SERVER"), Ok(ref v) if !v.is_empty());
        let env_key = matches!(std::env::var("TOKENHUD_KEY"), Ok(ref v) if !v.is_empty());
        // Overriding HALF of an enrollment mixes credentials across servers:
        // the enrolled key is valid only at the enrolled server, so a lone
        // TOKENHUD_SERVER sends it somewhere that will refuse it forever (and
        // a lone TOKENHUD_KEY does the mirror image). Say so up front - the
        // 401 that follows would otherwise be a mystery.
        if enrolled.is_some() && (env_server != env_key) {
            log("warning: this machine is enrolled, but only one of TOKENHUD_SERVER /");
            log("TOKENHUD_KEY is set - the env half wins and the enrolled half fills in,");
            log("which pairs a key with a server it was not issued for. Set both or neither.");
        }
        let server = match std::env::var("TOKENHUD_SERVER") {
            Ok(v) if !v.is_empty() => v,
            _ => enrolled
                .as_ref()
                .map(|e| e.server.clone())
                .unwrap_or_else(|| "http://127.0.0.1:8787".to_string()),
        };
        let key = match std::env::var("TOKENHUD_KEY") {
            Ok(v) if !v.is_empty() => v,
            _ => enrolled.as_ref().map(|e| e.key.clone()).unwrap_or_default(),
        };
        Config {
            server: server.trim_end_matches('/').to_string(),
            key,
            install_id: enrolled.map(|e| e.install_id),
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

/// What happened to a POST, split the way the spool needs it split: a server
/// that is away will take this reading later, a server that REFUSED it never
/// will - buffering against a 401 just grows a spool that can only be replayed
/// into the same 401.
enum Post {
    Sent,
    Refused(u16),
    Unreachable,
}

fn post(cfg: &Config, snapshot: &Value) -> Post {
    let raw = match serde_json::to_vec(snapshot) {
        Ok(r) => r,
        Err(e) => {
            log(&format!("could not serialise snapshot: {e}"));
            return Post::Refused(0);
        }
    };
    // Compress the UPLOAD, not just the download. A snapshot is ~60 KB of
    // highly repetitive JSON and gzips about 5:1. On loopback that is a
    // rounding error; over a network - which is where this is heading - it is
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
        Ok(res) => {
            let code = res.status().as_u16();
            if (200..300).contains(&code) {
                Post::Sent
            } else {
                Post::Refused(code)
            }
        }
        Err(ureq::Error::StatusCode(code)) => {
            log(&format!("server refused: {code}"));
            Post::Refused(code)
        }
        Err(e) => {
            log(&format!("post failed: {e}"));
            Post::Unreachable
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
    fs::write(&cfg.spool, out)?;
    // 0600 like every other state file: a spooled reading can carry opt-in
    // prompt text, and it must not be the one file another user could read.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&cfg.spool, fs::Permissions::from_mode(0o600));
    }
    Ok(())
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
    let mut left: Vec<Value> = Vec::new();
    let mut stopped = false;
    for row in rows {
        if stopped {
            left.push(row);
            continue;
        }
        match post(cfg, &row) {
            Post::Sent => {}
            // 401/403 is about the KEY, not this row - the data is fine and
            // will be accepted once the credential is fixed. Keep everything.
            Post::Refused(401) | Post::Refused(403) => {
                stopped = true;
                left.push(row);
            }
            // 400/413/422 are about THIS row (malformed, too large): replaying
            // it can only be refused again, and stopping on it would wedge the
            // flush forever. Drop it and keep going. Any other 4xx - 404 from
            // a misrouted proxy, 429, 408 - is about the moment, not the row.
            Post::Refused(400) | Post::Refused(413) | Post::Refused(422) => {
                log("dropping one buffered snapshot the server refused as malformed or too large");
            }
            // The server is away or in trouble; everything from here on waits.
            _ => {
                stopped = true;
                left.push(row);
            }
        }
    }
    if left.is_empty() {
        let _ = fs::remove_file(&cfg.spool);
    } else {
        let _ = spool_write(cfg, &left);
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
    // A stable identity that survives hostname renames. The enrolled path
    // has an installId from the enroll handshake; the shared-key path gets
    // one from ~/.tokenhud/id, minted once and carried ever after.
    let mid = cfg
        .install_id
        .clone()
        .unwrap_or_else(machine::ensure_id);
    snap["machineId"] = serde_json::json!(mid);
    if let Some(id) = &cfg.install_id {
        snap["installId"] = serde_json::json!(id);
    }

    if cfg.dry {
        println!(
            "{}",
            serde_json::to_string_pretty(&snap).unwrap_or_default()
        );
        return;
    }
    match post(cfg, &snap) {
        Post::Sent => {
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
        }
        // A rejected credential is a configuration mistake, not a blip.
        // Buffering would grow a spool that can only replay into the same
        // refusal; the readings before the mistake are kept, these are not.
        Post::Refused(401) | Post::Refused(403) => {
            log("key rejected (401/403) - not buffering. Fix TOKENHUD_KEY, or enroll this");
            log("machine with a fresh link from the board: tokenhud-agent enroll \"<link>\"");
        }
        Post::Refused(400) | Post::Refused(413) | Post::Refused(422) => {
            log("server refused this reading as malformed or too large - dropped, not buffered");
        }
        _ => {
            spool_add(cfg, &snap);
            log("buffered (server unreachable)");
        }
    }
}

// ── enrollment ──────────────────────────────────────────────────────────

/// One HTTP exchange, JSON in and JSON out, with status errors kept as
/// answers rather than raised as errors - an enrollment poll NEEDS to read
/// the body of a 404 to say something useful.
fn http_json(method: &str, url: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
    let ua = format!("tokenhud-agent/{}", collect::AGENT_VERSION);
    let res = match (method, body) {
        ("POST", Some(v)) => ureq::post(url)
            .config()
            .timeout_global(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .build()
            .header("User-Agent", &ua)
            .header("Content-Type", "application/json")
            .send(serde_json::to_string(v).unwrap_or_default())
            .map_err(|e| e.to_string())?,
        _ => ureq::get(url)
            .config()
            .timeout_global(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .build()
            .header("User-Agent", &ua)
            .call()
            .map_err(|e| e.to_string())?,
    };
    let code = res.status().as_u16();
    let text = res
        .into_body()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    Ok((code, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// `tokenhud-agent enroll "<server>#<token>"` - claim a link the board
/// minted, wait for a person to approve this machine there, and keep the key
/// that comes back. The board key never touches this machine.
///
/// Returns only when the machine is enrolled and its key is on disk; every
/// other ending exits. The caller then falls into the reporting loop, so
/// enrolling and starting to report are one command rather than two.
fn enroll_cmd(link: Option<&String>) {
    let link = match link {
        Some(l) => l.trim().trim_matches('"').to_string(),
        None => {
            eprintln!("usage: tokenhud-agent enroll \"<link from the board>\"");
            eprintln!("Mint one on the board: Machines → Add machine.");
            std::process::exit(2);
        }
    };
    let (server, token) = match link.split_once('#') {
        Some((s, t))
            if !t.is_empty() && (s.starts_with("http://") || s.starts_with("https://")) =>
        {
            (s.trim_end_matches('/').to_string(), t.to_string())
        }
        _ => {
            eprintln!("that does not look like an enrollment link - expected <server-url>#<token>");
            std::process::exit(2);
        }
    };

    // Consent first: enrolling is precisely the moment this machine starts
    // reporting, so the manifest is shown and agreed to before anything else.
    if !consent::obtain() {
        std::process::exit(2);
    }

    let install_id = machine::ensure_id();
    // A secret this machine just invented, sent with the claim and demanded
    // back at key delivery - so the link alone, leaked into a chat or a shell
    // history, cannot collect this machine's key.
    let poll_secret = limits::random_hex(24);
    let body = serde_json::json!({
        "token": token,
        "secret": poll_secret,
        "installId": install_id,
        "host": collect::host_id(),
        "platform": std::env::consts::OS,
        "agentVersion": collect::AGENT_VERSION,
        "manifestDigest": manifest::digest(),
        // What the approver sees: which AI assistants live on this machine.
        "assistants": collect::collect_assistants(&[]),
    });
    let (code, resp) = match http_json("POST", &format!("{server}/api/v1/enroll"), Some(&body)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("could not reach {server}: {e}");
            std::process::exit(1);
        }
    };
    if code != 200 {
        let why = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("the server refused the enrollment");
        eprintln!("enrollment refused ({code}): {why}");
        eprintln!("Links are one-shot and expire in 15 minutes - mint a fresh one on the board.");
        std::process::exit(1);
    }
    let pair = resp
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();

    println!();
    println!("  This machine is now PENDING on {server}");
    println!();
    println!("  Pairing code:   {pair}");
    println!();
    println!("  Approve it on the board (Machines → pending) and check the code");
    println!("  there matches this one. Waiting…");
    println!();

    let deadline = std::time::Instant::now() + Duration::from_secs(900);
    loop {
        if std::time::Instant::now() > deadline {
            eprintln!("timed out waiting for approval - mint a fresh link and enroll again.");
            std::process::exit(1);
        }
        std::thread::sleep(Duration::from_secs(2));
        let (_, st) = match http_json(
            "GET",
            &format!("{server}/api/v1/enroll/await?token={token}&secret={poll_secret}"),
            None,
        ) {
            Ok(r) => r,
            Err(e) => {
                log(&format!("poll failed ({e}) - retrying"));
                continue;
            }
        };
        match st.get("status").and_then(|v| v.as_str()) {
            Some("pending") => continue,
            Some("approved") => {
                match st.get("key").and_then(|v| v.as_str()) {
                    Some(key) => {
                        if let Err(e) = machine::save(&server, &install_id, key) {
                            eprintln!("approved, but the key could not be saved: {e}");
                            std::process::exit(1);
                        }
                        let label = st.get("label").and_then(|v| v.as_str()).unwrap_or("");
                        println!("  Approved. This machine reports as “{label}”.");
                        println!();
                        println!(
                            "  Its key is in {} - its own, revocable alone.",
                            machine::cfg_path().display()
                        );
                        println!("  Reporting now. Ctrl-C stops it; see agent/INSTALL.md to keep");
                        println!("  it running across logins.");
                        println!();
                        // Falls through to the reporting loop rather than
                        // exiting: enrolling is how someone says "start
                        // watching this machine", and a board that stays empty
                        // until you happen to run a second command is a
                        // half-finished answer. Config::load picks up the
                        // machine.json just written.
                        return;
                    }
                    None => {
                        eprintln!(
                            "this link already delivered a key, and a key is delivered only once."
                        );
                        eprintln!(
                            "Ask the board's operator to revoke this machine, then enroll with a fresh link."
                        );
                        std::process::exit(1);
                    }
                }
            }
            Some("denied") => {
                eprintln!("denied on the board. Nothing was configured.");
                std::process::exit(1);
            }
            Some(other) => {
                eprintln!("enrollment ended: {other}");
                std::process::exit(1);
            }
            None => {
                eprintln!(
                    "the enrollment is gone (expired, or the server restarted mid-approval)."
                );
                eprintln!("Mint a fresh link and enroll again.");
                std::process::exit(1);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let has = |f: &str| args.iter().any(|a| a == f);

    if has("--version") || has("-V") {
        println!("tokenhud-agent {}", collect::AGENT_VERSION);
        return;
    }

    if args.get(1).map(String::as_str) == Some("enroll") {
        enroll_cmd(args.get(2));
    }

    // `enable` does one edit and stops, where `enroll` returns and falls into
    // the reporting loop. The two are opposite intents: enrolling says "start
    // watching this machine", enabling says "change this one file". Running a
    // 30-second loop after the second would be answering a question nobody
    // asked.
    if args.get(1).map(String::as_str) == Some("enable") {
        std::process::exit(enable::cmd(&args[2..]));
    }

    // Show what would be read, and read nothing. Needs no key and no consent -
    // it is the thing you run *before* deciding.
    if has("--what-i-read") || has("--what-it-reads") {
        print!("{}", manifest::render());
        return;
    }

    // For a launcher that needs to know whether to ask, before it detaches a
    // process that has nobody to ask. Exit 0 = agreed to the current manifest.
    if has("--consent-status") {
        if consent::granted() {
            println!("agreed · manifest {}", manifest::digest());
            return;
        }
        eprintln!("not agreed · manifest {}", manifest::digest());
        std::process::exit(1);
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
        println!("  enroll \"<link>\"  claim an enrollment link from the board; this machine");
        println!("                    gets its own key, approvable and revocable alone");
        println!("  enable <tool>   turn a tool's own usage logging on: prints the diff, asks,");
        println!(
            "                    then merges. Knows: {}",
            enable::ENABLEABLE.join(", ")
        );
        println!("  enable --print <tool>");
        println!("                    the same edit as JSON, for a coding agent to apply");
        println!("  --what-i-read   every file it opens, resolved against this machine");
        println!("  --dry-run       print the reading it would send, and send nothing");
        println!("  --accept        agree to the manifest without being prompted");
        println!("  --consent-status  exit 0 if the current manifest is already agreed");
        println!("  --once          one cycle, then exit");
        println!("  --version       print the version and exit");
        println!("\nConfigured by TOKENHUD_SERVER, TOKENHUD_KEY, TOKENHUD_INTERVAL -");
        println!("or by ~/.tokenhud/machine.json, which `enroll` writes for you.");
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
        log("No key - the server will refuse this agent. Either enroll this machine");
        log("with a link from the board:  tokenhud-agent enroll \"<link>\"");
        log("or set TOKENHUD_KEY (generate one: tokenhud-server --new-key).");
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
