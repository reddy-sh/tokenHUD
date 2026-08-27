//! Codex CLI - the second tool that actually keeps enough on disk to read.
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
//! payload.rate_limits             = { …, credits, plan_type, spend_control_reached }
//! ```
//!
//! The three fields on the second line are account state rather than window
//! state, and they arrive in the same snapshot the percentages do - already
//! parsed, already on disk, and until now thrown away. They are worth keeping
//! because a percentage alone cannot answer the question a reader actually
//! has: a primary window at 3% on a plan whose spend control has tripped is a
//! different situation from a window at 3% on one that has not, and neither
//! shows up in `used_percent`.
//!
//! **`total_token_usage` is cumulative for the session, not per event.** Summing
//! every record would multiply a session's tokens by the number of turns in it -
//! on this machine, 1,366 events across 13 sessions. Only the last record in a
//! file is the truth, and that is what this reads.
//!
//! Rollouts are append-only and a finished session never changes, so a file
//! whose size and mtime are unchanged since the last reading is not re-read -
//! `read_session_cached` holds the parse. That keeps the steady-state cost to
//! whichever session is currently being written. The cache is per-process, so
//! a fresh start pays for one full pass; every cycle after it does not. Each
//! file is streamed a line at a time, so peak memory tracks the longest record
//! rather than the largest rollout.
//!
//! What is deliberately not here: dollars. `pricing.rs` is an Anthropic rate
//! card, and inventing OpenAI prices to fill a column would be exactly the
//! "present a calculation as a measurement" mistake the rest of this codebase
//! refuses to make. Codex tokens are reported as tokens, and marked unpriced.

use crate::transcripts::home;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Read buffer for a rollout. Big enough that a long JSONL line rarely spans
/// two fills, small enough that the agent's peak does not track the file.
const CHUNK: usize = 256 * 1024;
/// A JSONL record longer than this is not a record worth holding in memory.
const MAX_LINE: u64 = 64 * 1024 * 1024;

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
    /// Codex added `cache_write_input_tokens` after this struct was written and
    /// ships it with a serde default, so older rollouts simply do not carry it.
    /// Dropping it here meant cache writes were invisible on the Codex board
    /// while the Claude board priced them - the two were not counting the same
    /// thing. Absent stays 0, which is what an older rollout means.
    #[serde(default)]
    pub cache_write: i64,
    pub output: i64,
    pub reasoning: i64,
    pub total: i64,
}

impl Tokens {
    /// Shared with the OpenCode collector, which reports the same five
    /// counters under the same names. One struct rather than two keeps the two
    /// payloads using one set of keys for one set of facts - a board reading
    /// `cached_input` from one and `cacheRead` from the other would be two
    /// answers to one question.
    pub(crate) fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.cached_input += o.cached_input;
        self.cache_write += o.cache_write;
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

/// The credit pool Codex reports beside the windows.
///
/// Every field is an `Option` and every one of them is serialised, null
/// included. Codex writes no `credits` object at all on a plan that has no
/// pool, and `has_credits: false` on a plan that has one and nothing in it -
/// two different facts, and folding the first into `false` would invent a pool
/// the account does not have. `balance` is kept as the string Codex wrote: it
/// is a decimal amount that this agent displays and never sums, and parsing it
/// into an f64 to print it back out again can only lose digits.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Credits {
    #[serde(rename = "hasCredits")]
    pub has_credits: Option<bool>,
    pub unlimited: Option<bool>,
    pub balance: Option<String>,
}

/// The account-level quota state Codex ships in the same `rate_limits`
/// snapshot as the windows: which plan this machine is signed in on, whether
/// the account's spend control has tripped, and what credit is left.
///
/// This is provider-reported, not derived - the same standing as the
/// percentages beside it, and it costs nothing to read because the rollout is
/// already open for the token counts.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Quota {
    #[serde(rename = "planType")]
    pub plan_type: Option<String>,
    /// `None` when Codex reported no value, which is what it writes on most
    /// plans today. Never defaulted to `false`: "this account has not tripped
    /// its spend control" and "Codex did not say" are different answers, and
    /// only one of them is a measurement.
    #[serde(rename = "spendControlReached")]
    pub spend_control_reached: Option<bool>,
    pub credits: Option<Credits>,
}

/// One `rate_limits` snapshot, whole.
///
/// The windows and the account state are written by the same response header
/// at the same instant, so they are carried together. Taking the newest
/// windows from one session and the newest `plan_type` from another would
/// report a pair that never existed on this machine at any moment.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub windows: Vec<RateLimit>,
    pub quota: Option<Quota>,
}

impl Snapshot {
    /// Nothing was reported at all - as opposed to a snapshot that reported
    /// windows but no account state, which is a reading and is kept.
    fn is_empty(&self) -> bool {
        self.windows.is_empty() && self.quota.is_none()
    }
}

fn as_i(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

/// What one rollout file yields: the session, the last `rate_limits` snapshot
/// it saw, the stamp on that reading, and its calls counted by tool name.
type Rollout = (Session, Snapshot, Option<String>, BTreeMap<String, i64>);

/// Parsed rollouts, keyed by path and by the (size, mtime) they were parsed at.
///
/// A finished rollout never changes, so re-parsing every file on every cycle is
/// work with a known answer: on the machine this was written against that is
/// 11 GB across 292 files, every 30 seconds. The cache lives in the process
/// rather than on disk on purpose - the agent's writes are declared in
/// `manifest.rs` and hashed into the consent the user agreed to, and a cache
/// file would widen that promise to buy something a long-lived loop gets for
/// free. A fresh start pays for one full read, which is honest.
type Stamp = (u64, Option<std::time::SystemTime>);
static SEEN: std::sync::Mutex<Option<HashMap<PathBuf, (Stamp, Rollout)>>> =
    std::sync::Mutex::new(None);

fn stamp_of(path: &Path) -> Stamp {
    match std::fs::metadata(path) {
        Ok(m) => (m.len(), m.modified().ok()),
        Err(_) => (0, None),
    }
}

/// `read_session`, but a file whose size and mtime are unchanged is not re-read.
fn read_session_cached(path: &Path) -> Option<Rollout> {
    let stamp = stamp_of(path);
    if let Ok(g) = SEEN.lock() {
        if let Some(map) = g.as_ref() {
            if let Some((seen, hit)) = map.get(path) {
                if *seen == stamp {
                    return Some(hit.clone());
                }
            }
        }
    }
    let parsed = read_session(path)?;
    if let Ok(mut g) = SEEN.lock() {
        g.get_or_insert_with(HashMap::new)
            .insert(path.to_path_buf(), (stamp, parsed.clone()));
    }
    Some(parsed)
}

fn read_session(path: &Path) -> Option<Rollout> {
    // Streamed, not slurped. A single rollout on a working machine reaches
    // hundreds of megabytes - 761 MB on the one this was written against - and
    // `read_to_string` put that, plus the parsed tree, in memory every cycle.
    // A line at a time keeps the peak a property of the longest record rather
    // than of the corpus.
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::with_capacity(CHUNK, file);
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
    let mut limits = Snapshot::default();
    let mut newest_stamp: Option<String> = None;
    let mut tools: BTreeMap<String, i64> = BTreeMap::new();

    // `lines()` would allocate a String per record, and a large rollout has
    // millions. One buffer, reused, keeps the allocation count flat.
    let mut reader = reader;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.len() as u64 > MAX_LINE {
            continue;
        }
        let Ok(r) = serde_json::from_str::<Value>(line.trim_end()) else {
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
            // is taken; `arguments` - the command, the patch - is not.
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
                                cache_write: as_i(u.get("cache_write_input_tokens")),
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
                        limits = read_snapshot(p.get("rate_limits"));
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

fn read_snapshot(v: Option<&Value>) -> Snapshot {
    let mut out = Snapshot::default();
    let Some(obj) = v.and_then(|x| x.as_object()) else {
        return out;
    };
    // A window is any member that carries a `used_percent`. Codex names them
    // `primary` and `secondary` today, and identifying them by shape rather
    // than by name means a third window arrives on the board rather than
    // needing a release. The account-level members sitting alongside them -
    // `credits`, `plan_type`, `spend_control_reached` - have no `used_percent`
    // and fall out of this loop by the same rule.
    for (name, row) in obj {
        let Some(row) = row.as_object() else { continue };
        let Some(pct) = row.get("used_percent").and_then(|v| v.as_f64()) else {
            continue;
        };
        let resets = row
            .get("resets_at")
            .and_then(|v| v.as_i64())
            .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0).map(crate::collect::iso_of));
        out.windows.push(RateLimit {
            kind: name.clone(),
            percent: crate::pricing::round(pct, 2),
            window_minutes: as_i(row.get("window_minutes")),
            resets_at: resets,
        });
    }
    out.quota = read_quota(obj);
    out
}

/// The account-level members of a `rate_limits` snapshot, or `None` when Codex
/// reported none of them.
///
/// `None` rather than a hollow `{planType: null, credits: null, …}` on purpose:
/// snapshots are stored as structural differences against the previous one, and
/// an object whose every field is null is a key that carries no fact while
/// still costing a row in every diff.
fn read_quota(obj: &serde_json::Map<String, Value>) -> Option<Quota> {
    let plan_type = obj
        .get("plan_type")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let spend_control_reached = obj.get("spend_control_reached").and_then(|v| v.as_bool());
    let credits = obj
        .get("credits")
        .and_then(|v| v.as_object())
        .map(|c| Credits {
            has_credits: c.get("has_credits").and_then(|v| v.as_bool()),
            unlimited: c.get("unlimited").and_then(|v| v.as_bool()),
            // Codex writes the balance as a decimal string. A build that
            // switched it to a number would still be reported rather than
            // silently dropped, but it is never parsed into a float: this
            // value is shown, not arithmetic.
            balance: c.get("balance").and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            }),
        });
    if plan_type.is_none() && spend_control_reached.is_none() && credits.is_none() {
        return None;
    }
    Some(Quota {
        plan_type,
        spend_control_reached,
        credits,
    })
}

/// Tool calls by name, and by MCP server where the name carries one.
///
/// Codex exposes an MCP tool as `<server>__<tool>` and its own built-ins as a
/// single word - `exec_command`, `apply_patch`. So a double underscore is what
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
        "note": "Counted from the rollouts by tool name. Call arguments - the command, \
                 the patch - are never read.",
    })
}

/// Where the work happened, one row per working directory.
///
/// The Claude side reads this from `~/.claude/projects`, which is a directory
/// per project. Codex has no such directory - a rollout records its own `cwd`
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
/// across midnight is therefore counted once, on the later day - an
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
    let mut limits = Snapshot::default();
    let mut newest: Option<String> = None;
    let mut tools: BTreeMap<String, i64> = BTreeMap::new();
    for f in &files {
        if let Some((s, l, stamp, t)) = read_session_cached(f) {
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
    // Sum only what is priceable: a model without a rate contributes tokens and
    // no dollars, and if nothing is priceable there is no total at all.
    let mut total_est: Option<f64> = None;
    // What may leave this machine: priced from the built-in card only. A user's
    // own card prices their board and stops there, because `estUSD` is a ranked
    // metric and a number anybody can edit is not one to rank strangers on.
    let mut total_public: Option<f64> = None;
    let mut user_priced_models = 0usize;
    for (m, t) in &by_model {
        if let Some(c) =
            crate::pricing::cost_parts(m, t.input, t.cached_input, t.cache_write, t.output, t.reasoning)
        {
            total_est = Some(total_est.unwrap_or(0.0) + c);
        }
        if let Some(c) = crate::pricing::cost_parts_builtin(
            m,
            t.input,
            t.cached_input,
            t.cache_write,
            t.output,
            t.reasoning,
        ) {
            total_public = Some(total_public.unwrap_or(0.0) + c);
        }
        if crate::pricing::is_user_priced(m) {
            user_priced_models += 1;
        }
    }

    sessions.sort_by(|a, b| b.last.cmp(&a.last));

    json!({
        "available": true,
        "sessions": sessions.iter().take(60).collect::<Vec<_>>(),
        "sessionCount": sessions.len(),
        // The session LIST is capped at 60 for payload size, but the counts
        // beside it are not. A board that summed turns out of the list while
        // reading sessionCount from here showed "292 sessions, 189 turns" -
        // two tiles side by side, counted over different populations. Any
        // figure the board puts next to sessionCount has to come from the
        // same place sessionCount does.
        "turnCount": sessions.iter().map(|s| s.turns).sum::<i64>(),
        "totals": totals,
        "byModel": by_model
            .iter()
            .map(|(m, t)| {
                // Priced only if somebody supplied a rate for this model in
                // ~/.tokenhud/rates.json. No rate, no number - an unpriced
                // model is unpriced, never $0.
                let est = crate::pricing::cost_parts(
                    m,
                    t.input,
                    t.cached_input,
                    t.cache_write,
                    t.output,
                    t.reasoning,
                );
                json!({
                    "model": m,
                    "tokens": t,
                    "estUSD": est.map(|v| crate::pricing::round(v, 2)),
                    "priced": est.is_some(),
                })
            })
            .collect::<Vec<_>>(),
        "limits": limits.windows,
        // Account state from the same snapshot the windows came from: the plan
        // this machine is signed in on, whether spend control has tripped, and
        // the credit pool. Null when Codex reported none of it - which is a
        // different fact from a plan with no credits, and is left looking
        // different.
        "quota": limits.quota,
        "quotaNote": "Reported by Codex in the same rate_limits snapshot as the windows. A \
                      null field means Codex said nothing, not that the answer is zero or no.",
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
        // Priced when the user has supplied rates for these models, unpriced
        // otherwise. This build ships no OpenAI rate card and will not invent
        // one; `~/.tokenhud/rates.json` is how a number gets here, vouched for
        // by whoever wrote it.
        "priced": total_est.is_some(),
        "estUSD": total_est.map(|v| crate::pricing::round(v, 2)),
        "costBasis": if total_est.is_some() {
            crate::pricing::BASIS_API_EQUIVALENT
        } else {
            crate::pricing::BASIS_UNPRICED
        },
        "ratesAsOf": crate::pricing::overrides_as_of(),
        // The figure that may be shared or ranked. Null whenever the only
        // prices available came from a card this machine's owner wrote.
        "publicEstUSD": total_public.map(|v| crate::pricing::round(v, 2)),
        "userPricedModels": user_priced_models,
        "pricedNote": "Codex tokens are counted, not priced - the rate card in this build covers Anthropic models only.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session list is capped at 60; the counts beside it are not.
    ///
    /// The board showed "292 sessions, 189 turns" because it summed turns out
    /// of the truncated list while reading sessionCount from the payload. Any
    /// aggregate the UI puts next to sessionCount has to be shipped from here,
    /// counted over the same population.
    #[test]
    fn turns_are_counted_over_every_session_not_the_listed_sixty() {
        let dir = std::env::temp_dir().join(format!("codex-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 70 sessions, one turn each: more than the 60 the payload lists.
        for i in 0..70 {
            let f = dir.join(format!("rollout-{i:03}.jsonl"));
            std::fs::write(
                &f,
                format!(
                    "{}\n{}\n{}\n",
                    format_args!(
                        r#"{{"timestamp":"2026-08-01T10:00:0{}Z","type":"session_meta","payload":{{"id":"s{i}","cwd":"/tmp/p"}}}}"#,
                        i % 10
                    ),
                    r#"{"timestamp":"2026-08-01T10:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
                    r#"{"timestamp":"2026-08-01T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"total_tokens":10}}}}"#,
                ),
            )
            .unwrap();
        }
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("CODEX_HOME").ok();
        std::env::set_var("CODEX_HOME", &dir);
        // sessions_root() looks for <CODEX_HOME>/sessions
        let sess = dir.join("sessions");
        std::fs::create_dir_all(&sess).unwrap();
        for i in 0..70 {
            let from = dir.join(format!("rollout-{i:03}.jsonl"));
            let to = sess.join(format!("rollout-{i:03}.jsonl"));
            std::fs::rename(&from, &to).unwrap();
        }
        let v = collect();
        match prev {
            Some(p) => std::env::set_var("CODEX_HOME", p),
            None => std::env::remove_var("CODEX_HOME"),
        }

        assert_eq!(v["sessionCount"].as_i64(), Some(70), "every session counts");
        assert_eq!(
            v["sessions"].as_array().map(|a| a.len()),
            Some(60),
            "the list is still capped"
        );
        assert_eq!(
            v["turnCount"].as_i64(),
            Some(70),
            "turns must be counted over all 70 sessions, not the listed 60"
        );
        let listed: i64 = v["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["turns"].as_i64().unwrap_or(0))
            .sum();
        assert_ne!(
            listed,
            v["turnCount"].as_i64().unwrap(),
            "the bug this guards against is the two agreeing only by accident"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The parse cache must never serve a stale answer for a file that grew.
    ///
    /// A missed cache hit only costs time; a wrongly-held one reports last
    /// cycle's numbers forever, which is the failure that matters.
    #[test]
    fn an_appended_rollout_is_re_read_not_served_from_cache() {
        let dir = std::env::temp_dir().join(format!("codex-memo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("rollout-memo.jsonl");
        let meta = r#"{"timestamp":"2026-08-01T10:00:00Z","type":"session_meta","payload":{"id":"s1","cwd":"/tmp/p"}}"#;
        let ev = |n: i64| format!(
            r#"{{"timestamp":"2026-08-01T10:0{n}:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{n}0,"total_tokens":{n}0}}}}}}}}"#
        );

        std::fs::write(&f, format!("{meta}\n{}\n", ev(1))).unwrap();
        let (a, _, _, _) = read_session_cached(&f).expect("a session");
        assert_eq!(a.tokens.total, 10);

        // Append a later cumulative total. Size changes, so the cache must not
        // answer with the reading it already has.
        std::fs::write(&f, format!("{meta}\n{}\n{}\n", ev(1), ev(5))).unwrap();
        let (b, _, _, _) = read_session_cached(&f).expect("a session");
        assert_eq!(
            b.tokens.total, 50,
            "a rollout that grew must be re-read, not served from the cache"
        );

        // Unchanged now: same answer, and this time it is allowed to come from
        // the cache - which is the whole point of having one.
        let (c, _, _, _) = read_session_cached(&f).expect("a session");
        assert_eq!(c.tokens.total, 50);
        let _ = std::fs::remove_dir_all(&dir);
    }

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
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let s = read_snapshot(Some(&v));
        assert_eq!(s.windows.len(), 1);
        assert_eq!(s.windows[0].kind, "primary");
        assert_eq!(s.windows[0].window_minutes, 10080);
        let resets = s.windows[0].resets_at.as_deref().unwrap_or("");
        assert!(resets.starts_with("2026-"), "{resets}");
    }

    /// The shape Codex actually writes, copied off a real rollout on the
    /// machine this was developed on. The account fields sit beside the
    /// windows in one object, and both have to survive the same parse.
    #[test]
    fn the_account_state_beside_the_windows_is_kept_not_discarded() {
        let v = serde_json::json!({
            "limit_id": "codex",
            "limit_name": null,
            "primary": {"used_percent": 3.0, "window_minutes": 10080, "resets_at": 1785961360},
            "secondary": null,
            "credits": {"has_credits": false, "unlimited": false, "balance": "0"},
            "individual_limit": null,
            "spend_control_reached": null,
            "plan_type": "pro",
            "rate_limit_reached_type": null
        });
        let s = read_snapshot(Some(&v));
        // `credits` is an object without a `used_percent`, so it must not have
        // been mistaken for a third rate-limit window.
        assert_eq!(s.windows.len(), 1, "only `primary` is a window here");
        assert_eq!(s.windows[0].kind, "primary");

        let q = s.quota.expect("this snapshot carries account state");
        assert_eq!(q.plan_type.as_deref(), Some("pro"));
        // Codex wrote null. `false` would read as "checked, and it has not
        // tripped" - a claim this rollout does not make.
        assert_eq!(
            q.spend_control_reached, None,
            "a field Codex left null must stay absent, never become false"
        );
        let c = q.credits.expect("credits were reported");
        // Reported false is a measurement; absent is not.
        assert_eq!(c.has_credits, Some(false));
        assert_eq!(c.unlimited, Some(false));
        assert_eq!(
            c.balance.as_deref(),
            Some("0"),
            "the balance is kept as the decimal string Codex wrote"
        );
    }

    #[test]
    fn a_snapshot_with_no_account_state_carries_no_quota_at_all() {
        // The older shape: windows and nothing else. A hollow quota object
        // full of nulls would be a key that says nothing while still showing
        // up in every structural diff.
        let v = serde_json::json!({
            "primary": {"used_percent": 4.0, "window_minutes": 300, "resets_at": 1785961360}
        });
        let s = read_snapshot(Some(&v));
        assert_eq!(s.windows.len(), 1);
        assert!(
            s.quota.is_none(),
            "nothing reported means no quota, not an object of nulls"
        );
    }

    /// The whole snapshot moves together or the board reports a pair that
    /// never existed: the newest windows from one session beside a plan type
    /// from another.
    #[test]
    fn an_empty_snapshot_never_displaces_one_that_reported_something() {
        let empty = read_snapshot(None);
        assert!(empty.is_empty());
        let full = read_snapshot(Some(&serde_json::json!({"plan_type": "plus"})));
        assert!(
            !full.is_empty(),
            "account state alone is still a reading worth keeping, windows or not"
        );
        assert!(full.windows.is_empty());
    }

    #[test]
    fn a_quota_serialises_its_absent_fields_as_null_rather_than_dropping_them() {
        let only_plan = serde_json::json!({"plan_type": "pro"});
        let q = read_quota(only_plan.as_object().unwrap()).unwrap();
        let out = serde_json::to_value(&q).unwrap();
        assert_eq!(out["planType"], "pro");
        // Present-and-null, not missing: a key that comes and goes is a
        // change on every reading that carries no information.
        assert!(out.get("spendControlReached").is_some());
        assert!(out["spendControlReached"].is_null());
        assert!(out["credits"].is_null());
    }
}
