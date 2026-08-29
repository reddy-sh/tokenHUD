//! Rate-limit windows - the real ones, read from Claude Code's own cache.
//!
//! Three things shape this module, and all three are honesty problems rather
//! than engineering ones:
//!
//!   · **It is a cache, so it has an age.** Measured from `fetchedAtMs`, never
//!     from the file's mtime, which moves when unrelated settings are written
//!     and would make a stale number look fresh.
//!   · **A reset instant does not go stale.** `resets_at` is absolute; the two
//!     degrade separately and the payload keeps them separable.
//!   · **The file holds far more than this, and the omissions are deliberate.**
//!     `utilization.spend`, `projects`, `oauthAccount` are never read. Keys are
//!     read BY NAME, never enumerated - `utilization` carries unshipped internal
//!     buckets under rotating codenames, and a panel built by iterating that
//!     dict would one day grow a meter labelled "amber ladder".
//!
//! It never writes to that file. It is Claude Code's live configuration, we do
//! not own it, and a clobbering write would take the user's MCP servers with it.

use crate::transcripts::{expand_tilde, home, state_dir};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

/// The CLI's own reader discards this cache once it is an hour old. Matching
/// that means the board calls stale exactly what Claude Code calls stale.
pub const STALE_AFTER: i64 = 3600;

fn label_for(kind: &str) -> Option<&'static str> {
    match kind {
        "session" => Some("Session (5h)"),
        "weekly_all" => Some("Weekly (7 day)"),
        _ => None,
    }
}

/// A per-install salt for the account hash.
///
/// Without it, a truncated hash of the account uuid is the same string on every
/// machine that account touches - a stable cross-host identifier travelling in
/// a payload that crosses a network. The point of the hash is to answer "is
/// this still the same account as last reading" on ONE board.
fn salt() -> String {
    let path = state_dir().join("salt");
    if let Ok(s) = fs::read_to_string(&path) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let value = random_hex(16);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::write(&path, &value).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
    }
    value
}

/// 16 bytes of OS randomness, hex. `getrandom` rather than a PRNG crate: the
/// salt is written once and a dependency for one call is not worth carrying.
/// Pub because the install id (main.rs) is minted the same way for the same
/// reasons.
pub fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    let ok = unsafe { libc::getentropy(buf.as_mut_ptr() as *mut libc::c_void, buf.len()) } == 0;
    if !ok {
        // Never silently produce a constant salt: fall back to something that
        // still differs per install rather than to zeros.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id() as u128;
        let mut h = Sha256::new();
        h.update(t.to_le_bytes());
        h.update(pid.to_le_bytes());
        buf.copy_from_slice(&h.finalize()[..n]);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(v) = std::env::var("TOKENHUD_CLAUDE_JSON") {
        if !v.is_empty() {
            out.push(expand_tilde(&v));
        }
    }
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !v.is_empty() {
            out.push(expand_tilde(&v).join(".claude.json"));
        }
    }
    out.push(home().join(".claude.json"));
    out
}

enum Found {
    Data(Value),
    Unreadable,
    Absent,
}

/// Read the config, tolerating the moment it is being rewritten.
///
/// Claude Code rewrites this file while running. A read landing mid-write gets
/// a parse error, which is a transient fact about timing and not a fact about
/// the machine - so it is retried once before being reported.
fn load() -> Found {
    for path in candidates() {
        if !path.is_file() {
            continue;
        }
        for attempt in 0..2 {
            match fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(v) => return Found::Data(v),
                    Err(_) if attempt == 0 => {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        continue;
                    }
                    Err(_) => return Found::Unreadable,
                },
                Err(_) => return Found::Unreadable,
            }
        }
    }
    Found::Absent
}

fn label(row: &Map<String, Value>) -> String {
    let kind = row.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(l) = label_for(kind) {
        return l.to_string();
    }
    if kind == "weekly_scoped" {
        // Only the display name the server itself supplied. The neighbouring
        // keys are internal bucket codenames that rotate, and nothing on disk
        // maps them to a model - inventing that mapping would put a made-up
        // model name on the board.
        let name = row
            .get("scope")
            .and_then(|s| s.get("model"))
            .and_then(|m| m.get("display_name"))
            .and_then(|v| v.as_str());
        return match name {
            Some(n) => format!("Weekly · {n}"),
            None => "Weekly · scoped".to_string(),
        };
    }
    if kind.is_empty() {
        return title_case("window");
    }
    title_case(&kind.replace('_', " "))
}

fn title_case(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn rows(util: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(list) = util.get("limits").and_then(|v| v.as_array()) {
        for row in list {
            let row = match row.as_object() {
                Some(o) => o,
                None => continue,
            };
            let pct = row
                .get("percent")
                .and_then(|v| v.as_f64())
                .map(|f| f as i64);
            out.push(json!({
                "kind": row.get("kind").cloned().unwrap_or(Value::Null),
                "group": row.get("group").cloned().unwrap_or(Value::Null),
                "label": label(row),
                "percent": pct,
                "severity": row.get("severity").and_then(|v| v.as_str()).unwrap_or("normal"),
                "resetsAt": row.get("resets_at").cloned().unwrap_or(Value::Null),
                "active": row.get("is_active").and_then(|v| v.as_bool()).unwrap_or(false),
            }));
        }
    }
    if !out.is_empty() {
        return out;
    }

    // Older CLIs wrote only these two. Same numbers, less structure.
    for (key, kind) in [("five_hour", "session"), ("seven_day", "weekly_all")] {
        let w = match util.get(key) {
            Some(w) if w.is_object() => w,
            _ => continue,
        };
        let pct = w
            .get("utilization")
            .and_then(|v| v.as_f64())
            .map(|f| f as i64);
        out.push(json!({
            "kind": kind,
            "group": kind.split('_').next().unwrap_or(kind),
            "label": label_for(kind).unwrap_or(kind),
            "percent": pct,
            "severity": "normal",
            "resetsAt": w.get("resets_at").cloned().unwrap_or(Value::Null),
            "active": kind == "session",
        }));
    }
    out
}

fn unavailable(reason: &str) -> Value {
    json!({"available": false, "reason": reason, "staleAfterSeconds": STALE_AFTER})
}

/// The plan's usage windows as Anthropic last reported them.
pub fn collect_limits() -> Value {
    let data = match load() {
        Found::Absent => return unavailable("absent"),
        Found::Unreadable => return unavailable("unreadable"),
        Found::Data(v) => v,
    };

    let cache = match data.get("cachedUsageUtilization") {
        Some(c) if c.is_object() => c,
        _ => return unavailable("absent"),
    };
    let util = match cache.get("utilization") {
        Some(u) if u.is_object() => u,
        _ => return unavailable("absent"),
    };

    let (mut fetched_at, mut age) = (Value::Null, Value::Null);
    if let Some(ms) = cache.get("fetchedAtMs").and_then(|v| v.as_f64()) {
        if let Some(dt) = chrono::DateTime::from_timestamp_millis(ms as i64) {
            fetched_at = json!(crate::collect::iso_of(dt));
        }
        let now = chrono::Utc::now().timestamp() as f64;
        age = json!((now - ms / 1000.0) as i64);
    }

    let account_hash = cache
        .get("accountUuid")
        .and_then(|v| v.as_str())
        .map(|acct| {
            let mut h = Sha256::new();
            h.update(salt().as_bytes());
            h.update(acct.as_bytes());
            format!("{:x}", h.finalize())[..12].to_string()
        })
        .map(Value::from)
        .unwrap_or(Value::Null);

    json!({
        "available": true,
        // Named so the board can say where a number came from without the
        // reader having to take it on trust.
        "source": "~/.claude.json:cachedUsageUtilization",
        "fetchedAt": fetched_at,
        "ageSeconds": age,
        "staleAfterSeconds": STALE_AFTER,
        "accountHash": account_hash,
        "windows": rows(util),
        // Deliberately not computed here: a snapshot can sit in the store for
        // minutes before a browser reads it, and a countdown baked in at
        // collection time would be wrong by exactly that long.
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scoped_window_uses_only_the_supplied_display_name() {
        let row: Map<String, Value> = serde_json::from_str(
            r#"{"kind":"weekly_scoped","scope":{"model":{"display_name":"Opus"}}}"#,
        )
        .unwrap();
        assert_eq!(label(&row), "Weekly · Opus");
        let bare: Map<String, Value> = serde_json::from_str(r#"{"kind":"weekly_scoped"}"#).unwrap();
        assert_eq!(label(&bare), "Weekly · scoped");
    }

    #[test]
    fn an_unknown_kind_is_titled_not_invented() {
        let row: Map<String, Value> = serde_json::from_str(r#"{"kind":"amber_ladder"}"#).unwrap();
        assert_eq!(label(&row), "Amber Ladder");
    }

    #[test]
    fn the_old_shape_still_reads() {
        let util: Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":42,"resets_at":"2026-08-23T03:00:00Z"}}"#,
        )
        .unwrap();
        let r = rows(&util);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["percent"], 42);
        assert_eq!(r[0]["label"], "Session (5h)");
        assert_eq!(r[0]["active"], true);
    }
}
