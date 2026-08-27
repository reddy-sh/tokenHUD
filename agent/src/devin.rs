//! Devin — two products, two stores, one rule: never read a conversation.
//!
//! **Devin CLI** ("devin for terminal") writes `~/.local/share/devin/cli/sessions.db`,
//! a SQLite file that MIXES config and content in one file. It is read through
//! the `sqlite3` CLI, read-only, with a column-scoped query — exactly as the
//! process collector shells out to `ps` — so the agent stays dependency-free and
//! the query physically cannot name a content table. Each session row carries
//! real usage in its `metadata` JSON: `total_credit_cost` and `total_acu_cost`.
//! That is genuine local cost, no network and no API key.
//!
//! **Devin Desktop** (a Windsurf/VS Code fork) writes one SQLite per session
//! under `~/Library/Application Support/Devin/User/acp-messages/`. Those hold the
//! conversation and NO usage, so they are only COUNTED, never opened.
//!
//! **Governance**, from Devin's documented config (names only, secrets never):
//!   `~/.config/devin/mcp_config.json`   MCP servers  → name/command/url, never env/headers
//!   `~/.config/devin/agents/*.md`       custom subagents → filename, never the body
//!
//! Never read: the content tables (`prompt_history`, `message_nodes`,
//! `tool_call_state`), `sessions.title`, `sessions.cogs_json`, `credentials.toml`,
//! and any MCP `env`/`headers` value.
//!
//! Credits are reported as credits. A credit→dollar conversion is a rate this
//! agent does not know, and inventing one would be the "present a calculation as
//! a measurement" mistake the rest of this codebase refuses.

use crate::transcripts::home;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::process::Command;

fn data_home() -> PathBuf {
    match std::env::var("XDG_DATA_HOME") {
        Ok(v) if !v.is_empty() => crate::transcripts::expand_tilde(&v),
        _ => home().join(".local").join("share"),
    }
}

fn config_home() -> PathBuf {
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(v) if !v.is_empty() => crate::transcripts::expand_tilde(&v),
        _ => home().join(".config"),
    }
}

/// The Devin CLI session store — SQLite, mixed content, read column-scoped only.
pub fn cli_db() -> PathBuf {
    data_home().join("devin").join("cli").join("sessions.db")
}

/// The Devin Desktop per-session conversation DBs — counted, never opened.
pub fn desktop_sessions_dir() -> PathBuf {
    home()
        .join("Library")
        .join("Application Support")
        .join("Devin")
        .join("User")
        .join("acp-messages")
}

/// Devin CLI's MCP server config. `mcp_config.json` since CLI v3000.3; the older
/// `mcpServers` key inside `config.json` is the fallback.
pub fn mcp_config() -> PathBuf {
    config_home().join("devin").join("mcp_config.json")
}

fn devin_config() -> PathBuf {
    config_home().join("devin").join("config.json")
}

/// Devin CLI's custom subagents — `<name>.md` files.
pub fn agents_dir() -> PathBuf {
    config_home().join("devin").join("agents")
}

/// The `sqlite3` binary, if the machine has one. macOS ships `/usr/bin/sqlite3`;
/// most Linux does too. Absent → Devin CLI cost degrades to "sessions only",
/// which is stated on the card rather than guessed at.
pub(crate) fn sqlite3_bin() -> Option<String> {
    for cand in [
        "sqlite3",
        "/usr/bin/sqlite3",
        "/opt/homebrew/opt/sqlite/bin/sqlite3",
    ] {
        if cand.contains('/') {
            if std::path::Path::new(cand).is_file() {
                return Some(cand.to_string());
            }
        } else if Command::new(cand)
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return Some(cand.to_string());
        }
    }
    None
}

struct Cli {
    sessions: usize,
    credits: i64,
    acu: f64,
    by_model: Vec<(String, i64)>, // model -> credits
    priced: usize,
    sqlite_missing: bool,
}

/// Read the CLI sessions DB through `sqlite3`, naming ONLY safe columns. The
/// query never mentions `prompt_history`, `message_nodes`, `title`, or
/// `cogs_json`, so no conversation content can be returned even in principle.
fn read_cli() -> Option<Cli> {
    let db = cli_db();
    if !db.is_file() {
        return None;
    }
    let Some(sqlite) = sqlite3_bin() else {
        return Some(Cli {
            sessions: 0,
            credits: 0,
            acu: 0.0,
            by_model: Vec::new(),
            priced: 0,
            sqlite_missing: true,
        });
    };
    // One JSON object per session: slug, model, cost. No content columns.
    let q = "SELECT json_object(\
             'model', COALESCE(NULLIF(model,''),'unknown'),\
             'credit', COALESCE(json_extract(metadata,'$.total_credit_cost'),0),\
             'acu', COALESCE(json_extract(metadata,'$.total_acu_cost'),0)) \
             FROM sessions;";
    let out = Command::new(&sqlite)
        .arg("-readonly")
        .arg(&db)
        .arg(q)
        .output()
        .ok()?;
    if !out.status.success() {
        return Some(Cli {
            sessions: 0,
            credits: 0,
            acu: 0.0,
            by_model: Vec::new(),
            priced: 0,
            sqlite_missing: false,
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut sessions = 0;
    let mut credits = 0i64;
    let mut acu = 0.0f64;
    let mut priced = 0;
    let mut by: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        sessions += 1;
        let c = v.get("credit").and_then(|x| x.as_i64()).unwrap_or(0);
        let a = v.get("acu").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let model = v
            .get("model")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        credits += c;
        acu += a;
        if c > 0 || a > 0.0 {
            priced += 1;
        }
        *by.entry(model).or_insert(0) += c;
    }
    let mut by_model: Vec<(String, i64)> = by.into_iter().filter(|(_, c)| *c > 0).collect();
    by_model.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
    Some(Cli {
        sessions,
        credits,
        acu,
        by_model,
        priced,
        sqlite_missing: false,
    })
}

fn count_desktop_sessions() -> Option<usize> {
    let dir = desktop_sessions_dir();
    let rd = std::fs::read_dir(&dir).ok()?;
    Some(
        rd.flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("db"))
            .count(),
    )
}

fn last_active() -> Option<String> {
    // Newest mtime across both stores, never opening a file.
    let mut newest: Option<std::time::SystemTime> = None;
    let mut consider = |p: PathBuf| {
        if let Ok(md) = std::fs::metadata(&p) {
            if let Ok(t) = md.modified() {
                // is_none_or is 1.82; this crate declares 1.75.
                if newest.map_or(true, |n| t > n) {
                    newest = Some(t);
                }
            }
        }
    };
    consider(cli_db());
    if let Ok(rd) = std::fs::read_dir(desktop_sessions_dir()) {
        for e in rd.flatten() {
            consider(e.path());
        }
    }
    newest
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
        .map(crate::collect::iso_of)
}

/// MCP server NAMES, from Devin's config. Names and transports only — the whole
/// point of reading it is "which servers", and `env`/`headers` hold secrets that
/// must never leave the machine, so they are not even parsed out.
fn mcp_servers() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut from = |v: &Value| {
        if let Some(obj) = v.get("mcpServers").and_then(|m| m.as_object()) {
            for k in obj.keys() {
                if !names.contains(k) {
                    names.push(k.clone());
                }
            }
        }
    };
    if let Ok(t) = std::fs::read_to_string(mcp_config()) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            from(&v);
        }
    }
    if let Ok(t) = std::fs::read_to_string(devin_config()) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            from(&v); // legacy location
        }
    }
    names.sort();
    names
}

/// Custom-subagent names, from filenames only — never the file body (prose).
fn agent_names() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(agents_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            } else if p.is_dir() {
                if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// Opt-in cloud usage from the Devin API. OFF unless `TOKENHUD_DEVIN_TOKEN` and
/// `TOKENHUD_DEVIN_ORG` are set — this is the one place the agent makes an
/// outbound call, so it never happens unless the user asks for it by setting
/// those. Returns org ACU consumption and session/PR counts, or a "connect it"
/// hint when the token is absent. On a free personal plan the org is empty and
/// these read zero; the local session store is the richer source there.
fn api_usage() -> Map<String, Value> {
    let mut m = Map::new();
    let token = std::env::var("TOKENHUD_DEVIN_TOKEN").unwrap_or_default();
    let org = std::env::var("TOKENHUD_DEVIN_ORG").unwrap_or_default();
    if token.is_empty() || org.is_empty() {
        m.insert("apiConnected".into(), json!(false));
        m.insert(
            "apiHint".into(),
            json!("Connect Devin's API for org ACU and session metrics: create a service-user                    token at app.devin.ai → Settings → Devin API, then set TOKENHUD_DEVIN_TOKEN                    and TOKENHUD_DEVIN_ORG. The agent calls api.devin.ai only when both are set."),
        );
        return m;
    }
    let base = format!("https://api.devin.ai/v3/organizations/{org}");
    let get = |path: &str| -> Option<Value> {
        let res = ureq::get(&format!("{base}{path}"))
            .config()
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .http_status_as_error(false)
            .build()
            .header("Authorization", &format!("Bearer {token}"))
            .header(
                "User-Agent",
                &format!("tokenhud-agent/{}", crate::collect::AGENT_VERSION),
            )
            .call()
            .ok()?;
        if res.status().as_u16() != 200 {
            return None;
        }
        let text = res.into_body().read_to_string().ok()?;
        serde_json::from_str(&text).ok()
    };

    m.insert("apiConnected".into(), json!(true));
    if let Some(c) = get("/consumption/daily") {
        m.insert(
            "apiAcus".into(),
            c.get("total_acus").cloned().unwrap_or(json!(0)),
        );
        if let Some(days) = c.get("consumption_by_date") {
            m.insert("apiByDate".into(), days.clone());
        }
    }
    if let Some(u) = get("/metrics/usage") {
        for k in [
            "sessions_count",
            "prs_created_count",
            "prs_merged_count",
            "searches_count",
        ] {
            if let Some(v) = u.get(k) {
                m.insert(format!("api_{k}"), v.clone());
            }
        }
    }
    m
}

/// The whole Devin picture as extra fields to merge into the assistant row, or
/// `None` when nothing Devin is present. Everything here is non-content.
pub fn activity() -> Option<Map<String, Value>> {
    let cli = read_cli();
    let desktop = count_desktop_sessions();
    if cli.is_none() && desktop.is_none() {
        return None;
    }
    let cli_sessions = cli.as_ref().map(|c| c.sessions).unwrap_or(0);
    let desktop_sessions = desktop.unwrap_or(0);

    let mut m = Map::new();
    m.insert("sessions".into(), json!(cli_sessions + desktop_sessions));
    m.insert("cliSessions".into(), json!(cli_sessions));
    m.insert("desktopSessions".into(), json!(desktop_sessions));
    if let Some(la) = last_active() {
        m.insert("lastActive".into(), json!(la));
    }
    m.insert("paths".into(), json!(paths_present()));

    let mcp = mcp_servers();
    let agents = agent_names();
    m.insert("mcpServers".into(), json!(mcp));
    m.insert("agents".into(), json!(agents));

    let mut note = String::from(
        "Devin CLI and Desktop, from files already on disk — the conversations \
         themselves are counted, never opened.",
    );
    if let Some(c) = &cli {
        // Credits are real and local. ACU too. Neither is priced in dollars here.
        m.insert("credits".into(), json!(c.credits));
        m.insert("acu".into(), json!((c.acu * 100.0).round() / 100.0));
        m.insert("priced".into(), json!(false)); // it is a credit count, not a dollar figure
        m.insert(
            "byModel".into(),
            json!(c
                .by_model
                .iter()
                .map(|(model, cr)| json!({"model": model, "credits": cr}))
                .collect::<Vec<_>>()),
        );
        if c.sqlite_missing {
            note = "Devin CLI sessions counted; credit cost needs `sqlite3`, which is not \
                    installed — install it and the cost appears."
                .into();
        } else if c.credits > 0 {
            note = format!(
                "Devin CLI: {} credits across {} of {} sessions (real, from the local session \
                 store). Credits, not dollars — no conversion is invented. Desktop sessions add \
                 activity only.",
                c.credits, c.priced, c.sessions
            );
        }
    }
    for (k, v) in api_usage() {
        m.insert(k, v);
    }

    m.insert("note".into(), json!(note));
    Some(m)
}

fn paths_present() -> Vec<String> {
    [cli_db(), desktop_sessions_dir(), mcp_config(), agents_dir()]
        .into_iter()
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_reader_sums_credits_and_never_names_a_content_table() {
        // A throwaway DB shaped like Devin's: a sessions table with a metadata
        // JSON column, plus a content table the query must never touch.
        let Some(sqlite) = sqlite3_bin() else {
            eprintln!("  skip: no sqlite3 on this machine");
            return;
        };
        let dir = std::env::temp_dir().join(format!("devin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("devin").join("cli")).unwrap();
        let db = dir.join("devin").join("cli").join("sessions.db");
        let seed = "CREATE TABLE sessions(id TEXT, model TEXT, title TEXT, cogs_json TEXT, metadata TEXT);\
                    CREATE TABLE prompt_history(body TEXT);\
                    INSERT INTO sessions VALUES('a','claude-opus-4-6-thinking','SECRET TITLE','SECRET', json_object('total_credit_cost',13600,'total_acu_cost',0));\
                    INSERT INTO sessions VALUES('b','claude-opus-4-6-thinking','T','C', json_object('total_credit_cost',11200,'total_acu_cost',0));\
                    INSERT INTO sessions VALUES('c','', 'T','C', json_object('total_credit_cost',800,'total_acu_cost',0));\
                    INSERT INTO prompt_history VALUES('a user prompt that must never be read');";
        assert!(Command::new(&sqlite)
            .arg(&db)
            .arg(seed)
            .status()
            .unwrap()
            .success());

        std::env::set_var("XDG_DATA_HOME", &dir);
        let c = read_cli().expect("a db");
        std::env::remove_var("XDG_DATA_HOME");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(c.sessions, 3);
        assert_eq!(c.credits, 25600, "credits must be summed from metadata");
        assert_eq!(c.priced, 3);
        // opus got 13600+11200; the empty-model session's 800 is under "unknown"
        assert_eq!(
            c.by_model
                .iter()
                .find(|(m, _)| m == "claude-opus-4-6-thinking")
                .map(|(_, cr)| *cr),
            Some(24800)
        );
    }

    #[test]
    fn a_machine_without_devin_reports_nothing_rather_than_zero() {
        std::env::set_var("XDG_DATA_HOME", "/nonexistent/x");
        std::env::set_var("XDG_CONFIG_HOME", "/nonexistent/y");
        std::env::set_var("HOME", "/nonexistent/z"); // kills the Desktop path too
        let a = activity();
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("XDG_CONFIG_HOME");
        // (HOME is restored by the harness between tests; do not rely on it here)
        assert!(
            a.is_none(),
            "no Devin anywhere must be None, not a zeroed card"
        );
    }

    #[test]
    fn mcp_and_agents_are_names_only() {
        let dir = std::env::temp_dir().join(format!("devin-gov-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = dir.join("devin");
        std::fs::create_dir_all(cfg.join("agents")).unwrap();
        std::fs::write(
            cfg.join("mcp_config.json"),
            r#"{"mcpServers":{"playwright":{"command":"npx","env":{"SECRET":"do-not-surface"}},"context7":{"url":"https://x"}}}"#,
        )
        .unwrap();
        std::fs::write(
            cfg.join("agents").join("reviewer.md"),
            "---\nname: reviewer\n---\nBODY PROSE",
        )
        .unwrap();

        std::env::set_var("XDG_CONFIG_HOME", &dir);
        let mcp = mcp_servers();
        let agents = agent_names();
        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(mcp, vec!["context7".to_string(), "playwright".to_string()]);
        assert_eq!(agents, vec!["reviewer".to_string()]);
    }
}
