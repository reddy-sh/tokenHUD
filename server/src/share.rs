//! The public leaderboard, and the one place that decides what may leave.
//!
//! A share is a URL anyone can open. Everything behind it is built here, and
//! it is built by **naming the fields that go out** rather than by taking a
//! reading and deleting the private parts. That distinction is the whole
//! module. A reading is 61 KB of JSON across ~2,400 leaves and the agent grows
//! new ones every release; a blacklist would publish each new field by default
//! and be wrong exactly once, in public. A whitelist is wrong in the safe
//! direction: a field nobody added here simply does not appear.
//!
//! What goes out:
//!
//!   token counts        input, output, cache reads and writes, totals
//!   model names         and the tokens and estimated value against each
//!   counters            sessions, requests, tool calls, messages, active days
//!   daily activity      one row per date: tokens, estimated value, counts,
//!                       and which models those tokens went to
//!   what is running     right now: tool, kind, headless, how long - counts,
//!                       never a command line
//!   coarse machine      operating system and core count
//!   which assistants    Claude Code, Codex CLI - the products, not the paths
//!
//! Those last two are what make this a demand signal rather than a scoreboard:
//! model mix over time is adoption and migration, and what is running right now
//! is live load. Both are aggregate by construction - a count of Claude Code
//! processes says nothing about what they are doing.
//!
//! What never goes out, at any setting:
//!
//!   project paths, project names, git branches, worktrees
//!   prompt text, session titles
//!   running processes and their command lines
//!   tool names, MCP server names, skills, plugins, hooks, permissions
//!   plan limits, usage percentages, the account hash
//!   hostnames - unless the share was explicitly created with identities=host
//!
//! The board is computed from live data on every request, so revoking a share
//! really does stop it: nothing rendered is cached anywhere to keep serving.

use crate::board::sha256_hex;
use crate::store::Store;
use chrono::Utc;
use serde_json::{json, Map, Value};

/// How much daily history a shared board carries. Ninety days is more than any
/// leaderboard window asks for and keeps the payload a few KB per machine.
pub const WINDOW_DAYS: usize = 90;

/// Identity modes, spelled once.
pub const ALIAS: &str = "alias";
pub const HOST: &str = "host";

/// How many machines a shared board needs before it will publish a
/// working-hours curve.
///
/// Aggregated over a team, "when does this fleet work" is a demand curve. Over
/// one machine it is a person's sleep schedule, and no amount of pseudonymising
/// the row above it changes that. Three is the smallest number at which the
/// curve is a sum of people rather than a picture of one, so under three the
/// board withholds the field and says so rather than quietly serving it.
pub const HOURS_MIN_MACHINES: usize = 3;

pub fn identities_ok(s: &str) -> bool {
    s == ALIAS || s == HOST
}

/// The share slug: 96 bits of the same OS randomness every other secret here
/// uses, cut to something that still fits in a URL somebody might read aloud
/// once. The slug IS the credential - there is no second check behind it - so
/// it is unguessable rather than short.
pub fn new_slug() -> String {
    crate::board::new_secret().chars().take(16).collect()
}

// Two lists that make a pronounceable name. Kept deliberately dull: a
// pseudonym on a public board should be forgettable, not a nickname somebody
// has to live with.
const ADJECTIVES: [&str; 32] = [
    "amber", "arctic", "bright", "bronze", "calm", "cedar", "clear", "cobalt", "copper", "coral",
    "crisp", "dusty", "ember", "fleet", "golden", "hazel", "ivory", "jade", "lunar", "mellow",
    "noble", "olive", "opal", "quiet", "rapid", "russet", "sable", "silver", "slate", "solar",
    "steady", "violet",
];

const CREATURES: [&str; 32] = [
    "otter", "heron", "lynx", "marten", "falcon", "badger", "ibis", "kestrel", "beaver", "crane",
    "raven", "shrike", "tapir", "vervet", "wren", "gannet", "ocelot", "puffin", "sable", "tern",
    "vulpes", "walrus", "yak", "zebu", "auk", "bison", "civet", "dingo", "egret", "fossa", "gecko",
    "hare",
];

/// A machine's public identity under one share.
///
/// The hash takes the slug as well as the host, so the same machine wears a
/// different name on every share it appears in. That is the property that
/// stops two boards from being lined up against each other to work out that
/// "amber-otter" over here and "quiet-heron" over there are one person.
pub fn alias(slug: &str, host: &str) -> (String, String) {
    let d = sha256_hex(&format!("tokenhud-share:{slug}:{host}"));
    let byte = |i: usize| u8::from_str_radix(&d[i * 2..i * 2 + 2], 16).unwrap_or(0) as usize;
    let name = format!(
        "{}-{}",
        ADJECTIVES[byte(0) % ADJECTIVES.len()],
        CREATURES[byte(1) % CREATURES.len()]
    );
    (d[..8].to_string(), name)
}

// ── small readers ───────────────────────────────────────────────────────
//
// Every one of these answers "what does this payload say, if it says
// anything" - a snapshot from an older agent, or from a machine where a
// collector found nothing, is missing whole subtrees, and the shared board
// has to be built out of what is actually there.

fn num(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64())
        .or_else(|| v.and_then(|x| x.as_f64()).map(|f| f as i64))
        .unwrap_or(0)
}

fn cash(v: Option<&Value>) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    Some(cur)
}

fn list<'a>(v: &'a Value, path: &[&str]) -> &'a [Value] {
    at(v, path)
        .and_then(|x| x.as_array())
        .map_or(&[], |a| &a[..])
}

/// Round money to cents. Serialising a float that came out of a sum of
/// thousands of per-request estimates otherwise ships fifteen digits of noise
/// and invites a reader to believe them.
fn cents(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

// ── the daily series ────────────────────────────────────────────────────

/// One row per date, merged across every assistant that reports days.
///
/// Claude Code and Codex count different things and neither reports the whole
/// picture per day: Claude Code has messages, tool calls and tokens; Codex has
/// tokens and sessions; the cost estimate lives in a third list keyed by the
/// same dates. Merging them here means the leaderboard windows one series
/// rather than three, and a machine that only runs one of the two still has a
/// row for every day it worked.
fn by_day(m: &Value) -> Vec<Value> {
    let mut rows: Map<String, Value> = Map::new();
    let mut put = |date: &str, f: &dyn Fn(&mut Map<String, Value>)| {
        if date.is_empty() {
            return;
        }
        let e = rows.entry(date.to_string()).or_insert_with(|| {
            json!({"date": date, "tokens": 0, "estUSD": 0.0, "sessions": 0,
                   "toolCalls": 0, "messages": 0, "byModel": {}})
        });
        if let Value::Object(o) = e {
            f(o);
        }
    };
    let add = |o: &mut Map<String, Value>, k: &str, n: i64| {
        let cur = o.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        o.insert(k.into(), json!(cur + n));
    };

    for d in list(m, &["claude", "daily"]) {
        let date = d.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let (t, msg, tc, se) = (
            num(d.get("tokens")),
            num(d.get("messages")),
            num(d.get("toolCalls")),
            num(d.get("sessions")),
        );
        // Which models the day's tokens went to. This is the field that turns a
        // daily total into an adoption curve - the shape that says a fleet
        // moved off one model and onto another, and when.
        let by_model = d.get("tokensByModel").cloned().unwrap_or(Value::Null);
        put(date, &|o| {
            add(o, "tokens", t);
            add(o, "messages", msg);
            add(o, "toolCalls", tc);
            add(o, "sessions", se);
            if let Some(Value::Object(src)) = by_model.as_object().map(|_| by_model.clone()) {
                if let Some(Value::Object(dst)) = o.get_mut("byModel") {
                    for (model, v) in src {
                        let cur = dst.get(&model).and_then(|x| x.as_i64()).unwrap_or(0);
                        dst.insert(model, json!(cur + num(Some(&v))));
                    }
                }
            }
        });
    }
    for d in list(m, &["codex", "byDay"]) {
        let date = d.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let (t, se) = (num(d.get("tokens")), num(d.get("sessions")));
        put(date, &|o| {
            add(o, "tokens", t);
            add(o, "sessions", se);
        });
    }
    for d in list(m, &["usage", "byDay"]) {
        let date = d.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let usd = cash(d.get("estUSD"));
        put(date, &|o| {
            let cur = o.get("estUSD").and_then(|v| v.as_f64()).unwrap_or(0.0);
            o.insert("estUSD".into(), json!(cents(cur + usd)));
        });
    }

    // Sorted explicitly rather than relying on the map's order: this crate
    // builds serde_json with `preserve_order`, so a Map iterates in insertion
    // order, and insertion order here is "whichever collector mentioned the
    // date first". ISO dates sort lexicographically, which is the one nice
    // thing about them.
    let mut out: Vec<Value> = rows.into_iter().map(|(_, v)| v).collect();
    out.sort_by(|a, b| {
        a.get("date")
            .and_then(|v| v.as_str())
            .cmp(&b.get("date").and_then(|v| v.as_str()))
    });
    if out.len() > WINDOW_DAYS {
        out.drain(..out.len() - WINDOW_DAYS);
    }
    out
}

// ── models ──────────────────────────────────────────────────────────────

/// Which models did the work, and how much of it.
///
/// Explicitly public: the person sharing asked for token counts and model
/// names to be the visible part. Claude Code rows come from the priced
/// rollup so they carry an estimate; Codex rows are counted but not priced by
/// this build, and say so rather than showing a zero that reads as free.
fn models(m: &Value) -> Vec<Value> {
    let mut out = Vec::new();

    for r in list(m, &["usage", "byModel"]) {
        let (i, o, cr, cw) = (
            num(r.get("input")),
            num(r.get("output")),
            num(r.get("cacheRead")),
            num(r.get("cacheWrite")),
        );
        out.push(json!({
            "model": r.get("model").and_then(|v| v.as_str()).unwrap_or("unknown"),
            "tool": "claude-code",
            "tokens": i + o + cr + cw,
            "input": i, "output": o, "cacheRead": cr, "cacheWrite": cw,
            "estUSD": cents(cash(r.get("estUSD"))),
            "priced": r.get("priced").and_then(|v| v.as_bool()).unwrap_or(false),
        }));
    }

    // A machine with no priced rollup - an older agent, or a reading taken
    // before the first transcript scan finished - still has raw model counts.
    if out.is_empty() {
        for r in list(m, &["claude", "models"]) {
            let (i, o, cr, cw) = (
                num(r.get("input")),
                num(r.get("output")),
                num(r.get("cacheRead")),
                num(r.get("cacheCreate")),
            );
            out.push(json!({
                "model": r.get("model").and_then(|v| v.as_str()).unwrap_or("unknown"),
                "tool": "claude-code",
                "tokens": i + o + cr + cw,
                "input": i, "output": o, "cacheRead": cr, "cacheWrite": cw,
                "estUSD": 0.0, "priced": false,
            }));
        }
    }

    for r in list(m, &["codex", "byModel"]) {
        let t = r.get("tokens").cloned().unwrap_or(Value::Null);
        out.push(json!({
            "model": r.get("model").and_then(|v| v.as_str()).unwrap_or("unknown"),
            "tool": "codex",
            "tokens": num(t.get("total")),
            "input": num(t.get("input")),
            "output": num(t.get("output")),
            "cacheRead": num(t.get("cached_input")),
            "cacheWrite": 0,
            "estUSD": 0.0,
            "priced": false,
        }));
    }

    out.sort_by_key(|r| -num(r.get("tokens")));
    out
}

/// Per-assistant totals, so a board can say who leans on which product rather
/// than only who used the most of everything.
fn by_tool(m: &Value) -> Vec<Value> {
    let mut out = Vec::new();

    let a = at(m, &["usage", "allTime"]).cloned().unwrap_or(Value::Null);
    let t = a.get("tokens").cloned().unwrap_or(Value::Null);
    let claude_tokens =
        num(t.get("in")) + num(t.get("out")) + num(t.get("cacheRead")) + num(t.get("cacheWrite"));
    if claude_tokens > 0 {
        out.push(json!({
            "id": "claude-code", "name": "Claude Code",
            "tokens": claude_tokens,
            "output": num(t.get("out")),
            "estUSD": cents(cash(a.get("estUSD"))),
            "sessions": num(a.get("sessions")),
        }));
    }

    let cx = at(m, &["codex", "totals"]).cloned().unwrap_or(Value::Null);
    let codex_tokens = num(cx.get("total"));
    if codex_tokens > 0 {
        out.push(json!({
            "id": "codex", "name": "Codex CLI",
            "tokens": codex_tokens,
            "output": num(cx.get("output")),
            // Only a figure the shipped rate card produced may travel. A
            // machine's owner can price their own board from
            // ~/.tokenhud/rates.json, and that number stops there: `estUSD` is
            // ranked, and ranking strangers on a value any of them can edit
            // would make the board a typing contest. Null is "not priced",
            // which is a different fact from "free".
            "estUSD": at(m, &["codex", "publicEstUSD"])
                .map(|v| json!(cents(cash(Some(v)))))
                .unwrap_or(Value::Null),
            "sessions": num(at(m, &["codex", "sessionCount"])),
        }));
    }

    out
}

// ── what is running, right now ──────────────────────────────────────────

/// The live half of the signal: how many agents are going on this machine at
/// the instant of the reading, and of what sort.
///
/// A process here is four facts and no fifth: which product, what kind of
/// session, whether it is headless, and how long it has been up. The command
/// line - which carries the project path, the flags, sometimes the prompt -
/// is not among them, and neither is the pid. A count of Claude Code processes
/// is load; a command line is a diary entry.
fn running(m: &Value) -> Vec<Value> {
    list(m, &["processes"])
        .iter()
        .map(|p| {
            json!({
                "tool": p.get("tool").and_then(|v| v.as_str()).unwrap_or("claude-code"),
                "kind": p.get("kind").and_then(|v| v.as_str()),
                "headless": p.get("headless").and_then(|v| v.as_bool()).unwrap_or(false),
                "model": p.get("model").and_then(|v| v.as_str()),
                "elapsedSeconds": crate::store::etime_seconds(
                    p.get("elapsed").and_then(|v| v.as_str()),
                ),
            })
        })
        .collect()
}

/// The five-hour block in flight, as intensity rather than history: how much
/// work has gone through it and how long it has left to run.
fn block(m: &Value) -> Value {
    let cur = match at(m, &["usage", "blocks", "current"]) {
        Some(c) if c.is_object() => c,
        _ => return Value::Null,
    };
    json!({
        "requests": num(cur.get("requests")),
        "outputTokens": num(cur.get("outputTokens")),
        "open": cur.get("open").and_then(|v| v.as_bool()).unwrap_or(false),
        "minutesLeft": num(cur.get("minutesLeft")),
        "minutesUsed": num(cur.get("minutesUsed")),
    })
}

// ── one entry ───────────────────────────────────────────────────────────

/// One machine's public profile.
///
/// Built field by field. Nothing here reaches into the payload without naming
/// what it wants, which is what makes the list at the top of this file a
/// promise rather than a hope.
pub fn entry(payload: &Value, id: &str, name: &str, host_row: Option<&Value>) -> Value {
    let m = payload.get("metrics").cloned().unwrap_or(Value::Null);
    let days = by_day(&m);
    let mods = models(&m);
    let tools = by_tool(&m);

    let a = at(&m, &["usage", "allTime"])
        .cloned()
        .unwrap_or(Value::Null);
    let t = a.get("tokens").cloned().unwrap_or(Value::Null);
    let codex = at(&m, &["codex", "totals"]).cloned().unwrap_or(Value::Null);

    let tokens = num(t.get("in"))
        + num(t.get("out"))
        + num(t.get("cacheRead"))
        + num(t.get("cacheWrite"))
        + num(codex.get("total"));

    let active_days = days.iter().filter(|d| num(d.get("tokens")) > 0).count();

    // The first day anyone worked, whichever collector saw it first.
    let first_seen = [
        at(&m, &["claude", "firstSessionDate"])
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(10).collect::<String>()),
        days.first()
            .and_then(|d| d.get("date"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
    ]
    .into_iter()
    .flatten()
    .min();

    json!({
        "id": id,
        "name": name,
        "os": at(&m, &["host", "platform"]).and_then(|v| v.as_str()),
        "cores": at(&m, &["host", "cpus"]).and_then(|v| v.as_i64()),
        "status": host_row.and_then(|h| h.get("status")).cloned().unwrap_or(Value::Null),
        "lastActive": host_row
            .and_then(|h| h.get("last_seen"))
            .cloned()
            .unwrap_or_else(|| payload.get("collectedAt").cloned().unwrap_or(Value::Null)),
        "firstSeen": first_seen,
        // The products in use, by name. Not the paths they were found at, not
        // the binaries - an assistant list is a fact about tooling, and a path
        // is a fact about a person's disk.
        "tools": list(&m, &["assistants"])
            .iter()
            .filter(|x| x.get("hasData").and_then(|v| v.as_bool()).unwrap_or(false))
            .map(|x| json!({
                "id": x.get("id").and_then(|v| v.as_str()),
                "name": x.get("name").and_then(|v| v.as_str()),
            }))
            .collect::<Vec<_>>(),
        "totals": {
            "tokens": tokens,
            "input": num(t.get("in")) + num(codex.get("input")),
            "output": num(t.get("out")) + num(codex.get("output")),
            "cacheRead": num(t.get("cacheRead")) + num(codex.get("cached_input")),
            "cacheWrite": num(t.get("cacheWrite")),
            "estUSD": cents(cash(a.get("estUSD"))),
            "sessions": num(a.get("sessions")) + num(at(&m, &["codex", "sessionCount"])),
            "requests": num(a.get("requests")),
            "toolCalls": num(a.get("toolCalls")),
            "messages": num(at(&m, &["claude", "totalMessages"])),
            "activeDays": active_days,
        },
        "byTool": tools,
        "models": mods,
        "byDay": days,
        "running": running(&m),
        "block": block(&m),
    })
}

// ── the board ───────────────────────────────────────────────────────────

/// The whole shared board: one entry per machine that has reported, ranked by
/// nothing in particular - ordering is the reader's choice, so the payload
/// carries the numbers and lets the page sort them.
pub fn board(store: &Store, share: &Value, hosts: &[Value]) -> Value {
    let slug = share.get("slug").and_then(|v| v.as_str()).unwrap_or("");
    let identities = share
        .get("identities")
        .and_then(|v| v.as_str())
        .unwrap_or(ALIAS);
    let show_hosts = identities == HOST;

    let mut used: Vec<String> = Vec::new();
    let mut entries = Vec::new();
    let mut pricing_as_of: Option<String> = None;

    for payload in store.all_latest() {
        let host = match payload.get("host").and_then(|v| v.as_str()) {
            Some(h) => h.to_string(),
            None => continue,
        };
        let (id, pseudonym) = alias(slug, &host);
        // Two machines can hash to the same pair of words. Nudge rather than
        // collide: a public board with two "amber-otter" rows is a bug the
        // reader has to untangle.
        let mut name = if show_hosts { host.clone() } else { pseudonym };
        if !show_hosts {
            let base = name.clone();
            let mut n = 2;
            while used.contains(&name) {
                name = format!("{base}-{n}");
                n += 1;
            }
            used.push(name.clone());
        }
        if pricing_as_of.is_none() {
            pricing_as_of = at(&payload, &["metrics", "usage", "pricing", "asOf"])
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        let row = hosts
            .iter()
            .find(|h| h.get("host").and_then(|v| v.as_str()) == Some(&host));
        entries.push(entry(&payload, &id, &name, row));
    }

    entries.sort_by_key(|e| -num(at(e, &["totals", "tokens"])));

    let fleet_tokens: i64 = entries
        .iter()
        .map(|e| num(at(e, &["totals", "tokens"])))
        .sum();
    let fleet_usd: f64 = entries
        .iter()
        .map(|e| cash(at(e, &["totals", "estUSD"])))
        .sum();

    // The hour curve is a board-level sum and never a per-machine field, so a
    // reader cannot pull one person's day back out of it - and under a few
    // machines it is not published at all.
    let hours = if entries.len() >= HOURS_MIN_MACHINES {
        let mut acc = [0i64; 24];
        for payload in store.all_latest() {
            if let Some(Value::Object(h)) = at(&payload, &["metrics", "claude", "hours"]) {
                for (k, v) in h {
                    if let Ok(i) = k.parse::<usize>() {
                        if i < 24 {
                            acc[i] += num(Some(v));
                        }
                    }
                }
            }
        }
        let mut out = Map::new();
        for (i, v) in acc.iter().enumerate() {
            out.insert(i.to_string(), json!(v));
        }
        Value::Object(out)
    } else {
        Value::Null
    };

    json!({
        "share": {
            "slug": slug,
            "title": share.get("title").cloned().unwrap_or(Value::Null),
            "identities": identities,
            "createdAt": share.get("createdAt").cloned().unwrap_or(Value::Null),
            "views": share.get("views").cloned().unwrap_or(Value::Null),
        },
        "generatedAt": crate::store::iso(Utc::now()),
        "windowDays": WINDOW_DAYS,
        "pricingAsOf": pricing_as_of,
        "hours": hours,
        "hoursMinMachines": HOURS_MIN_MACHINES,
        "totals": {
            "machines": entries.len(),
            "tokens": fleet_tokens,
            "estUSD": cents(fleet_usd),
        },
        "entries": entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reading with something private in every drawer the agent has.
    fn reading() -> Value {
        json!({
            "host": "reddy-4.local",
            "agentVersion": "0.2.0",
            "collectedAt": "2026-08-25T19:06:43Z",
            "metrics": {
                "host": {"hostname": "reddy-4.local", "platform": "Darwin", "cpus": 14,
                         "release": "27.0.0", "machine": "arm64"},
                "processes": [
                    {"pid": 1, "tool": "claude-code", "kind": "IDE session", "headless": false,
                     "elapsed": "02:03:04", "model": null,
                     "cmd": "/Users/someone/secret-project/bin/claude"}
                ],
                "projects": [{"path": "/Users/someone/secret-project", "label": "secret-project",
                              "branch": "feature/acquisition"}],
                "prompts": [{"text": "rewrite the acquisition memo", "project": "/Users/someone"}],
                "assistants": [
                    {"id": "claude-code", "name": "Claude Code", "hasData": true,
                     "paths": ["/Users/someone/.claude"], "bin": "/Users/someone/.local/bin/claude"},
                    {"id": "cursor", "name": "Cursor", "hasData": false, "paths": ["/Users/someone/.cursor"]}
                ],
                "limits": {"accountHash": "f8915fa762d1", "windows": [{"percent": 90}]},
                "governance": {"claude": {"mcpServers": [{"name": "internal-crm"}]}},
                "claude": {
                    "totalMessages": 57557, "firstSessionDate": "2026-06-02T09:03:57Z",
                    "hours": {"3": 12},
                    "daily": [
                        {"date": "2026-08-23", "tokens": 50, "messages": 2, "toolCalls": 1, "sessions": 1,
                         "tokensByModel": {"claude-opus-5": 50}},
                        {"date": "2026-08-24", "tokens": 100, "messages": 7, "toolCalls": 3, "sessions": 1,
                         "tokensByModel": {"claude-opus-5": 60, "claude-fable-5": 40}},
                        {"date": "2026-08-25", "tokens": 200, "messages": 9, "toolCalls": 4, "sessions": 2,
                         "tokensByModel": {"claude-fable-5": 200}}
                    ],
                    "models": [{"model": "claude-opus-5", "input": 1, "output": 2}]
                },
                "usage": {
                    "available": true,
                    "pricing": {"asOf": "2026-06-24"},
                    "sessions": [{"id": "1", "project": "secret-project", "path": "/Users/someone/secret-project",
                                  "branch": "main", "title": "the acquisition memo"}],
                    "tools": {"byServer": [{"server": "internal-crm"}]},
                    "allTime": {"estUSD": 25056.494, "sessions": 70, "requests": 89903, "toolCalls": 48344,
                                "tokens": {"in": 10, "out": 20, "cacheRead": 30, "cacheWrite": 40}},
                    "byModel": [{"model": "claude-opus-5", "estUSD": 7984.2, "priced": true,
                                 "input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40}],
                    "byDay": [{"date": "2026-08-25", "estUSD": 12.345}],
                    "blocks": {"current": {"requests": 16, "outputTokens": 6810,
                                           "open": true, "minutesLeft": 299, "minutesUsed": 1}}
                },
                "codex": {
                    "sessionCount": 54,
                    "totals": {"input": 5, "cached_input": 6, "output": 7, "total": 18},
                    "byModel": [{"model": "gpt-5.3-codex", "tokens": {"input": 5, "cached_input": 6,
                                                                     "output": 7, "total": 18}}],
                    "byDay": [{"date": "2026-08-25", "tokens": 18, "output": 7, "sessions": 1}],
                    "projects": [{"path": "/Users/someone/secret-project"}],
                    "policy": {"model": "gpt-5.4", "session": "01a03276"}
                }
            }
        })
    }

    #[test]
    fn a_public_entry_carries_no_private_string_anywhere_in_it() {
        let (id, name) = alias("slug", "reddy-4.local");
        let e = entry(&reading(), &id, &name, None);
        let text = serde_json::to_string(&e).unwrap();
        // Substring search over the serialised entry, not a field-by-field
        // check: this is the assertion that survives someone adding a field.
        for banned in [
            "secret-project",
            "/Users/someone",
            "acquisition",
            "feature/",
            "internal-crm",
            "reddy-4.local",
            "f8915fa762d1",
            ".claude",
            "01a03276",
            "gpt-5.4",
        ] {
            assert!(
                !text.contains(banned),
                "a shared board must never carry {banned:?} - found it in {text}"
            );
        }
    }

    #[test]
    fn a_public_entry_carries_the_numbers_it_is_for() {
        let (id, name) = alias("slug", "reddy-4.local");
        let e = entry(&reading(), &id, &name, None);
        // 10 + 20 + 30 + 40 from Claude Code, plus Codex's 18.
        assert_eq!(e["totals"]["tokens"], 118);
        assert_eq!(e["totals"]["output"], 27);
        assert_eq!(e["totals"]["sessions"], 124); // 70 + 54
        assert_eq!(e["totals"]["estUSD"], 25056.49); // rounded to cents
        assert_eq!(e["totals"]["activeDays"], 3);
        assert_eq!(e["os"], "Darwin");
        assert_eq!(e["firstSeen"], "2026-06-02");
        // Models are public by design, biggest first.
        assert_eq!(e["models"][0]["model"], "claude-opus-5");
        assert_eq!(e["models"][1]["model"], "gpt-5.3-codex");
        assert_eq!(e["models"][1]["priced"], false);
        // Only assistants that actually reported - Cursor is installed here
        // and has nothing to say.
        assert_eq!(e["tools"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_daily_series_merges_every_collector_onto_one_date() {
        let (id, name) = alias("slug", "reddy-4.local");
        let e = entry(&reading(), &id, &name, None);
        let days = e["byDay"].as_array().unwrap();
        assert_eq!(days.len(), 3, "three dates were reported, in order");
        assert_eq!(days[0]["date"], "2026-08-23");
        assert_eq!(days[2]["date"], "2026-08-25");
        // Claude Code's 200 plus Codex's 18 on the same day.
        assert_eq!(days[2]["tokens"], 218);
        assert_eq!(days[2]["estUSD"], 12.35);
        assert_eq!(days[2]["messages"], 9);
        // A day Codex never saw still has its Claude Code numbers.
        assert_eq!(days[1]["tokens"], 100);
        assert_eq!(days[1]["estUSD"], 0.0);
    }

    #[test]
    fn a_day_says_which_models_did_its_work() {
        let (id, name) = alias("slug", "reddy-4.local");
        let e = entry(&reading(), &id, &name, None);
        let days = e["byDay"].as_array().unwrap();
        // The whole point of the field: the same fleet on a different model a
        // day later, which is what an adoption curve is made of.
        assert_eq!(days[0]["byModel"]["claude-opus-5"], 50);
        assert_eq!(days[1]["byModel"]["claude-opus-5"], 60);
        assert_eq!(days[1]["byModel"]["claude-fable-5"], 40);
        assert_eq!(days[2]["byModel"]["claude-fable-5"], 200);
        assert!(days[2]["byModel"].get("claude-opus-5").is_none());
        // Codex reports no per-model split per day, so the day's total is
        // larger than the split adds up to - and the difference is visible
        // rather than silently folded into a model that did not earn it.
        assert_eq!(days[2]["tokens"], 218);
    }

    #[test]
    fn what_is_running_is_a_count_and_never_a_command_line() {
        let (id, name) = alias("slug", "reddy-4.local");
        let e = entry(&reading(), &id, &name, None);
        let procs = e["running"].as_array().unwrap();
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0]["tool"], "claude-code");
        assert_eq!(procs[0]["kind"], "IDE session");
        assert_eq!(procs[0]["headless"], false);
        assert_eq!(procs[0]["elapsedSeconds"], 7384);
        assert!(
            procs[0].get("cmd").is_none(),
            "a command line is a diary entry"
        );
        assert!(procs[0].get("pid").is_none());
        // Load in flight, without a history of what made it.
        assert_eq!(e["block"]["requests"], 16);
        assert_eq!(e["block"]["open"], true);
    }

    #[test]
    fn a_machine_wears_a_different_name_on_every_share() {
        let (id_a, name_a) = alias("share-one", "reddy-4.local");
        let (id_b, name_b) = alias("share-two", "reddy-4.local");
        assert_ne!(id_a, id_b, "ids must not correlate across shares");
        assert_ne!(
            name_a, name_b,
            "two boards of the same fleet must not be joinable by name"
        );
        // …and stable within one share, or the leaderboard renames people as
        // it refreshes.
        assert_eq!(alias("share-one", "reddy-4.local"), (id_a, name_a));
    }

    #[test]
    fn an_empty_reading_still_produces_a_well_formed_entry() {
        let e = entry(&json!({"host": "x"}), "id", "nobody", None);
        assert_eq!(e["totals"]["tokens"], 0);
        assert_eq!(e["byDay"].as_array().unwrap().len(), 0);
        assert_eq!(e["models"].as_array().unwrap().len(), 0);
        assert!(e["firstSeen"].is_null());
    }
}
