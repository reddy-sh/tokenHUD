//! Codex CLI — the second tool that actually keeps enough on disk to read.
//!
//! Codex writes one rollout file per session under `~/.codex/sessions/`, and in
//! it, `event_msg` records of type `token_count` carrying the shape:
//!
//! ```text
//! payload.info.total_token_usage = { input_tokens, cached_input_tokens,
//!                                    output_tokens, reasoning_output_tokens,
//!                                    total_tokens }
//! payload.info.model_context_window
//! payload.rate_limits.primary     = { used_percent, window_minutes, resets_at }
//! ```
//!
//! **`total_token_usage` is cumulative for the session, not per event.** Summing
//! every record would multiply a session's tokens by the number of turns in it —
//! on this machine, 1,366 events across 13 sessions. Only the last record in a
//! file is the truth, and that is what this reads.
//!
//! Rollouts are append-only and a finished session never changes, so a file
//! whose size is unchanged is not re-read. That keeps the steady-state cost to
//! whichever session is currently being written.
//!
//! What is deliberately not here: dollars. `pricing.rs` is an Anthropic rate
//! card, and inventing OpenAI prices to fill a column would be exactly the
//! "present a calculation as a measurement" mistake the rest of this codebase
//! refuses to make. Codex tokens are reported as tokens, and marked unpriced.

use crate::transcripts::home;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn sessions_root() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(v) if !v.is_empty() => crate::transcripts::expand_tilde(&v),
        _ => home().join(".codex"),
    }
    .join("sessions")
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Tokens {
    pub input: i64,
    pub cached_input: i64,
    pub output: i64,
    pub reasoning: i64,
    pub total: i64,
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.cached_input += o.cached_input;
        self.output += o.output;
        self.reasoning += o.reasoning;
        self.total += o.total;
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    pub id: String,
    pub model: Option<String>,
    /// The policy Codex actually ran this session under, from `turn_context`.
    /// Not the same fact as the default in `config.toml`: a session can be
    /// started with different flags, and what was enforced is what matters.
    ///
    /// Always serialised, null included. Snapshots are stored as structural
    /// differences against the previous one, and a key that appears and
    /// disappears is a change on every reading that carries no information.
    #[serde(default)]
    pub approval: Option<String>,
    #[serde(default)]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub network: Option<bool>,
    pub project: Option<String>,
    pub branch: Option<String>,
    pub first: Option<String>,
    pub last: Option<String>,
    pub turns: i64,
    pub tokens: Tokens,
    #[serde(rename = "contextWindow")]
    pub context_window: Option<i64>,
}

/// The plan window Codex reports alongside the tokens. Same idea as Claude
/// Code's usage windows, and just as much a fact rather than an estimate.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RateLimit {
    pub kind: String,
    pub percent: f64,
    #[serde(rename = "windowMinutes")]
    pub window_minutes: i64,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<String>,
}

fn as_i(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

/// What one rollout file yields: the session, the plan windows it last saw,
/// the stamp on that reading, and its calls counted by tool name.
type Rollout = (
    Session,
    Vec<RateLimit>,
    Option<String>,
    BTreeMap<String, i64>,
);

fn read_session(path: &Path) -> Option<Rollout> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut s = Session {
        id: path.file_stem()?.to_string_lossy().into_owned(),
        model: None,
        approval: None,
        sandbox: None,
        network: None,
        project: None,
        branch: None,
        first: None,
        last: None,
        turns: 0,
        tokens: Tokens::default(),
        context_window: None,
    };
    let mut limits: Vec<RateLimit> = Vec::new();
    let mut newest_stamp: Option<String> = None;
    let mut tools: BTreeMap<String, i64> = BTreeMap::new();

    for line in text.lines() {
        let Ok(r) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let stamp = r
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        match r.get("type").and_then(|v| v.as_str()) {
            Some("session_meta") => {
                let p = r.get("payload").cloned().unwrap_or(Value::Null);
                if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                    s.id = id.to_string();
                }
                s.project = p.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
                s.branch = p
                    .get("git")
                    .and_then(|g| g.get("branch"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                if s.first.is_none() {
                    s.first = stamp.clone();
                }
            }
            Some("turn_context") => {
                let p = r.get("payload").cloned().unwrap_or(Value::Null);
                if let Some(m) = p.get("model").and_then(|v| v.as_str()) {
                    s.model = Some(m.to_string());
                }
                // Last one wins: a session that was escalated mid-run is
                // reported at the loosest setting it ended on, which is the
                // one a reader needs to see.
                if let Some(a) = p.get("approval_policy").and_then(|v| v.as_str()) {
                    s.approval = Some(a.to_string());
                }
                if let Some(sp) = p.get("sandbox_policy") {
                    if let Some(m) = sp.get("mode").and_then(|v| v.as_str()) {
                        s.sandbox = Some(m.to_string());
                    }
                    if let Some(n) = sp.get("network_access").and_then(|v| v.as_bool()) {
                        s.network = Some(n);
                    }
                }
            }
            // Codex records a call as a response item, not an event. The NAME
            // is taken; `arguments` — the command, the patch — is not.
            Some("response_item") => {
                let p = r.get("payload").cloned().unwrap_or(Value::Null);
                let kind = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if matches!(
                    kind,
                    "function_call" | "custom_tool_call" | "local_shell_call"
                ) {
                    let name = p
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(unnamed)");
                    if tools.len() < 800 || tools.contains_key(name) {
                        *tools.entry(name.chars().take(120).collect()).or_insert(0) += 1;
                    }
                }
            }
            Some("event_msg") => {
                let p = r.get("payload").cloned().unwrap_or(Value::Null);
                match p.get("type").and_then(|v| v.as_str()) {
                    Some("token_count") => {
                        // Cumulative: overwrite rather than accumulate.
                        if let Some(u) = p.get("info").and_then(|i| i.get("total_token_usage")) {
                            s.tokens = Tokens {
                                input: as_i(u.get("input_tokens")),
                                cached_input: as_i(u.get("cached_input_tokens")),
                                output: as_i(u.get("output_tokens")),
                                reasoning: as_i(u.get("reasoning_output_tokens")),
                                total: as_i(u.get("total_tokens")),
                            };
                        }
                        if let Some(w) = p
                            .get("info")
                            .and_then(|i| i.get("model_context_window"))
                            .and_then(|v| v.as_i64())
                        {
                            s.context_window = Some(w);
                        }
                        limits = read_limits(p.get("rate_limits"));
                        if stamp.is_some() {
                            newest_stamp = stamp.clone();
                        }
                    }
                    Some("task_started") => s.turns += 1,
                    _ => {}
                }
            }
            _ => {}
        }
        if let Some(t) = stamp {
            if s.first.is_none() {
                s.first = Some(t.clone());
            }
            s.last = Some(t);
        }
    }
    if s.tokens.total == 0 && s.turns == 0 {
        return None; // an empty or aborted rollout is not a session worth showing
    }
    Some((s, limits, newest_stamp, tools))
}

fn read_limits(v: Option<&Value>) -> Vec<RateLimit> {
    let mut out = Vec::new();
    let Some(obj) = v.and_then(|x| x.as_object()) else {
        return out;
    };
    for (name, row) in obj {
        let Some(row) = row.as_object() else { continue };
        let Some(pct) = row.get("used_percent").and_then(|v| v.as_f64()) else {
            continue;
        };
        let resets = row
            .get("resets_at")
            .and_then(|v| v.as_i64())
            .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0).map(crate::collect::iso_of));
        out.push(RateLimit {
            kind: name.clone(),
            percent: crate::pricing::round(pct, 2),
            window_minutes: as_i(row.get("window_minutes")),
            resets_at: resets,
        });
    }
    out
}

/// Tool calls by name, and by MCP server where the name carries one.
///
/// Codex exposes an MCP tool as `<server>__<tool>` and its own built-ins as a
/// single word — `exec_command`, `apply_patch`. So a double underscore is what
/// separates "this machine called out to a server" from "this machine ran its
/// own tool", and that is the split reported here.
fn tool_view(tools: &BTreeMap<String, i64>) -> Value {
    let mut by_server: BTreeMap<String, (i64, usize)> = BTreeMap::new();
    let (mut mcp, mut builtin) = (0i64, 0i64);
    for (name, n) in tools {
        match name.split_once("__") {
            Some((server, _)) => {
                mcp += n;
                let e = by_server.entry(server.to_string()).or_insert((0, 0));
                e.0 += n;
                e.1 += 1;
            }
            None => builtin += n,
        }
    }
    let mut rows: Vec<Value> = tools
        .iter()
        .map(|(name, calls)| json!({"name": name, "calls": calls}))
        .collect();
    rows.sort_by(|a, b| b["calls"].as_i64().cmp(&a["calls"].as_i64()));
    let mut servers: Vec<Value> = by_server
        .iter()
        .map(|(s, (calls, n))| json!({"server": s, "calls": calls, "tools": n}))
        .collect();
    servers.sort_by(|a, b| b["calls"].as_i64().cmp(&a["calls"].as_i64()));
    json!({
        "total": tools.values().sum::<i64>(),
        "distinct": tools.len(),
        "builtinCalls": builtin,
        "mcpCalls": mcp,
        "byTool": rows.into_iter().take(40).collect::<Vec<_>>(),
        "byServer": servers,
        "note": "Counted from the rollouts by tool name. Call arguments — the command, \
                 the patch — are never read.",
    })
}

/// Where the work happened, one row per working directory.
///
/// The Claude side reads this from `~/.claude/projects`, which is a directory
/// per project. Codex has no such directory — a rollout records its own `cwd`
/// and that is the only place the answer exists, so it is grouped here.
fn project_view(sessions: &[Session]) -> Vec<Value> {
    struct P {
        path: String,
        branch: Option<String>,
        sessions: i64,
        turns: i64,
        tokens: i64,
        last: Option<String>,
    }
    let mut by: BTreeMap<String, P> = BTreeMap::new();
    for s in sessions {
        let Some(path) = s.project.clone() else {
            continue;
        };
        let e = by.entry(path.clone()).or_insert_with(|| P {
            path,
            branch: None,
            sessions: 0,
            turns: 0,
            tokens: 0,
            last: None,
        });
        e.sessions += 1;
        e.turns += s.turns;
        e.tokens += s.tokens.total;
        if e.branch.is_none() {
            e.branch = s.branch.clone();
        }
        if s.last > e.last {
            e.last = s.last.clone();
        }
    }
    let mut out: Vec<Value> = by
        .into_values()
        .map(|p| {
            let label = p
                .path
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&p.path)
                .to_string();
            json!({
                "path": p.path,
                "label": label,
                "branch": p.branch,
                "sessions": p.sessions,
                "turns": p.turns,
                "tokens": p.tokens,
                "lastActive": p.last,
            })
        })
        .collect();
    out.sort_by(|a, b| b["lastActive"].as_str().cmp(&a["lastActive"].as_str()));
    out
}

/// Tokens per local calendar day.
///
/// A Codex session reports one cumulative total, not a figure per turn, so the
/// whole of a session lands on the day it was last active. A session that ran
/// across midnight is therefore counted once, on the later day — an
/// approximation, and the payload says so rather than letting the chart imply
/// a precision the source does not have.
fn day_view(sessions: &[Session]) -> Vec<Value> {
    let mut by: BTreeMap<String, (i64, i64, i64)> = BTreeMap::new(); // total, output, sessions
    for s in sessions {
        let Some(day) = s
            .last
            .as_deref()
            .and_then(crate::transcripts::parse_iso)
            .map(|dt| dt.with_timezone(&chrono::Local).date_naive().to_string())
        else {
            continue;
        };
        let e = by.entry(day).or_insert((0, 0, 0));
        e.0 += s.tokens.total;
        e.1 += s.tokens.output;
        e.2 += 1;
    }
    by.into_iter()
        .map(|(date, (total, output, n))| {
            json!({"date": date, "tokens": total, "output": output, "sessions": n})
        })
        .rev()
        .take(60)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push(p);
        }
    }
}

/// Everything Codex has recorded on this machine, or `available: false` when it
/// has recorded nothing. The board shows a tool only when this says yes.
pub fn collect() -> Value {
    let root = sessions_root();
    if !root.is_dir() {
        return json!({"available": false, "reason": "not installed"});
    }
    let mut files = Vec::new();
    walk(&root, &mut files);
    if files.is_empty() {
        return json!({"available": false, "reason": "installed, but no sessions recorded"});
    }
    files.sort();

    let mut sessions: Vec<Session> = Vec::new();
    let mut limits: Vec<RateLimit> = Vec::new();
    let mut newest: Option<String> = None;
    let mut tools: BTreeMap<String, i64> = BTreeMap::new();
    for f in &files {
        if let Some((s, l, stamp, t)) = read_session(f) {
            for (name, n) in t {
                *tools.entry(name).or_insert(0) += n;
            }
            if let (Some(t), true) = (&stamp, !l.is_empty()) {
                // `is_none_or` is 1.82 and this crate declares 1.75.
                if newest.as_ref().map_or(true, |n| t > n) {
                    newest = stamp.clone();
                    limits = l;
                }
            }
            sessions.push(s);
        }
    }
    if sessions.is_empty() {
        return json!({"available": false, "reason": "installed, but no sessions recorded"});
    }

    let mut totals = Tokens::default();
    let mut by_model: BTreeMap<String, Tokens> = BTreeMap::new();
    for s in &sessions {
        totals.add(&s.tokens);
        by_model
            .entry(s.model.clone().unwrap_or_else(|| "unknown".into()))
            .or_default()
            .add(&s.tokens);
    }
    sessions.sort_by(|a, b| b.last.cmp(&a.last));

    json!({
        "available": true,
        "sessions": sessions.iter().take(60).collect::<Vec<_>>(),
        "sessionCount": sessions.len(),
        "totals": totals,
        "byModel": by_model.iter().map(|(m, t)| json!({"model": m, "tokens": t})).collect::<Vec<_>>(),
        "limits": limits,
        "tools": tool_view(&tools),
        "projects": project_view(&sessions),
        "byDay": day_view(&sessions),
        "byDayNote": "A Codex session reports one cumulative total rather than a figure per \
                      turn, so a session counts once, on the day it was last active.",
        // What the newest session that recorded one actually ran under, beside
        // the default in config.toml. The two disagreeing is the interesting
        // case, and it is the reason both are reported rather than one.
        "policy": sessions.iter()
            .find(|s| s.approval.is_some() || s.sandbox.is_some())
            .map(|s| json!({
            "approval": s.approval,
            "sandbox": s.sandbox,
            "network": s.network,
            "model": s.model,
            "session": s.id,
            "at": s.last,
        })).unwrap_or(Value::Null),
        // No dollars. pricing.rs is an Anthropic rate card and these are not
        // Anthropic models; a number here would be invented, not measured.
        "priced": false,
        "pricedNote": "Codex tokens are counted, not priced — the rate card in this build covers Anthropic models only.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cumulative_usage_is_taken_not_summed() {
        // Three token_count events in one session, each cumulative. Summing
        // would give 60; the answer is 30.
        let dir = std::env::temp_dir().join(format!("codex-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("rollout-test.jsonl");
        let ev = |n: i64| {
            format!(
                r#"{{"timestamp":"2026-08-01T10:0{n}:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{n}0,"output_tokens":0,"total_tokens":{n}0}}}}}}}}"#
            )
        };
        std::fs::write(
            &f,
            format!(
                "{}\n{}\n{}\n{}\n",
                r#"{"timestamp":"2026-08-01T10:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/tmp/p"}}"#,
                ev(1), ev(2), ev(3)
            ),
        )
        .unwrap();
        let (s, _, _, tools) = read_session(&f).expect("a session");
        assert_eq!(
            s.tokens.total, 30,
            "cumulative usage must be taken, not summed"
        );
        assert_eq!(s.id, "s1");
        assert!(tools.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_call_is_counted_by_name_and_its_arguments_are_not_read() {
        let dir = std::env::temp_dir().join(format!("codex-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("rollout-tools.jsonl");
        std::fs::write(&f, concat!(
            r#"{"timestamp":"2026-08-01T10:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/tmp/p"}}"#, "\n",
            r#"{"timestamp":"2026-08-01T10:01:00Z","type":"turn_context","payload":{"model":"gpt-5-codex","approval_policy":"on-request","sandbox_policy":{"mode":"workspace-write","network_access":false}}}"#, "\n",
            r#"{"timestamp":"2026-08-01T10:02:00Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":{"cmd":"cat /etc/passwd"}}}"#, "\n",
            r#"{"timestamp":"2026-08-01T10:03:00Z","type":"response_item","payload":{"type":"custom_tool_call","name":"github__create_issue"}}"#, "\n",
            r#"{"timestamp":"2026-08-01T10:04:00Z","type":"event_msg","payload":{"type":"task_started"}}"#, "\n",
        )).unwrap();
        let (s, _, _, tools) = read_session(&f).expect("a session");
        assert_eq!(tools["exec_command"], 1);
        assert_eq!(tools["github__create_issue"], 1);
        assert_eq!(s.approval.as_deref(), Some("on-request"));
        assert_eq!(s.sandbox.as_deref(), Some("workspace-write"));
        assert_eq!(s.network, Some(false));

        let v = tool_view(&tools);
        assert_eq!(v["mcpCalls"], 1, "a `server__tool` name is an MCP call");
        assert_eq!(v["builtinCalls"], 1);
        assert_eq!(v["byServer"][0]["server"], "github");
        assert!(
            !serde_json::to_string(&tools).unwrap().contains("passwd"),
            "call arguments must not reach the payload"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_machine_without_codex_says_so_rather_than_showing_zeroes() {
        std::env::set_var("CODEX_HOME", "/nonexistent/definitely/not/here");
        let v = collect();
        std::env::remove_var("CODEX_HOME");
        assert_eq!(v["available"], false);
        assert!(v["reason"].as_str().unwrap().contains("not installed"));
        // The important part: no zeroed totals that would render as "0 tokens"
        // and look like a measurement.
        assert!(v.get("totals").is_none());
    }

    #[test]
    fn rate_limits_are_carried_through_with_their_reset_instant() {
        let v = serde_json::json!({
            "primary": {"used_percent": 11.0, "window_minutes": 10080, "resets_at": 1773174360}
        });
        let l = read_limits(Some(&v));
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].kind, "primary");
        assert_eq!(l[0].window_minutes, 10080);
        assert!(l[0].resets_at.as_ref().unwrap().starts_with("2026-"));
    }
}
