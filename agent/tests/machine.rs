//! Does this build actually work on this machine?
//!
//! Eight of these came from a Python suite that no longer exists, where they
//! ran against the Python agent this one replaced. They moved as they were — same assertions,
//! same thresholds, same refusal to mock anything — and three more were added
//! for the seams the Python suite never had to cover.
//!
//! Nothing here is a unit test. Every check runs against the real collectors
//! reading the real machine — because a test that passes against a fake tells
//! you nothing about whether the board works here, which is the only question
//! worth asking of an agent.
//!
//! A check whose source is absent SKIPS rather than fails: no transcripts, no
//! `~/.claude.json`, no usage cache yet. A skip prints why. Run with
//! `cargo test -- --nocapture` to read them.
//!
//! Nothing it touches is yours: no collector writes, and the one check that
//! could — `limits` — asserts precisely that it did not.

use serde_json::Value;
use std::path::{Path, PathBuf};
use tokenhud_agent::{collect, limits, pricing, transcripts};

fn skip(what: &str, why: &str) {
    eprintln!("  skip · {what}: {why}");
}

fn note(what: &str, msg: &str) {
    eprintln!("  ok   · {what}: {msg}");
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

// ── pricing ─────────────────────────────────────────────────────────────

#[test]
fn pricing_arithmetic() {
    use transcripts::Tok;
    // A million output tokens on Opus 5 is $25 by the published rate, and if
    // that ever stops being true the board's headline is wrong.
    let c = pricing::cost(
        "claude-opus-5",
        &Tok {
            out: 1_000_000,
            ..Default::default()
        },
    )
    .unwrap();
    assert!((c - 25.0).abs() < 1e-6, "expected $25.00, got {c}");
    // Cache is priced off input, not separately.
    let r = pricing::cost(
        "claude-opus-5",
        &Tok {
            cr: 1_000_000,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        (r - 0.5).abs() < 1e-6,
        "cache read should be 0.1x the $5 input rate, got {r}"
    );
    let w = pricing::cost(
        "claude-opus-5",
        &Tok {
            cw1: 1_000_000,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        (w - 10.0).abs() < 1e-6,
        "1h cache write should be 2x input, got {w}"
    );
    note(
        "pricing",
        "opus-5 $25/MTok out, cache read 0.1x, 1h write 2x",
    );
}

#[test]
fn an_unknown_model_reports_as_unpriced_not_free() {
    use indexmap::IndexMap;
    use transcripts::Tok;
    let t = Tok {
        out: 1_000_000,
        ..Default::default()
    };
    assert!(
        pricing::cost("claude-from-the-future-9", &t).is_none(),
        "an unpriced model must return None, never 0 — a 0 would silently join a total"
    );
    let mut m: IndexMap<String, Tok> = IndexMap::new();
    m.insert(
        "claude-from-the-future-9".into(),
        Tok {
            out: 1234,
            ..Default::default()
        },
    );
    let (total, unpriced) = pricing::cost_of(m.iter());
    assert_eq!(
        (total, unpriced),
        (0.0, 1234),
        "unpriced tokens must be counted separately"
    );
    note("pricing", "unknown models report as unpriced, not as $0");
}

// ── the transcript index ────────────────────────────────────────────────

#[test]
fn the_transcript_scan_makes_progress() {
    let root = transcripts::claude_dir().join("projects");
    if !root.is_dir() {
        return skip(
            "transcripts",
            &format!("no transcripts at {}", root.display()),
        );
    }
    // A small budget so this stays a test and not a full corpus scan.
    std::env::set_var("TOKENHUD_SCAN_BUDGET_MB", "4");
    let (idx, s) = transcripts::scan();
    assert!(
        s.bytes_done <= s.bytes_total,
        "progress is impossible: {} of {}",
        s.bytes_done,
        s.bytes_total
    );
    note(
        "transcripts",
        &format!(
            "{} sessions indexed, {:.0}/{:.0} MB read",
            idx.sessions.len(),
            s.bytes_done as f64 / 1e6,
            s.bytes_total as f64 / 1e6
        ),
    );
}

#[test]
fn a_five_hour_block_is_five_hours() {
    let usage = collect::collect_usage();
    let b = &usage["blocks"];
    if !b["available"].as_bool().unwrap_or(false) {
        return skip("blocks", "no request timestamps indexed yet");
    }
    let span = (transcripts::BLOCK_HOURS * 60) as f64;
    let recent = b["recent"].as_array().cloned().unwrap_or_default();
    for row in &recent {
        let start =
            transcripts::parse_iso(row["start"].as_str().unwrap_or("")).expect("start parses");
        let end = transcripts::parse_iso(row["end"].as_str().unwrap_or("")).expect("end parses");
        let got = (end - start).num_seconds() as f64 / 60.0;
        assert!(
            (got - span).abs() < 1.0,
            "a block ran {got} minutes, expected {span}"
        );
    }
    if let Some(cur) = b["current"].as_object() {
        let left = cur["minutesLeft"].as_i64().unwrap_or(-1);
        assert!(
            (0..=span as i64).contains(&left),
            "minutesLeft out of range: {left}"
        );
    }
    note(
        "blocks",
        &format!(
            "{} blocks, all exactly {}h",
            recent.len(),
            transcripts::BLOCK_HOURS
        ),
    );
}

// ── the plan's real limits ──────────────────────────────────────────────

#[test]
fn the_limits_payload_carries_nothing_identifying() {
    let lim = limits::collect_limits();
    if !lim["available"].as_bool().unwrap_or(false) {
        return skip(
            "limits",
            &format!(
                "no usage cache ({}) — run /usage in Claude Code",
                lim["reason"]
            ),
        );
    }
    let hash = lim["accountHash"].as_str().unwrap_or("");
    assert_eq!(hash.len(), 12, "account hash missing or wrong length");

    let blob = lim.to_string();
    for leak in [
        "emailAddress",
        "@",
        "organizationName",
        "oauthAccount",
        "used_dollars",
    ] {
        assert!(
            !blob.contains(leak),
            "the limits payload must not carry {leak:?}"
        );
    }
    let windows = lim["windows"].as_array().cloned().unwrap_or_default();
    for w in &windows {
        if let Some(p) = w["percent"].as_i64() {
            assert!((0..=100).contains(&p), "percent out of range: {w}");
        }
    }
    note(
        "limits",
        &format!(
            "{} windows, {}s old, nothing identifying",
            windows.len(),
            lim["ageSeconds"]
        ),
    );
}

#[test]
fn reading_the_limits_never_writes_claude_json() {
    let path = home().join(".claude.json");
    if !path.is_file() {
        return skip("limits", "no ~/.claude.json on this machine");
    }
    let before = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let _ = limits::collect_limits();
    let after = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    assert_eq!(
        before, after,
        "collect_limits() modified ~/.claude.json — it must never write to Claude Code's config"
    );
    note("limits", "~/.claude.json untouched");
}

// ── collectors, as a whole ──────────────────────────────────────────────

#[test]
fn a_reading_is_serialisable_and_quiet() {
    let t = std::time::Instant::now();
    let snap = collect::collect();
    let el = t.elapsed().as_secs_f64();
    let blob = serde_json::to_string(&snap).expect("a reading must serialise");
    let m = &snap["metrics"];
    for key in [
        "host",
        "processes",
        "claude",
        "usage",
        "limits",
        "assistants",
        "governance",
        "projects",
        "daemon",
    ] {
        assert!(!m[key].is_null(), "metrics is missing {key}");
    }
    if std::env::var("TOKENHUD_SEND_PROMPTS").unwrap_or_default() != "1" {
        assert_eq!(
            m["prompts"].as_array().map(|a| a.len()),
            Some(0),
            "prompt text left the collector without TOKENHUD_SEND_PROMPTS=1"
        );
        for s in m["usage"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            assert!(
                s["title"].is_null(),
                "a session title (written from a prompt) leaked without opt-in"
            );
        }
    }
    note(
        "collectors",
        &format!("{:.0} KB in {el:.2}s", blob.len() as f64 / 1024.0),
    );
}

#[test]
fn a_broken_source_is_not_a_dead_host() {
    // A host with a missing or broken source must report the rest of itself,
    // not disappear from the board. That is the difference between "the disk
    // collector is down" and "the host is down".
    //
    // Serialised against the other env-touching tests: `set_var` is process
    // -wide, and a sibling test reading ~/.claude mid-flight would see this
    // one's nonsense path.
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let saved = std::env::var("CLAUDE_CONFIG_DIR").ok();
    std::env::set_var("CLAUDE_CONFIG_DIR", "/nonexistent/definitely/not/here");

    let snap = collect::collect();
    let ok = serde_json::to_string(&snap).is_ok()
        && snap["metrics"]["host"]["cpus"].as_u64().unwrap_or(0) > 0;

    match saved {
        Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    assert!(ok, "host facts should survive a missing Claude directory");
    note("collectors", "a missing ~/.claude does not drop the host");
}

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ── governance ──────────────────────────────────────────────────────────

#[test]
fn no_mcp_credential_on_this_machine_reaches_the_payload() {
    // The governance panel lists an MCP server's environment variables so you
    // can see that a server is handed a token. The value of that token is the
    // single most dangerous string in any file this agent opens, and the check
    // that it stays put cannot be a unit test against a fixture: it has to run
    // against whatever is really configured here.
    let gov = tokenhud_agent::governance::collect();
    let blob = serde_json::to_string(&gov).expect("governance must serialise");

    let mut secrets: Vec<String> = Vec::new();
    // A value that is a path is excluded, and only from the LEAK check: the
    // payload legitimately names the files it read, so `/Users/x/.codex` would
    // match by accident and say nothing about credentials. The structural check
    // below covers those cases instead, and it is the stronger of the two.
    let is_secretish = |s: &str| s.len() > 6 && !s.contains('/');

    if let Some(v) = std::fs::read(home().join(".claude").join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    {
        for (name, cfg) in v["mcpServers"].as_object().into_iter().flatten() {
            for block in ["env", "headers"] {
                let Some(obj) = cfg[block].as_object() else {
                    continue;
                };
                for val in obj.values() {
                    if let Some(s) = val.as_str() {
                        if is_secretish(s) {
                            secrets.push(s.to_string());
                        }
                    }
                }
                // Structural, and immune to a value that happens to look like
                // something the payload may legitimately carry: whatever the
                // payload lists for this server must be the config's KEYS.
                let row = gov["claude"]["mcpServers"]
                    .as_array()
                    .and_then(|a| a.iter().find(|r| r["name"] == Value::from(name.as_str())))
                    .cloned()
                    .unwrap_or(Value::Null);
                let listed: Vec<String> = row[if block == "env" { "env" } else { "headers" }]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str())
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default();
                for l in &listed {
                    assert!(
                        obj.contains_key(l.as_str()),
                        "{name}.{block} lists {l:?}, which is not a key in that block — \
                         the payload is carrying a value"
                    );
                }
            }
        }
    }
    // Codex keeps its env values in config.toml. Anything quoted after an "="
    // inside an `[mcp_servers.*.env]` table counts, and being over-inclusive
    // here only makes the assertion stricter.
    if let Ok(text) = std::fs::read_to_string(home().join(".codex").join("config.toml")) {
        let mut in_env = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('[') {
                in_env = t.starts_with("[mcp_servers.") && t.ends_with(".env]");
                continue;
            }
            if !in_env {
                continue;
            }
            if let Some((_, v)) = t.split_once('=') {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                if is_secretish(v) {
                    secrets.push(v.to_string());
                }
            }
        }
    }

    if secrets.is_empty() {
        skip(
            "mcp credentials",
            "no MCP server here is configured with a credential-shaped env or header value",
        );
        return;
    }
    for s in &secrets {
        assert!(
            !blob.contains(s.as_str()),
            "an MCP credential value reached the governance payload"
        );
    }
    note(
        "mcp credentials",
        &format!(
            "{} configured value(s), none of them in the payload",
            secrets.len()
        ),
    );
}

// ── the shape the server is promised ────────────────────────────────────

#[test]
fn the_payload_has_the_shape_the_board_reads() {
    // The server accepts whatever it is sent, so nothing downstream will catch
    // a renamed field. This is the only place that does.
    let snap = collect::collect();
    for key in ["host", "agentVersion", "collectedAt", "metrics"] {
        assert!(!snap[key].is_null(), "a reading must carry {key}");
    }
    assert!(
        transcripts::parse_iso(snap["collectedAt"].as_str().unwrap_or("")).is_some(),
        "collectedAt must be a timestamp the server can parse"
    );
    let u = &snap["metrics"]["usage"];
    if u["available"].as_bool().unwrap_or(false) {
        for key in [
            "scan", "pricing", "blocks", "allTime", "byModel", "byDay", "windows", "sessions",
            "tools",
        ] {
            assert!(!u[key].is_null(), "usage is missing {key}");
        }
        let all = &u["allTime"];
        assert!(
            all["estUSD"].as_f64().unwrap_or(-1.0) >= 0.0,
            "estUSD must be a number"
        );
        for key in ["in", "out", "cacheRead", "cacheWrite"] {
            assert!(
                all["tokens"][key].is_number(),
                "allTime.tokens is missing {key}"
            );
        }
    }
    // Every dollar figure has to arrive labelled. The rate card travels with
    // the payload precisely so the label cannot be lost on the way to a screen.
    if u["available"].as_bool().unwrap_or(false) {
        let note_text = u["pricing"]["note"].as_str().unwrap_or("");
        assert!(
            note_text.contains("Not what you were charged"),
            "the estimate must ship with the sentence that says it is an estimate"
        );
    }
    note(
        "payload",
        "every field the board reads is present and named as expected",
    );
}

// ── what the agent writes ───────────────────────────────────────────────

#[test]
fn the_agent_writes_only_its_own_directory() {
    // Point the state directory somewhere disposable and assert that a full
    // reading creates files there and nowhere near ~/.claude.
    let tmp = std::env::temp_dir().join(format!("tokenhud-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let saved = std::env::var("TOKENHUD_STATE").ok();
    std::env::set_var("TOKENHUD_STATE", &tmp);

    let claude = transcripts::claude_dir();
    let before = dir_mtime(&claude);
    let _ = collect::collect();
    let after = dir_mtime(&claude);

    let wrote_index = tmp.join("transcripts.json").exists();
    match saved {
        Some(v) => std::env::set_var("TOKENHUD_STATE", v),
        None => std::env::remove_var("TOKENHUD_STATE"),
    }
    let _ = std::fs::remove_dir_all(&tmp);

    assert_eq!(
        before,
        after,
        "the agent modified {} — it must only write its own state",
        claude.display()
    );
    if claude.join("projects").is_dir() {
        assert!(
            wrote_index,
            "the transcript index should have been written to TOKENHUD_STATE"
        );
    }
    note(
        "writes",
        "the index lands in TOKENHUD_STATE and ~/.claude is untouched",
    );
}

fn dir_mtime(p: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

// ── the payload the board is actually served ────────────────────────────

#[test]
fn a_reading_round_trips_through_json() {
    let snap = collect::collect();
    let text = serde_json::to_string(&snap).expect("serialises");
    let back: Value = serde_json::from_str(&text).expect("parses");
    assert_eq!(
        snap, back,
        "a reading must survive the trip it is about to take"
    );
    note(
        "payload",
        &format!("{:.0} KB round-trips exactly", text.len() as f64 / 1024.0),
    );
}
