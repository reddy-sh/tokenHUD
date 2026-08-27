//! Collectors - everything the agent knows how to look at on one machine.
//!
//! Each collector returns plain JSON and never fails upward. A host with a broken or
//! missing source reports the rest of itself rather than disappearing from the
//! board - the difference between "the disk collector is down" and "the host is
//! down", which a monitoring tool that cannot tell apart is worse than none.

use crate::pricing;
use crate::transcripts::{self, claude_dir, home, Index, Session, Tok};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const AGENT_VERSION: &str = "0.2.0";

// ── helpers ─────────────────────────────────────────────────────────────

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Python's `datetime.isoformat()`, exactly: microseconds are printed to six
/// places when there are any and omitted entirely when there are none. chrono
/// has no mode that does both - `Micros` always writes `.000000` and `AutoSi`
/// drops to three digits on a round millisecond - and either one puts a
/// cosmetic difference on every block boundary in the conformance diff.
pub fn iso_of(dt: DateTime<Utc>) -> String {
    if dt.timestamp_subsec_micros() == 0 {
        dt.to_rfc3339_opts(SecondsFormat::Secs, false)
    } else {
        dt.to_rfc3339_opts(SecondsFormat::Micros, false)
    }
}

fn iso_ms(ms: Option<f64>) -> Value {
    match ms.and_then(|m| DateTime::from_timestamp_millis(m as i64)) {
        Some(dt) => json!(iso_of(dt)),
        None => Value::Null,
    }
}

pub fn now_iso() -> String {
    iso_of(Utc::now())
}

fn iso_from_secs(secs: i64) -> String {
    iso_of(Utc.timestamp_opt(secs, 0).single().unwrap_or_else(Utc::now))
}

/// A file's mtime in microseconds since the epoch.
///
/// Microseconds, not seconds: Python reads `st_mtime` as a float and
/// `datetime.fromtimestamp` keeps it to the microsecond, so truncating here
/// would put a sub-second difference on every project row.
fn mtime_micros(md: &fs::Metadata) -> i64 {
    let d = match md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    {
        Some(d) => d,
        None => return 0,
    };
    let micros = (d.subsec_nanos() as f64 / 1000.0).round() as i64;
    if micros >= 1_000_000 {
        (d.as_secs() as i64 + 1) * 1_000_000
    } else {
        d.as_secs() as i64 * 1_000_000 + micros
    }
}

fn iso_from_micros(us: i64) -> String {
    iso_of(
        Utc.timestamp_opt(
            us.div_euclid(1_000_000),
            (us.rem_euclid(1_000_000) * 1000) as u32,
        )
        .single()
        .unwrap_or_else(Utc::now),
    )
}

/// Python's `Path(p).name`: the last component, empty for "/" and "".
fn base_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Stable name for this machine. Overridable so two laptops with the same
/// hostname (a fresh Mac restored from backup) do not merge on the board.
pub fn host_id() -> String {
    match std::env::var("TOKENHUD_HOST") {
        Ok(v) if !v.is_empty() => v,
        _ => hostname(),
    }
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    if !ok {
        return String::new();
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

struct Uname {
    sysname: String,
    release: String,
    machine: String,
}

fn uname() -> Uname {
    unsafe {
        let mut u: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut u) != 0 {
            return Uname {
                sysname: String::new(),
                release: String::new(),
                machine: String::new(),
            };
        }
        let s = |a: &[libc::c_char]| -> String {
            let b: Vec<u8> = a
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| *c as u8)
                .collect();
            String::from_utf8_lossy(&b).into_owned()
        };
        Uname {
            sysname: s(&u.sysname),
            release: s(&u.release),
            machine: s(&u.machine),
        }
    }
}

fn loadavg() -> Value {
    let mut out = [0f64; 3];
    let n = unsafe { libc::getloadavg(out.as_mut_ptr(), 3) };
    if n != 3 {
        return Value::Null;
    }
    json!(out
        .iter()
        .map(|v| pricing::round(*v, 2))
        .collect::<Vec<_>>())
}

fn which(name: &str) -> Value {
    let path = match std::env::var("PATH") {
        Ok(p) => p,
        Err(_) => return Value::Null,
    };
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        let c = Path::new(dir).join(name);
        if let Ok(md) = fs::metadata(&c) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if md.is_file() && md.permissions().mode() & 0o111 != 0 {
                    return json!(c.to_string_lossy());
                }
            }
            #[cfg(not(unix))]
            if md.is_file() {
                return json!(c.to_string_lossy());
            }
        }
    }
    Value::Null
}

// ── host facts ──────────────────────────────────────────────────────────

pub fn collect_host() -> Value {
    let u = uname();
    json!({
        "hostname": hostname(),
        "platform": u.sysname,
        "release": u.release,
        "machine": u.machine,
        // What is actually running. The board does not read this; it is here
        // so a reading can be traced to a build when one machine disagrees.
        "runtime": format!("rust · tokenhud-agent {AGENT_VERSION}"),
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "loadavg": loadavg(),
    })
}

// ── live processes ──────────────────────────────────────────────────────
//
// Matched on the binary path rather than the word "claude", which appears in
// half the paths on a machine that has ever cloned an Anthropic repo.

/// The Python matches `/claude(\s|$)`. One pattern is not worth a regex engine
/// in a binary whose whole point is being small.
fn looks_like_claude(cmd: &str) -> bool {
    if cmd.contains("claude-code/bin/claude") {
        return true;
    }
    let b = cmd.as_bytes();
    let mut from = 0;
    while let Some(i) = cmd[from..].find("/claude") {
        let end = from + i + "/claude".len();
        if end == b.len() || (b[end] as char).is_whitespace() {
            return true;
        }
        from = end;
    }
    false
}

/// The same rule for Codex, and a separate function rather than a parameter.
///
/// `~/.codex` appears in half the command lines on a machine that runs Codex -
/// `CODEX_HOME`, a plugin path, a rollout - and every one of those has a `.`
/// before the word. Matching `/codex` on a boundary picks the binary
/// (`/Applications/ChatGPT.app/Contents/Resources/codex`) and leaves the
/// directories alone.
fn looks_like_codex(cmd: &str) -> bool {
    let b = cmd.as_bytes();
    let mut from = 0;
    while let Some(i) = cmd[from..].find("/codex") {
        let end = from + i + "/codex".len();
        if end == b.len() || (b[end] as char).is_whitespace() {
            return true;
        }
        from = end;
    }
    false
}

/// The value of `--flag <value>`, whitespace-separated, as the Python's
/// `--agent\s+(\S+)` reads it.
fn flag_value(cmd: &str, flag: &str) -> Option<String> {
    let mut it = cmd.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == flag {
            return it.next().map(|s| s.to_string());
        }
    }
    None
}

pub fn collect_processes() -> Vec<Value> {
    let out = match std::process::Command::new("ps")
        .args(["-Ao", "pid,etime,command"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows: Vec<(i64, Value)> = Vec::new();

    for line in text.lines().skip(1) {
        let t = line.trim_start();
        let (pid_s, rest) = match t.split_once(char::is_whitespace) {
            Some(x) => x,
            None => continue,
        };
        let pid: i64 = match pid_s.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let rest = rest.trim_start();
        let (etime, cmd) = match rest.split_once(char::is_whitespace) {
            Some((e, c)) => (e, c.trim_start()),
            None => continue,
        };

        // Which assistant this is, decided once. The server already carries a
        // `tool` column on an ending; until now nothing filled it, so the
        // board's "Running now" could only ever mean Claude Code.
        let tool = if looks_like_claude(cmd) {
            "claude-code"
        } else if looks_like_codex(cmd) {
            "codex"
        } else {
            continue;
        };
        if cmd.contains("tokenhud") {
            continue;
        }

        let headless = if tool == "codex" {
            // Codex spells it as a subcommand rather than a flag.
            cmd.contains(" exec ") || cmd.ends_with(" exec")
        } else {
            cmd.contains(" -p ") || cmd.ends_with(" -p") || cmd.contains("--print")
        };
        let agent = flag_value(cmd, "--agent");
        let model = flag_value(cmd, "--model");

        let kind = if tool == "codex" {
            if headless {
                "exec".to_string()
            } else if cmd.contains(" mcp") {
                "mcp server".to_string()
            } else if cmd.contains("app-server") {
                "app server".to_string()
            } else {
                "interactive".to_string()
            }
        } else if let Some(a) = &agent {
            format!("agent · {a}")
        } else if headless {
            "headless".to_string()
        } else if cmd.contains("--input-format") && cmd.contains("stream-json") {
            "IDE session".to_string()
        } else if cmd.contains("--remote-control") || cmd.contains("--rc") {
            "remote control".to_string()
        } else {
            "interactive".to_string()
        };

        rows.push((
            pid,
            json!({
                "pid": pid,
                "elapsed": etime,
                "tool": tool,
                "kind": kind,
                "headless": headless,
                "agent": agent,
                "model": model,
                // Truncated deliberately: a full argv can carry a path, a
                // prompt, or a token, and this payload crosses a network.
                "cmd": clip(cmd, 200),
            }),
        ));
    }
    rows.sort_by_key(|(pid, _)| *pid);
    rows.into_iter().map(|(_, v)| v).collect()
}

// ── Claude Code ─────────────────────────────────────────────────────────

pub fn collect_claude_stats() -> Value {
    let root = claude_dir();
    let path = root.join("stats-cache.json");
    let present = path.exists();
    let s = read_json(&path).unwrap_or(Value::Null);
    let get = |k: &str| s.get(k).cloned().unwrap_or(Value::Null);

    let mut tokens_by_date: IndexMap<String, Value> = IndexMap::new();
    if let Some(list) = get("dailyModelTokens").as_array() {
        for r in list {
            if let Some(d) = r.get("date").and_then(|v| v.as_str()) {
                tokens_by_date.insert(
                    d.to_string(),
                    r.get("tokensByModel").cloned().unwrap_or(json!({})),
                );
            }
        }
    }

    let mut daily: Vec<Value> = Vec::new();
    if let Some(list) = get("dailyActivity").as_array() {
        for r in list {
            let date = match r.get("date").and_then(|v| v.as_str()) {
                Some(d) if !d.is_empty() => d,
                _ => continue,
            };
            let tok = tokens_by_date.get(date).cloned().unwrap_or(json!({}));
            let total: f64 = tok
                .as_object()
                .map(|o| o.values().filter_map(|v| v.as_f64()).sum())
                .unwrap_or(0.0);
            daily.push(json!({
                "date": date,
                "messages": r.get("messageCount").and_then(|v| v.as_i64()).unwrap_or(0),
                "toolCalls": r.get("toolCallCount").and_then(|v| v.as_i64()).unwrap_or(0),
                "sessions": r.get("sessionCount").and_then(|v| v.as_i64()).unwrap_or(0),
                "tokensByModel": tok,
                "tokens": if total.fract() == 0.0 { json!(total as i64) } else { json!(total) },
            }));
        }
    }
    daily.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));

    let mut models: Vec<Value> = Vec::new();
    if let Some(obj) = get("modelUsage").as_object() {
        for (name, m) in obj {
            if !m.is_object() {
                continue;
            }
            let n = |k: &str| m.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
            models.push(json!({
                "model": name,
                "input": n("inputTokens"),
                "output": n("outputTokens"),
                "cacheRead": n("cacheReadInputTokens"),
                "cacheCreate": n("cacheCreationInputTokens"),
                "webSearches": n("webSearchRequests"),
                // Zero on a subscription plan. Forwarded exactly as reported;
                // the UI says "not reported" rather than pricing it.
                "costUSD": m.get("costUSD").and_then(|v| v.as_f64()).unwrap_or(0.0),
            }));
        }
    }
    models.sort_by(|a, b| b["output"].as_i64().cmp(&a["output"].as_i64()));

    let mut hours = Map::new();
    for h in 0..24 {
        hours.insert(h.to_string(), json!(0));
    }
    if let Some(obj) = get("hourCounts").as_object() {
        for (h, c) in obj {
            if hours.contains_key(h) {
                hours.insert(h.clone(), c.clone());
            }
        }
    }

    let cost_reported = models
        .iter()
        .any(|m| m["costUSD"].as_f64().unwrap_or(0.0) != 0.0);

    json!({
        "present": present,
        "totalSessions": get("totalSessions").as_i64().unwrap_or(0),
        "totalMessages": get("totalMessages").as_i64().unwrap_or(0),
        "firstSessionDate": get("firstSessionDate"),
        "lastComputedDate": get("lastComputedDate"),
        "daily": daily,
        "models": models,
        "hours": Value::Object(hours),
        "costReported": cost_reported,
    })
}

/// Real cwd and branch, read from inside a transcript.
///
/// The project directory NAME is the absolute path with every "/" replaced by
/// "-", which is not reversible - real directory names contain hyphens, so
/// un-mangling turns `pattadar-platform` into `.../pattadar/platform`. The
/// transcript records its own cwd, so read that instead of guessing.
fn transcript_cwd(path: &Path) -> (Option<String>, Option<String>) {
    // Streamed, and twice bounded. A transcript can pass 200 MB and only its
    // first forty lines are wanted; reading the file to find them made the
    // agent's peak memory a function of the largest transcript on the machine,
    // which is exactly the property this rewrite exists to remove.
    use std::io::{BufRead, Read as _};
    let fh = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(fh.take(2 * 1024 * 1024));
    for line in reader.lines().take(41).map_while(Result::ok) {
        let line = line.as_str();
        if let Ok(r) = serde_json::from_str::<Value>(line) {
            if let Some(cwd) = r.get("cwd").and_then(|v| v.as_str()) {
                if !cwd.is_empty() {
                    return (
                        Some(cwd.to_string()),
                        r.get("gitBranch")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    );
                }
            }
        }
    }
    (None, None)
}

/// The Python's `/[0-9a-f]{7,40}$`.
fn ends_in_sha(path: &str) -> bool {
    let seg = match path.rsplit('/').next() {
        Some(s) => s,
        None => return false,
    };
    if path.rfind('/').is_none() {
        return false;
    }
    let n = seg.len();
    (7..=40).contains(&n)
        && seg
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn collect_claude_projects() -> Vec<Value> {
    let root = claude_dir().join("projects");
    let mut out: Vec<Value> = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for e in entries.flatten() {
        let d = e.path();
        let dir_md = match fs::metadata(&d) {
            Ok(m) if m.is_dir() => m,
            _ => continue,
        };
        let mut sessions: Vec<(PathBuf, i64, u64)> = Vec::new(); // path, mtime µs, bytes
        if let Ok(files) = fs::read_dir(&d) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Ok(md) = f.metadata() {
                    sessions.push((p, mtime_micros(&md), md.len()));
                }
            }
        }
        sessions.sort_by_key(|(_, m, _)| *m);

        let last = sessions
            .iter()
            .map(|(_, m, _)| *m)
            .max()
            .unwrap_or_else(|| mtime_micros(&dir_md));
        let (path, branch) = match sessions.last() {
            Some((p, _, _)) => transcript_cwd(p),
            None => (None, None),
        };
        let dir_name = d
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let path =
            path.unwrap_or_else(|| format!("/{}", dir_name.trim_matches('-').replace('-', "/")));
        let label = {
            let b = base_name(&path);
            if b.is_empty() {
                dir_name.clone()
            } else {
                b
            }
        };

        out.push(json!({
            "path": path,
            "label": label,
            "branch": branch,
            // A background sweep gets its own project directory because it runs
            // in its own worktree. Machine-made and short-lived - mark it so a
            // sha does not pose as a project someone works on.
            "worktree": ends_in_sha(&path) || path.contains("-parity/"),
            "sessions": sessions.len(),
            "bytes": sessions.iter().map(|(_, _, b)| *b).sum::<u64>(),
            "lastActive": iso_from_micros(last),
        }));
    }
    out.sort_by(|a, b| b["lastActive"].as_str().cmp(&a["lastActive"].as_str()));
    out
}

pub fn collect_daemon() -> Value {
    let st = read_json(&claude_dir().join("daemon.status.json")).unwrap_or(json!({}));
    let pid = st.get("supervisorPid").cloned().unwrap_or(Value::Null);
    let alive = pid
        .as_i64()
        .map(|p| unsafe { libc::kill(p as libc::pid_t, 0) } == 0)
        .unwrap_or(false);
    json!({
        "pid": pid,
        "alive": alive,
        "startedAt": st.get("supervisorProcStart").cloned().unwrap_or(Value::Null),
        "workers": st.get("workers").cloned().unwrap_or(json!({})),
        "writtenAt": iso_ms(st.get("writtenAt").and_then(|v| v.as_f64())),
    })
}

/// Recent prompt subjects.
///
/// OFF by default. Prompt text is the most sensitive thing on this machine, and
/// a metrics payload that crosses a network should not carry it unless someone
/// deliberately said so.
pub fn collect_prompts() -> Vec<Value> {
    if std::env::var("TOKENHUD_SEND_PROMPTS").unwrap_or_default() != "1" {
        return Vec::new();
    }
    let text = match fs::read_to_string(claude_dir().join("history.jsonl")) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let rows: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let tail = rows.iter().rev().take(30);
    tail.filter(|r| r.is_object())
        .map(|r| {
            json!({
                "text": clip(
                    r.get("display").and_then(|v| v.as_str()).unwrap_or("").trim()
                        .replace('\n', " ").as_str(), 160),
                "project": r.get("project").and_then(|v| v.as_str()).unwrap_or(""),
                "at": iso_ms(r.get("timestamp").and_then(|v| v.as_f64())),
            })
        })
        .collect()
}

// ── which assistants this machine has ───────────────────────────────────
//
// The board reads Claude Code. Everything else here is detection only, and says
// so: an entry is "this tool is installed", never "we have numbers for it".

const ASSISTANTS: &[(&str, &str, &[&str], Option<&str>)] = &[
    ("claude-code", "Claude Code", &[".claude"], Some("claude")),
    ("codex", "Codex CLI", &[".codex"], Some("codex")),
    ("cursor", "Cursor", &[".cursor"], Some("cursor")),
    ("gemini-cli", "Gemini CLI", &[".gemini"], Some("gemini")),
    (
        "copilot",
        "GitHub Copilot",
        &[".config/github-copilot", ".copilot"],
        Some("copilot"),
    ),
    (
        "windsurf",
        "Windsurf",
        &[".windsurf", ".codeium"],
        Some("windsurf"),
    ),
    ("antigravity", "Antigravity", &[".antigravity-ide"], None),
    ("aider", "Aider", &[".aider.conf.yml"], Some("aider")),
    (
        "devin",
        "Devin",
        &[".devin", ".config/devin", ".local/share/devin"],
        None,
    ),
    (
        "opencode",
        "OpenCode",
        &[".local/share/opencode"],
        Some("opencode"),
    ),
];

/// Codex keeps one line per session in an index file. Cheap to count, and it
/// makes "detected" mean more than "a directory exists".
fn codex_sessions() -> Option<usize> {
    let p = home().join(".codex").join("session_index.jsonl");
    let text = fs::read_to_string(p).ok()?;
    Some(text.lines().filter(|l| !l.trim().is_empty()).count())
}

/// `known` carries collector results the caller already has, so this does not
/// re-run them. `collect()` holds the codex and copilot readings by the time it
/// gets here, and re-reading a corpus that reaches gigabytes to ask a question
/// already answered was doubling the cost of every cycle. A caller with nothing
/// to hand (the one-shot `enroll`) passes an empty slice and pays for the read.
pub fn collect_assistants(known: &[(&str, bool)]) -> Vec<Value> {
    let known_has = |id: &str| known.iter().find(|(k, _)| *k == id).map(|(_, v)| *v);
    let h = home();
    let mut out: Vec<Value> = Vec::new();
    for (id, name, dirs, bin) in ASSISTANTS {
        let paths: Vec<String> = dirs
            .iter()
            .map(|d| h.join(d))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let binary = bin.map(which).unwrap_or(Value::Null);
        let detected = !paths.is_empty() || !binary.is_null();
        if !detected {
            // Not installed here. Listing it would be advertising, not reporting.
            continue;
        }
        let supported = matches!(
            *id,
            "claude-code" | "codex" | "copilot" | "devin" | "opencode"
        );

        // `detected` and `hasData` are different facts and the board must not
        // conflate them. A directory existing means the tool is installed; it
        // says nothing about whether anything is readable in it. Windsurf on
        // this machine is a real example: ~/.windsurf exists and holds zero
        // bytes of usage. Offering it as a data source you can select, and then
        // showing "no data", wastes the reader's click and their trust.
        let has_data = match *id {
            "claude-code" => claude_dir().join("projects").is_dir(),
            "codex" => known_has("codex").unwrap_or_else(|| {
                crate::codex::collect()["available"].as_bool().unwrap_or(false)
            }),
            // Copilot's two halves disagree: the CLI writes real token counts,
            // the IDE extension writes none. `hasData` is about this machine,
            // so it follows whichever half is actually installed here.
            "copilot" => known_has("copilot").unwrap_or_else(|| {
                crate::copilot::collect()["available"].as_bool().unwrap_or(false)
            }),
            "devin" => crate::devin::cli_db().exists(),
            // Same rule as codex and copilot: use the reading the caller
            // already has, and only pay for a second one when there is none.
            // OpenCode's store is 178 MB on the machine this was written
            // against, and querying it twice a cycle to answer a question
            // already answered is the cost this argument exists to avoid.
            "opencode" => known_has("opencode").unwrap_or_else(|| {
                crate::opencode::collect()["available"]
                    .as_bool()
                    .unwrap_or(false)
            }),
            _ => false,
        };

        let mut row = json!({
            "id": id,
            "name": name,
            "detected": detected,
            "supported": supported,
            "hasData": has_data,
            "paths": paths,
            "bin": binary,
            "note": match (supported, has_data) {
                (true, true) => "Read by this board.",
                (true, false) => "Supported, but it has not recorded anything on this machine yet.",
                _ => "Installed here. It does not write usage data this board can read.",
            },
        });
        if *id == "codex" && detected {
            if let Some(n) = codex_sessions() {
                row["sessions"] = json!(n);
            }
        }
        if *id == "devin" && detected {
            // Real local usage now: Devin CLI persists per-session credit/ACU
            // cost, read via sqlite3 without ever opening a conversation table.
            // Desktop sessions add activity only. See devin.rs.
            if let Some(extra) = crate::devin::activity() {
                for (k, v) in extra {
                    row[k] = v;
                }
            }
        }
        out.push(row);
    }
    out.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                !v["hasData"].as_bool().unwrap_or(false),
                !v["supported"].as_bool().unwrap_or(false),
                v["name"].as_str().unwrap_or("").to_string(),
            )
        };
        key(a).cmp(&key(b))
    });
    out
}

// ── spend, sessions, and what is driving them ───────────────────────────

fn ts(v: Option<&str>) -> Option<DateTime<Utc>> {
    transcripts::parse_iso(v?)
}

fn tok_totals(models: &IndexMap<String, Tok>) -> Value {
    let mut t = Tok::default();
    for m in models.values() {
        t.add(m);
    }
    json!({"in": t.tin, "out": t.out, "cacheRead": t.cr, "cacheWrite": t.cw5 + t.cw1})
}

struct Row {
    v: Value,
    est: f64,
    sub: f64,
    ctx: f64,
    hours: f64,
    requests: i64,
    tool_calls: i64,
    unpriced: i64,
    last: Option<String>,
    tokens: (i64, i64, i64, i64),
}

fn session_view(s: &Session, send_prompts: bool) -> Row {
    let (est, unpriced) = pricing::cost_of(s.models.iter());
    let (sub, _) = pricing::cost_of(s.sub.iter());
    let (ctx, _) = pricing::cost_of(s.ctx.iter());
    let hours = match (ts(s.first.as_deref()), ts(s.last.as_deref())) {
        (Some(f), Some(l)) => pricing::round((l - f).num_milliseconds() as f64 / 3_600_000.0, 2),
        _ => 0.0,
    };
    let mut models: Vec<(&String, &Tok)> = s.models.iter().collect();
    models.sort_by_key(|m| std::cmp::Reverse(m.1.out));
    let top: Vec<&String> = models.iter().take(4).map(|(m, _)| *m).collect();

    let mut t = Tok::default();
    for m in s.models.values() {
        t.add(m);
    }

    let project = s.project.clone().unwrap_or_default();
    let label = base_name(&project);
    Row {
        v: json!({
            "id": clip(&s.id, 8),
            // Session titles are written from the first prompt, so they are
            // prompt text by another name and follow the same rule.
            "title": if send_prompts { json!(s.title) } else { Value::Null },
            "project": if label.is_empty() { "-".to_string() } else { label },
            "path": s.project,
            "branch": s.branch,
            "entry": s.entry,
            "first": s.first,
            "last": s.last,
            "hours": hours,
            "requests": s.req,
            "toolCalls": s.tools,
            "maxContext": s.max_ctx,
            "models": top,
            "tokens": tok_totals(&s.models),
            "estUSD": pricing::round(est, 2),
            "subUSD": pricing::round(sub, 2),
            "ctxUSD": pricing::round(ctx, 2),
            "unpricedTokens": unpriced,
        }),
        est: pricing::round(est, 2),
        sub: pricing::round(sub, 2),
        ctx: pricing::round(ctx, 2),
        hours,
        requests: s.req,
        tool_calls: s.tools,
        unpriced,
        last: s.last.clone(),
        tokens: (t.tin, t.out, t.cr, t.cw5 + t.cw1),
    }
}

/// Independent characteristics of a set of sessions, not a breakdown.
///
/// These overlap on purpose - one expensive session can be subagent-heavy AND
/// long AND deep in context, so the percentages do not sum to 100. Each is
/// "this share of the estimate has this property", which is the only reading
/// that survives the overlap. Every threshold is stated in `note` so the number
/// cannot be quoted without its definition.
fn attribution(rows: &[&Row]) -> Value {
    let total = pricing::round(rows.iter().map(|r| r.est).sum::<f64>(), 4);
    let mut out = json!({
        "estUSD": total,
        "sessions": rows.len(),
        "requests": rows.iter().map(|r| r.requests).sum::<i64>(),
        "drivers": [],
    });
    if total <= 0.0 {
        return out;
    }
    let pct = |v: f64| -> i64 { pricing::round(v / total * 100.0, 0) as i64 };

    let sub_direct: f64 = rows.iter().map(|r| r.sub).sum();
    let sub_sessions: f64 = rows.iter().filter(|r| r.sub > 0.0).map(|r| r.est).sum();
    let ctx_direct: f64 = rows.iter().map(|r| r.ctx).sum();
    let long: f64 = rows
        .iter()
        .filter(|r| r.hours >= transcripts::LONG_SESSION_HOURS)
        .map(|r| r.est)
        .sum();
    let n_sub = rows.iter().filter(|r| r.sub > 0.0).count();
    let n_long = rows
        .iter()
        .filter(|r| r.hours >= transcripts::LONG_SESSION_HOURS)
        .count();
    let n = rows.len();
    let long_h = transcripts::LONG_SESSION_HOURS as i64;

    out["drivers"] = json!([
        {"key": "subagent-work", "pct": pct(sub_direct), "label": "ran as subagents",
         "note": "Requests marked as a sidechain - work a subagent did, not the main thread."},
        {"key": "subagent-sessions", "pct": pct(sub_sessions),
         "label": "from sessions that spawned subagents",
         "note": format!("{n_sub} of {n} sessions used at least one subagent. Each subagent \
                          runs its own requests, so one delegation can cost more than the turn that made it.")},
        {"key": "big-context", "pct": pct(ctx_direct),
         "label": format!("at over {}k context", transcripts::BIG_CONTEXT / 1000),
         "note": "Measured per request: input + cache read + cache write at the moment of the call. \
                  A long session is dearer per turn even when the cache is hot."},
        {"key": "long-sessions", "pct": pct(long),
         "label": format!("from sessions running {long_h}h+"),
         "note": format!("{n_long} of {n} sessions spanned {long_h} hours or more \
                          between first and last request - usually a background or loop session.")},
    ]);
    out
}

/// Where you are inside the rolling five-hour usage block.
///
/// Subscription usage is metered in five-hour blocks: the first request opens
/// one, and it runs five hours whatever happens next. That is a rule about
/// wall-clock time, not about an account, so it can be reconstructed from local
/// request timestamps alone.
///
/// What is NOT reconstructable is the limit itself. How much of the block you
/// have consumed is a fact about your plan, and no local file knows it. So this
/// reports what it measured and never shows a percentage of a limit it cannot
/// see.
fn blocks(idx: &Index) -> Value {
    if idx.minutes.is_empty() {
        return json!({"available": false, "hours": transcripts::BLOCK_HOURS});
    }
    let span = transcripts::BLOCK_HOURS * 60;
    let mut stamps: Vec<i64> = idx.minutes.keys().filter_map(|m| m.parse().ok()).collect();
    stamps.sort_unstable();

    struct B {
        start: i64,
        requests: i64,
        output: i64,
        last: i64,
    }
    let mut bs: Vec<B> = Vec::new();
    for m in stamps {
        if bs.last().map_or(true, |b| m >= b.start + span) {
            bs.push(B {
                start: m,
                requests: 0,
                output: 0,
                last: m,
            });
        }
        let b = bs.last_mut().unwrap();
        let key = m.to_string();
        b.requests += idx.minutes.get(&key).copied().unwrap_or(0);
        b.output += idx.out_minutes.get(&key).copied().unwrap_or(0);
        b.last = m;
    }

    let now_min = Utc::now().timestamp() / 60;
    let view = |b: &B| -> Value {
        let end = b.start + span;
        json!({
            "start": iso_from_secs(b.start * 60),
            "end": iso_from_secs(end * 60),
            "lastRequest": iso_from_secs(b.last * 60),
            "requests": b.requests,
            "outputTokens": b.output,
            "open": now_min < end,
            "minutesLeft": (end - now_min).max(0),
            "minutesUsed": (now_min - b.start).max(0).min(span),
        })
    };

    let recent: Vec<Value> = bs.iter().rev().take(14).rev().map(view).collect();
    let current = match recent.last() {
        Some(b) if b["open"].as_bool().unwrap_or(false) => b.clone(),
        _ => Value::Null,
    };
    let closed: Vec<&Value> = recent
        .iter()
        .filter(|b| !b["open"].as_bool().unwrap_or(false))
        .collect();
    let busiest = recent
        .iter()
        .max_by_key(|b| b["outputTokens"].as_i64().unwrap_or(0))
        .cloned()
        .unwrap_or(Value::Null);
    let median = if closed.is_empty() {
        0
    } else {
        let mut v: Vec<i64> = closed
            .iter()
            .map(|b| b["outputTokens"].as_i64().unwrap_or(0))
            .collect();
        v.sort_unstable();
        v[v.len() / 2]
    };

    // The seven-day window is a different animal: it resets on a schedule tied
    // to the account, and nothing on disk records when. A rolling seven days is
    // the honest substitute - a real number about a real window, just not the
    // one that resets.
    let week_cut = now_min - 7 * 24 * 60;
    let sum_since = |m: &IndexMap<String, i64>| -> i64 {
        m.iter()
            .filter(|(k, _)| k.parse::<i64>().map(|v| v >= week_cut).unwrap_or(false))
            .map(|(_, c)| *c)
            .sum()
    };

    json!({
        "available": true,
        "hours": transcripts::BLOCK_HOURS,
        "current": current,
        "recent": recent,
        "busiest": busiest,
        "closedMedianOutput": median,
        "rolling7d": {
            "requests": sum_since(&idx.minutes),
            "outputTokens": sum_since(&idx.out_minutes),
            "since": iso_from_secs(week_cut * 60),
        },
        "note": "Your own activity, reconstructed from request timestamps on this \
    machine. The five-hour block is wall-clock - the first request opens \
    it and it rolls over five hours later whatever you do - so the window \
    is measured, not estimated. What share of your plan it consumed is a \
    different question, and Anthropic answers it in the usage windows \
    above; this panel never guesses at it.",
        "weekNote": "A rolling seven days of your own work, not your plan's weekly window. \
    The real weekly window and the instant it resets are above, reported \
    by Anthropic. This is here to answer a different question: how hard \
    have you been going lately.",
    })
}

/// What was actually called, by name - the other half of a governance panel.
///
/// The configured side of that panel comes from settings files and says what an
/// agent MAY reach. This side says what it DID reach, and the two are shown
/// beside each other rather than merged: an MCP server mounted for six months
/// and never called is a fact only the pair can state.
fn tool_view(idx: &Index) -> Value {
    let rank = |m: &IndexMap<String, i64>| -> Vec<(String, i64)> {
        let mut v: Vec<(String, i64)> = m.iter().map(|(k, n)| (k.clone(), *n)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    };

    // `mcp__<server>__<tool>`. The server is everything up to the first double
    // underscore after the prefix; a tool name's own underscores are single.
    let mut by_server: IndexMap<String, (i64, Vec<String>)> = IndexMap::new();
    let mut mcp_calls = 0i64;
    let mut builtin = 0i64;
    for (name, n) in &idx.tools {
        match name.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
            Some((server, tool)) => {
                mcp_calls += n;
                let e = by_server.entry(server.to_string()).or_default();
                e.0 += n;
                e.1.push(tool.to_string());
            }
            None => builtin += n,
        }
    }
    let mut servers: Vec<Value> = by_server
        .iter()
        .map(|(name, (calls, tools))| json!({"server": name, "calls": calls, "tools": tools.len()}))
        .collect();
    servers.sort_by(|a, b| b["calls"].as_i64().cmp(&a["calls"].as_i64()));

    let rows = |v: Vec<(String, i64)>, key: &str| -> Vec<Value> {
        v.into_iter()
            .map(|(name, calls)| json!({key: name, "calls": calls}))
            .collect()
    };

    json!({
        "total": idx.tools.values().sum::<i64>(),
        "distinct": idx.tools.len(),
        "builtinCalls": builtin,
        "mcpCalls": mcp_calls,
        "byTool": rows(rank(&idx.tools), "name").into_iter().take(40).collect::<Vec<_>>(),
        "byServer": servers,
        "agents": rows(rank(&idx.agents), "agent"),
        "skills": rows(rank(&idx.skills), "skill"),
        "note": "Counted from the transcripts, all time, by tool name only. A tool's \
                 input - the command, the path, the prompt - is never read into the \
                 index this is built from.",
    })
}

/// Per-session usage and an estimated dollar value, from the transcripts.
pub fn collect_usage() -> Value {
    let (idx, scan) = transcripts::scan();
    let send_prompts = std::env::var("TOKENHUD_SEND_PROMPTS").unwrap_or_default() == "1";

    let mut rows: Vec<Row> = idx
        .sessions
        .values()
        .map(|s| session_view(s, send_prompts))
        .collect();
    rows.sort_by(|a, b| {
        b.last
            .as_deref()
            .unwrap_or("")
            .cmp(a.last.as_deref().unwrap_or(""))
    });

    let mut by_model: IndexMap<String, Tok> = IndexMap::new();
    for s in idx.sessions.values() {
        for (name, m) in &s.models {
            by_model.entry(name.clone()).or_default().add(m);
        }
    }
    let mut models: Vec<Value> = by_model
        .iter()
        .map(|(name, m)| {
            let est = pricing::cost(name, m);
            json!({
                "model": name,
                "estUSD": est.map(|e| pricing::round(e, 2)),
                "priced": est.is_some(),
                "input": m.tin, "output": m.out,
                "cacheRead": m.cr, "cacheWrite": m.cw5 + m.cw1,
            })
        })
        .collect();
    models.sort_by(|a, b| {
        let k = |v: &Value| v["estUSD"].as_f64().unwrap_or(0.0);
        k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut day_keys: Vec<&String> = idx.days.keys().collect();
    day_keys.sort();
    let days: Vec<Value> = day_keys
        .iter()
        .map(|day| {
            let per_model = &idx.days[*day];
            let (est, _) = pricing::cost_of(per_model.iter());
            let mut by = Map::new();
            for (n, m) in per_model {
                by.insert(
                    n.clone(),
                    json!(pricing::round(pricing::cost(n, m).unwrap_or(0.0), 2)),
                );
            }
            json!({"date": day, "estUSD": pricing::round(est, 2), "byModel": Value::Object(by)})
        })
        .collect();

    let now = Utc::now();
    let since = |hours: i64| -> Vec<&Row> {
        let cut = now - chrono::Duration::hours(hours);
        rows.iter()
            .filter(|r| ts(r.last.as_deref()).unwrap_or(now) >= cut)
            .collect()
    };
    let all: Vec<&Row> = rows.iter().collect();

    let mut tot = (0i64, 0i64, 0i64, 0i64);
    for r in &rows {
        tot.0 += r.tokens.0;
        tot.1 += r.tokens.1;
        tot.2 += r.tokens.2;
        tot.3 += r.tokens.3;
    }

    json!({
        "available": true,
        "scan": {
            "bytesTotal": scan.bytes_total,
            "bytesDone": scan.bytes_done,
            "complete": scan.complete,
            "files": scan.files,
            "readThisCycle": scan.read_this_cycle,
            "seconds": scan.seconds,
        },
        "pricing": pricing::card(),
        "blocks": blocks(&idx),
        "tools": tool_view(&idx),
        "allTime": {
            "estUSD": pricing::round(rows.iter().map(|r| r.est).sum::<f64>(), 2),
            "sessions": rows.len(),
            "requests": rows.iter().map(|r| r.requests).sum::<i64>(),
            "toolCalls": rows.iter().map(|r| r.tool_calls).sum::<i64>(),
            "tokens": {"in": tot.0, "out": tot.1, "cacheRead": tot.2, "cacheWrite": tot.3},
            "unpricedTokens": rows.iter().map(|r| r.unpriced).sum::<i64>(),
        },
        // Claude figures are priced from the card in pricing.rs at the
        // provider's published list rates - an estimate, and labelled one
        // everywhere it is rendered.
        "costBasis": crate::pricing::BASIS_LIST_PRICE,
        "byModel": models,
        // 90, matching the window the boards keep (`WINDOW_DAYS` in
        // server/src/share.rs, `slice(-90)` in shared/profile.mjs). At 60 the
        // token series ran thirty days deeper than the cost series, so days
        // 61-90 carried real tokens against `estUSD: 0` and every 90-day
        // spend figure quietly understated itself.
        "byDay": days
            .iter()
            .rev()
            .take(crate::pricing::BOARD_WINDOW_DAYS)
            .rev()
            .cloned()
            .collect::<Vec<_>>(),
        "windows": {
            "day": attribution(&since(24)),
            "week": attribution(&since(24 * 7)),
            "all": attribution(&all),
        },
        // Trimmed: the whole point is the ones worth looking at, and the
        // payload crosses a network every interval.
        "sessions": rows.iter().take(60).map(|r| r.v.clone()).collect::<Vec<_>>(),
    })
}

// ── the snapshot ────────────────────────────────────────────────────────

/// One full reading of this machine, ready to POST.
pub fn collect() -> Value {
    // Collected once and passed on. The integrations catalogue needs to know
    // which collectors found anything, and running them a second time to ask
    // would double the reading cost of the whole cycle to answer a question
    // already answered.
    let codex = crate::codex::collect();
    let copilot = crate::copilot::collect();
    let opencode = crate::opencode::collect();
    let available = |v: &Value| v["available"].as_bool().unwrap_or(false);
    let integrations = crate::integrations::collect(&[
        ("claude-code", claude_dir().join("projects").is_dir()),
        ("codex", available(&codex)),
        ("copilot-cli", available(&copilot)),
        ("devin", crate::devin::cli_db().exists()),
        ("opencode", available(&opencode)),
    ]);
    let integration_summary = crate::integrations::summary(&integrations);

    json!({
        "host": host_id(),
        "agentVersion": AGENT_VERSION,
        "collectedAt": now_iso(),
        "metrics": {
            "host": collect_host(),
            "processes": collect_processes(),
            "claude": collect_claude_stats(),
            "usage": collect_usage(),
            "limits": crate::limits::collect_limits(),
            "assistants": collect_assistants(&[
                ("codex", available(&codex)),
                ("copilot", available(&copilot)),
                ("opencode", available(&opencode)),
            ]),
            "integrations": integrations,
            "integrationSummary": integration_summary,
            "codex": codex,
            "copilot": copilot,
            "opencode": opencode,
            "governance": crate::governance::collect(),
            "projects": collect_claude_projects(),
            "daemon": collect_daemon(),
            "prompts": collect_prompts(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_is_matched_on_the_path_not_the_word() {
        assert!(looks_like_claude("/opt/claude-code/bin/claude --verbose"));
        assert!(looks_like_claude("/usr/local/bin/claude"));
        assert!(looks_like_claude("node /x/bin/claude --print"));
        assert!(!looks_like_claude("vim /Users/x/anthropic/claude-notes.md"));
        assert!(!looks_like_claude("grep claude ."));
    }

    #[test]
    fn codex_is_matched_on_the_binary_not_on_its_directory() {
        assert!(looks_like_codex(
            "/Applications/ChatGPT.app/Contents/Resources/codex"
        ));
        assert!(looks_like_codex(
            "/opt/homebrew/bin/codex exec 'do a thing'"
        ));
        // Every one of these is a path INSIDE ~/.codex, and none of them is a
        // running Codex. This is the case that makes the boundary check earn
        // its keep on a machine that actually runs Codex.
        assert!(!looks_like_codex(
            "node /Users/x/.codex/plugins/browser.mjs"
        ));
        assert!(!looks_like_codex("CODEX_HOME=/Users/x/.codex bash -lc ls"));
        assert!(!looks_like_codex("tail -f /Users/x/.codex/log/codex.log"));
        assert!(!looks_like_codex("/usr/local/bin/claude"));
    }

    #[test]
    fn a_flag_value_is_the_next_word() {
        assert_eq!(
            flag_value("claude --agent explore -p", "--agent").as_deref(),
            Some("explore")
        );
        assert_eq!(
            flag_value("claude --model opus", "--model").as_deref(),
            Some("opus")
        );
        assert_eq!(flag_value("claude --agent", "--agent"), None);
    }

    #[test]
    fn a_worktree_is_a_trailing_sha() {
        assert!(ends_in_sha("/Users/x/p/deadbeef"));
        assert!(ends_in_sha("/Users/x/p/aac8cdd"));
        // Not a sha: a real name that merely ends in hex-looking characters.
        assert!(!ends_in_sha("/Users/x/projects/thing-aac8cdd"));
        assert!(!ends_in_sha("/Users/x/projects/tokenhud"));
        assert!(!ends_in_sha("deadbeef"));
    }
}
