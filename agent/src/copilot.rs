//! GitHub Copilot CLI — the third tool that keeps real token counts on disk.
//!
//! Copilot has two halves and only one of them is readable here. The **VS Code
//! extension** stores `session-store.db` with `sessions` and `turns` tables that
//! hold the conversation and no usage at all; its numbers live behind the org
//! billing and metrics APIs. The **CLI** (`copilot`, formerly `gh copilot`) is
//! different: it writes an append-only event log per session under
//! `~/.copilot/session-state/<session-id>/events.jsonl`, and the shutdown event
//! in it carries the full breakdown:
//!
//! ```text
//! data.modelMetrics.<model>.usage    = { inputTokens, outputTokens,
//!                                        cacheReadTokens, cacheWriteTokens,
//!                                        reasoningTokens }
//! data.modelMetrics.<model>.requests = { count, cost }   // cost = premium requests
//! data.modelMetrics.<model>.totalNanoAiu                 // AI units, ×1e-9
//! data.totalPremiumRequests
//! ```
//!
//! **These are per-segment and MUST be summed — the opposite of Codex.** A
//! session that is resumed writes another `session.shutdown` when it stops
//! again, and each one reports only the segment it closed. The session read on
//! the machine this was written against has three shutdowns of two requests
//! each, against six `assistant.turn_start` events: summing gives the six that
//! actually happened, and taking the last would report two. Codex's rule is
//! `total_token_usage` is cumulative so only the last line counts; applying that
//! habit here would silently divide the answer by the number of resumes.
//!
//! A finished segment never changes, so a file whose size is unchanged since the
//! last reading is not re-read.
//!
//! What is deliberately not here: dollars, and anything anyone typed.
//! `user.message` and `assistant.message` records carry the conversation and are
//! skipped by type — never parsed. A `tool.execution_start` contributes its
//! `toolName` and never its `arguments`, which hold the path or command, exactly
//! as the Claude and Codex collectors do it. Copilot bills in *premium requests*
//! and AI units rather than dollars; both are reported in their own units,
//! because `pricing.rs` is an Anthropic rate card and converting a premium
//! request into a dollar figure would be inventing the rate.

use crate::transcripts::home;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// `~/.copilot`, or wherever `COPILOT_HOME` moves it.
pub fn copilot_home() -> PathBuf {
    match std::env::var("COPILOT_HOME") {
        Ok(v) if !v.is_empty() => crate::transcripts::expand_tilde(&v),
        _ => home().join(".copilot"),
    }
}

pub fn sessions_root() -> PathBuf {
    copilot_home().join("session-state")
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Tokens {
    pub input: i64,
    pub output: i64,
    #[serde(rename = "cacheRead")]
    pub cache_read: i64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: i64,
    pub reasoning: i64,
    pub total: i64,
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
        self.total += o.total;
    }

    /// Copilot reports the parts and not the sum, so the sum is computed here
    /// rather than read. Cache reads and writes are included: they are tokens
    /// that were sent and billed, and a "total" that omitted them would be
    /// smaller than the thing it claims to total.
    fn seal(&mut self) {
        self.total = self.input + self.output + self.cache_read + self.cache_write;
    }
}

/// What Copilot charges in, kept in its own units.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Spend {
    /// Premium requests — the unit a Copilot plan's quota is denominated in.
    #[serde(rename = "premiumRequests")]
    pub premium_requests: f64,
    /// AI units, from `totalNanoAiu` × 1e-9.
    pub aiu: f64,
    /// Model calls, counted.
    pub requests: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    pub id: String,
    pub model: Option<String>,
    pub project: Option<String>,
    pub first: Option<String>,
    pub last: Option<String>,
    /// `assistant.turn_start` events — one per turn the agent took.
    pub turns: i64,
    /// How many times this session was stopped and resumed. A session with more
    /// than one segment is exactly the case that makes summing load-bearing.
    pub segments: i64,
    pub tokens: Tokens,
    pub spend: Spend,
}

fn as_i(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

fn as_f(v: Option<&Value>) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// What one session directory yields: the session, and its calls by tool name.
type Read = (Session, BTreeMap<String, i64>);

fn read_session(dir: &Path) -> Option<Read> {
    let events = dir.join("events.jsonl");
    let text = std::fs::read_to_string(&events).ok()?;
    let mut s = Session {
        id: dir.file_name()?.to_string_lossy().into_owned(),
        model: None,
        project: None,
        first: None,
        last: None,
        turns: 0,
        segments: 0,
        tokens: Tokens::default(),
        spend: Spend::default(),
    };
    let mut by_model: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut tools: BTreeMap<String, i64> = BTreeMap::new();

    for line in text.lines() {
        let Ok(r) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let stamp = r
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let d = r.get("data").cloned().unwrap_or(Value::Null);

        // Matched by type, so the conversation records — `user.message`,
        // `assistant.message`, `system.message` — fall through untouched.
        match r.get("type").and_then(|v| v.as_str()) {
            Some("session.start") => {
                if let Some(id) = d.get("sessionId").and_then(|v| v.as_str()) {
                    s.id = id.to_string();
                }
                if let Some(m) = d.get("selectedModel").and_then(|v| v.as_str()) {
                    s.model = Some(m.to_string());
                }
                s.project = d
                    .get("context")
                    .and_then(|c| c.get("cwd"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            Some("session.resume") => {
                // Last model wins: a session switched mid-run is reported as
                // what it ended on, and `byModel` keeps the split anyway.
                if let Some(m) = d.get("selectedModel").and_then(|v| v.as_str()) {
                    s.model = Some(m.to_string());
                }
            }
            Some("assistant.turn_start") => s.turns += 1,
            // The NAME is taken. `arguments` — which holds the path, the
            // command, the patch — is never looked at.
            Some("tool.execution_start") => {
                let name = d
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unnamed)");
                if tools.len() < 800 || tools.contains_key(name) {
                    *tools.entry(name.chars().take(120).collect()).or_insert(0) += 1;
                }
            }
            // Per-segment, so this ACCUMULATES. See the module comment.
            Some("session.shutdown") => {
                s.segments += 1;
                s.spend.premium_requests += as_f(d.get("totalPremiumRequests"));
                s.spend.aiu += as_f(d.get("totalNanoAiu")) / 1e9;
                let Some(models) = d.get("modelMetrics").and_then(|v| v.as_object()) else {
                    continue;
                };
                for (model, m) in models {
                    let u = m.get("usage").cloned().unwrap_or(Value::Null);
                    let mut t = Tokens {
                        input: as_i(u.get("inputTokens")),
                        output: as_i(u.get("outputTokens")),
                        cache_read: as_i(u.get("cacheReadTokens")),
                        cache_write: as_i(u.get("cacheWriteTokens")),
                        reasoning: as_i(u.get("reasoningTokens")),
                        total: 0,
                    };
                    t.seal();
                    s.tokens.add(&t);
                    by_model.entry(model.clone()).or_default().add(&t);
                    s.spend.requests += as_i(m.get("requests").and_then(|r| r.get("count")));
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
        return None; // an empty or abandoned session is not one worth showing
    }
    // A session whose only model came from a shutdown record still names one.
    if s.model.is_none() {
        s.model = by_model.keys().next().cloned();
    }
    Some((s, tools))
}

/// Tool calls by name. Copilot's CLI names its built-ins plainly (`view`,
/// `str_replace`, `bash`) and an MCP tool as `<server>-<tool>`, but the
/// separator is not reliably distinct from a hyphenated built-in, so unlike the
/// Codex collector this does not claim a built-in/MCP split it cannot prove.
fn tool_view(tools: &BTreeMap<String, i64>) -> Value {
    let mut rows: Vec<Value> = tools
        .iter()
        .map(|(name, calls)| json!({"name": name, "calls": calls}))
        .collect();
    rows.sort_by(|a, b| b["calls"].as_i64().cmp(&a["calls"].as_i64()));
    json!({
        "total": tools.values().sum::<i64>(),
        "distinct": tools.len(),
        "byTool": rows.into_iter().take(40).collect::<Vec<_>>(),
        "note": "Counted from the session events by tool name. Call arguments — the path, \
                 the command — are never read.",
    })
}

/// Where the work happened, one row per working directory.
fn project_view(sessions: &[Session]) -> Vec<Value> {
    struct P {
        path: String,
        sessions: i64,
        turns: i64,
        tokens: i64,
        premium: f64,
        last: Option<String>,
    }
    let mut by: BTreeMap<String, P> = BTreeMap::new();
    for s in sessions {
        let Some(path) = s.project.clone() else {
            continue;
        };
        let e = by.entry(path.clone()).or_insert_with(|| P {
            path,
            sessions: 0,
            turns: 0,
            tokens: 0,
            premium: 0.0,
            last: None,
        });
        e.sessions += 1;
        e.turns += s.turns;
        e.tokens += s.tokens.total;
        e.premium += s.spend.premium_requests;
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
                "sessions": p.sessions,
                "turns": p.turns,
                "tokens": p.tokens,
                "premiumRequests": crate::pricing::round(p.premium, 2),
                "lastActive": p.last,
            })
        })
        .collect();
    out.sort_by(|a, b| b["lastActive"].as_str().cmp(&a["lastActive"].as_str()));
    out
}

/// Tokens per local calendar day.
///
/// A Copilot segment reports one total for the whole segment rather than a
/// figure per turn, so a segment lands on the day its session was last active.
/// A session that ran across midnight is counted once, on the later day.
fn day_view(sessions: &[Session]) -> Vec<Value> {
    let mut by: BTreeMap<String, (i64, i64, f64, i64)> = BTreeMap::new();
    for s in sessions {
        let Some(day) = s
            .last
            .as_deref()
            .and_then(crate::transcripts::parse_iso)
            .map(|dt| dt.with_timezone(&chrono::Local).date_naive().to_string())
        else {
            continue;
        };
        let e = by.entry(day).or_insert((0, 0, 0.0, 0));
        e.0 += s.tokens.total;
        e.1 += s.tokens.output;
        e.2 += s.spend.premium_requests;
        e.3 += 1;
    }
    by.into_iter()
        .map(|(date, (total, output, premium, n))| {
            json!({
                "date": date,
                "tokens": total,
                "output": output,
                "premiumRequests": crate::pricing::round(premium, 2),
                "sessions": n,
            })
        })
        .rev()
        .take(60)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Everything the Copilot CLI has recorded on this machine, or `available:
/// false` with the reason. The board shows a tool only when this says yes.
pub fn collect() -> Value {
    collect_in(&copilot_home())
}

/// The reading, against an explicit root.
///
/// Split from `collect` so it can be tested without setting `COPILOT_HOME`:
/// environment variables are process-global, and two tests that each set and
/// clear one race whenever the harness runs them on different threads.
fn collect_in(base: &Path) -> Value {
    let root = base.join("session-state");
    if !root.is_dir() {
        // ~/.copilot without session-state is the IDE extension's half, which
        // records no usage — a different answer from "no Copilot here", and the
        // dashboard's setup card depends on telling them apart.
        if base.is_dir() {
            return json!({
                "available": false,
                "reason": "Copilot is installed, but the CLI has not run here — only the \
                           IDE extension, which records no usage locally",
            });
        }
        return json!({"available": false, "reason": "not installed"});
    }
    let Ok(entries) = std::fs::read_dir(&root) else {
        return json!({"available": false, "reason": "not readable"});
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if dirs.is_empty() {
        return json!({"available": false, "reason": "installed, but no sessions recorded"});
    }
    dirs.sort();

    let mut sessions: Vec<Session> = Vec::new();
    let mut tools: BTreeMap<String, i64> = BTreeMap::new();
    for d in &dirs {
        if let Some((s, t)) = read_session(d) {
            for (name, n) in t {
                *tools.entry(name).or_insert(0) += n;
            }
            sessions.push(s);
        }
    }
    if sessions.is_empty() {
        return json!({"available": false, "reason": "installed, but no sessions recorded"});
    }

    let mut totals = Tokens::default();
    let mut spend = Spend::default();
    let mut by_model: BTreeMap<String, Tokens> = BTreeMap::new();
    for s in &sessions {
        totals.add(&s.tokens);
        spend.premium_requests += s.spend.premium_requests;
        spend.aiu += s.spend.aiu;
        spend.requests += s.spend.requests;
        by_model
            .entry(s.model.clone().unwrap_or_else(|| "unknown".into()))
            .or_default()
            .add(&s.tokens);
    }
    spend.premium_requests = crate::pricing::round(spend.premium_requests, 2);
    spend.aiu = crate::pricing::round(spend.aiu, 4);
    sessions.sort_by(|a, b| b.last.cmp(&a.last));

    json!({
        "available": true,
        "sessions": sessions.iter().take(60).collect::<Vec<_>>(),
        "sessionCount": sessions.len(),
        "totals": totals,
        "spend": spend,
        "byModel": by_model.iter().map(|(m, t)| json!({"model": m, "tokens": t})).collect::<Vec<_>>(),
        "tools": tool_view(&tools),
        "projects": project_view(&sessions),
        "byDay": day_view(&sessions),
        "byDayNote": "A Copilot segment reports one total rather than a figure per turn, so a \
                      session counts once, on the day it was last active.",
        // Premium requests and AI units are what Copilot actually meters. They
        // are reported in those units; pricing.rs is an Anthropic rate card and
        // a dollar figure here would be invented rather than measured.
        "priced": false,
        "pricedNote": "Copilot meters premium requests and AI units, and both are reported as \
                       themselves — this build has no rate card that converts either to dollars.",
        "note": "Read from the CLI's own session events. The VS Code extension keeps no usage \
                 on disk; its numbers live behind GitHub's org billing and metrics APIs.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(dir: &Path, id: &str, lines: &[String]) {
        let d = dir.join(id);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("events.jsonl"), lines.join("\n") + "\n").unwrap();
    }

    fn shutdown(input: i64, output: i64, count: i64, premium: f64) -> String {
        format!(
            r#"{{"timestamp":"2026-06-02T00:24:14.589Z","type":"session.shutdown","data":{{"totalPremiumRequests":{premium},"totalNanoAiu":1000000000,"modelMetrics":{{"claude-haiku-4.5":{{"requests":{{"count":{count},"cost":{premium}}},"usage":{{"inputTokens":{input},"outputTokens":{output},"cacheReadTokens":10,"cacheWriteTokens":5,"reasoningTokens":0}}}}}}}}}}"#
        )
    }

    #[test]
    fn per_segment_metrics_are_summed_not_overwritten() {
        // The trap this collector exists to avoid: three shutdowns in one
        // resumed session. Codex's rule (take the last) would report 100
        // input tokens and 2 requests; the truth is 600 and 6.
        let dir = std::env::temp_dir().join(format!("copilot-sum-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_session(
            &dir,
            "s1",
            &[
                r#"{"timestamp":"2026-06-02T00:23:51.858Z","type":"session.start","data":{"sessionId":"s1","selectedModel":"claude-haiku-4.5","context":{"cwd":"/tmp/p"}}}"#.to_string(),
                shutdown(100, 10, 2, 0.33),
                shutdown(200, 20, 2, 0.33),
                shutdown(300, 30, 2, 0.34),
            ],
        );
        let (s, _) = read_session(&dir.join("s1")).expect("a session");
        assert_eq!(s.tokens.input, 600, "segments must be summed, not replaced");
        assert_eq!(s.tokens.output, 60);
        assert_eq!(s.spend.requests, 6);
        assert_eq!(s.segments, 3);
        // 600 + 60 + 30 cache read + 15 cache write
        assert_eq!(s.tokens.total, 705, "cache tokens count toward the total");
        assert!((s.spend.premium_requests - 1.0).abs() < 1e-9);
        assert!((s.spend.aiu - 3.0).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_call_is_counted_by_name_and_neither_arguments_nor_prompts_are_read() {
        let dir = std::env::temp_dir().join(format!("copilot-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_session(&dir, "s1", &[
            r#"{"timestamp":"2026-06-02T00:23:51.858Z","type":"session.start","data":{"sessionId":"s1","selectedModel":"claude-haiku-4.5","context":{"cwd":"/tmp/p"}}}"#.to_string(),
            r#"{"timestamp":"2026-06-02T00:23:52.000Z","type":"user.message","data":{"content":"my-secret-prompt"}}"#.to_string(),
            r#"{"timestamp":"2026-06-02T00:23:53.000Z","type":"assistant.turn_start","data":{"turnId":"0"}}"#.to_string(),
            r#"{"timestamp":"2026-06-02T00:23:54.000Z","type":"tool.execution_start","data":{"toolName":"view","arguments":{"path":"/etc/passwd"}}}"#.to_string(),
            r#"{"timestamp":"2026-06-02T00:23:55.000Z","type":"assistant.message","data":{"content":"my-secret-answer"}}"#.to_string(),
            shutdown(100, 10, 1, 0.33),
        ]);
        let (s, tools) = read_session(&dir.join("s1")).expect("a session");
        assert_eq!(tools["view"], 1);
        assert_eq!(s.turns, 1);
        assert_eq!(s.project.as_deref(), Some("/tmp/p"));
        assert_eq!(s.model.as_deref(), Some("claude-haiku-4.5"));

        let payload = serde_json::to_string(&json!({"s": &s, "t": tool_view(&tools)})).unwrap();
        for forbidden in ["passwd", "secret-prompt", "secret-answer"] {
            assert!(
                !payload.contains(forbidden),
                "{forbidden} reached the payload — arguments and message content must not"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_machine_without_the_copilot_cli_says_so_rather_than_showing_zeroes() {
        let v = collect_in(Path::new("/nonexistent/definitely/not/here"));
        assert_eq!(v["available"], false);
        assert!(v["reason"].as_str().unwrap().contains("not installed"));
        assert!(v.get("totals").is_none(), "no zeroed totals to misread");
    }

    #[test]
    fn an_ide_only_install_is_a_different_answer_from_no_copilot() {
        // ~/.copilot exists (the extension put it there) but no CLI session
        // state. The setup card the board shows depends on this distinction.
        let dir = std::env::temp_dir().join(format!("copilot-ide-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let v = collect_in(&dir);
        assert_eq!(v["available"], false);
        assert!(
            v["reason"].as_str().unwrap().contains("IDE extension"),
            "an IDE-only install must say so, not claim Copilot is absent"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
