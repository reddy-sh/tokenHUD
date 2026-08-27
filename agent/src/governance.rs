//! Governance — what each assistant is *allowed* to do on this machine.
//!
//! Every other collector answers "what did it spend". This one answers "what
//! can it reach": which MCP servers are mounted, which permission rules stand,
//! what runs on a hook, which plugins, skills and subagents are installed. On a
//! machine where an agent can run commands and call out to servers, that is the
//! half of the picture a token counter never shows.
//!
//! Three rules shape what leaves here, and all three are about the difference
//! between an inventory and a leak:
//!
//!   · **Names, never values.** An MCP server's `env` block is where an API key
//!     lives. The variable NAMES are reported — that is the governance fact,
//!     "this server is handed GITHUB_TOKEN" — and the values are never read
//!     into the payload at all. Same for headers.
//!   · **Rules are truncated.** A permission rule and a hook command are the
//!     user's own text and can be long; both are clipped before they cross a
//!     network, and a hook's command is reported as the program it runs.
//!   · **Configured and used are separate facts.** A server listed in a config
//!     file is not a server that has ever been called. The transcripts say
//!     which ones actually were, and the board shows both columns rather than
//!     conflating them — an MCP server mounted and never used is the single
//!     most useful row in this panel.

use crate::transcripts::{claude_dir, home};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn clip(s: &str, n: usize) -> String {
    let out: String = s.chars().take(n).collect();
    if out.chars().count() < s.chars().count() {
        format!("{out}…")
    } else {
        out
    }
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| clip(s, 160))
                .collect()
        })
        .unwrap_or_default()
}

/// The last path component of a command, which is the part that identifies it.
/// A hook command is a shell line; the whole line is the user's business and
/// the program name is the governance fact.
fn program(cmd: &str) -> String {
    let first = cmd.split_whitespace().next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    if base.is_empty() {
        "—".to_string()
    } else {
        base.to_string()
    }
}

// ── Claude Code ─────────────────────────────────────────────────────────

fn settings_files() -> Vec<(&'static str, PathBuf)> {
    vec![
        ("user", claude_dir().join("settings.json")),
        ("local", claude_dir().join("settings.local.json")),
    ]
}

/// One MCP server, as a row the board can put beside a call count.
fn mcp_row(scope: &str, name: &str, cfg: &Value) -> Value {
    let get = |k: &str| cfg.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let url = get("url");
    let command = get("command");
    let (transport, target) = if !url.is_empty() {
        // The host, not the full URL: a query string can carry a token.
        let host = url
            .split("://")
            .nth(1)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or(url);
        ("http", host.to_string())
    } else if !command.is_empty() {
        let args = strs(cfg.get("args"));
        let line = if args.is_empty() {
            command.to_string()
        } else {
            format!("{} {}", command, args.join(" "))
        };
        ("stdio", clip(&line, 120))
    } else {
        ("unknown", String::new())
    };

    // Names only. This is the one place in the codebase where reading a value
    // would hand an API key to a network payload, so the value side of this
    // map is never touched.
    let env: Vec<String> = cfg
        .get("env")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let headers: Vec<String> = cfg
        .get("headers")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    json!({
        "name": name,
        "scope": scope,
        "transport": transport,
        "target": target,
        "env": env,
        "headers": headers,
        // Absent means on: Claude Code mounts a configured server unless it is
        // switched off, so a missing key is not "unknown", it is "enabled".
        "enabled": cfg.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        // Set here rather than only where the auth cache is read, so the key
        // is present on every reading. Snapshots are stored as structural
        // differences, and a key that comes and goes is churn with no news.
        "needsAuth": false,
    })
}

fn permissions(all: &[(String, Value)]) -> Value {
    let mut out = Map::new();
    for bucket in ["allow", "deny", "ask"] {
        let mut rows: Vec<Value> = Vec::new();
        for (scope, s) in all {
            // Already clipped by `strs`. A rule is the user's own text and can
            // be a whole shell line; it crosses a network, so it travels short.
            for r in strs(s.get("permissions").and_then(|p| p.get(bucket))) {
                rows.push(json!({"rule": r, "scope": scope}));
            }
        }
        out.insert(bucket.to_string(), json!(rows));
    }
    let mode = all
        .iter()
        .find_map(|(_, s)| {
            s.get("permissions")
                .and_then(|p| p.get("defaultMode"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string());
    let extra: Vec<String> = all
        .iter()
        .flat_map(|(_, s)| {
            strs(
                s.get("permissions")
                    .and_then(|p| p.get("additionalDirectories")),
            )
        })
        .collect();
    out.insert("defaultMode".into(), json!(mode));
    out.insert("additionalDirectories".into(), json!(extra));
    Value::Object(out)
}

fn hooks(all: &[(String, Value)]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let none: Vec<Value> = Vec::new();
    for (scope, s) in all {
        let Some(obj) = s.get("hooks").and_then(|v| v.as_object()) else {
            continue;
        };
        for (event, matchers) in obj {
            let Some(list) = matchers.as_array() else {
                continue;
            };
            let mut programs: Vec<String> = Vec::new();
            let mut matches: Vec<String> = Vec::new();
            for m in list {
                if let Some(pat) = m.get("matcher").and_then(|v| v.as_str()) {
                    if !pat.is_empty() {
                        matches.push(clip(pat, 60));
                    }
                }
                for h in m.get("hooks").and_then(|v| v.as_array()).unwrap_or(&none) {
                    if let Some(c) = h.get("command").and_then(|v| v.as_str()) {
                        programs.push(program(c));
                    }
                }
            }
            programs.sort();
            programs.dedup();
            out.push(json!({
                "event": event,
                "scope": scope,
                "matchers": matches,
                "programs": programs,
                "count": list.len(),
            }));
        }
    }
    out.sort_by(|a, b| a["event"].as_str().cmp(&b["event"].as_str()));
    out
}

/// Directory entries as an inventory: names, never contents.
fn names_in(dir: &Path, want_dirs: bool) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let is_dir = p.is_dir();
            if want_dirs != is_dir {
                return None;
            }
            let n = p.file_name()?.to_string_lossy().into_owned();
            if n.starts_with('.') {
                return None;
            }
            Some(if want_dirs {
                n
            } else {
                n.trim_end_matches(".md").to_string()
            })
        })
        .collect();
    out.sort();
    out
}

fn plugins(all: &[(String, Value)]) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    // What is switched on, from settings; what is installed, from the plugin
    // directory's own config. A plugin present in one and not the other is
    // exactly the drift this panel exists to show.
    let mut seen: Vec<String> = Vec::new();
    let mut push = |name: &str, enabled: Option<bool>, installed: bool, seen: &mut Vec<String>| {
        if let Some(i) = seen.iter().position(|n| n.as_str() == name) {
            if installed {
                rows[i]["installed"] = json!(true);
            }
            if let Some(e) = enabled {
                rows[i]["enabled"] = json!(e);
            }
            return;
        }
        seen.push(name.to_string());
        rows.push(json!({
            "name": name,
            "enabled": enabled.unwrap_or(false),
            "installed": installed,
        }));
    };

    for (_, s) in all {
        if let Some(obj) = s.get("enabledPlugins").and_then(|v| v.as_object()) {
            for (name, on) in obj {
                push(name, on.as_bool(), false, &mut seen);
            }
        }
    }
    if let Some(cfg) = read_json(&claude_dir().join("plugins").join("config.json")) {
        if let Some(obj) = cfg.get("installedPlugins").and_then(|v| v.as_object()) {
            for name in obj.keys() {
                push(name, None, true, &mut seen);
            }
        }
        if let Some(obj) = cfg.get("repositories").and_then(|v| v.as_object()) {
            for (repo, r) in obj {
                if let Some(list) = r.get("plugins").and_then(|v| v.as_object()) {
                    for name in list.keys() {
                        push(&format!("{name}@{repo}"), None, true, &mut seen);
                    }
                }
            }
        }
    }
    if let Some(v) = read_json(&claude_dir().join("plugins").join("installed_plugins.json")) {
        if let Some(obj) = v.as_object() {
            for name in obj.keys() {
                push(name, None, true, &mut seen);
            }
        }
    }
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    rows
}

/// The knobs that change what an agent will do without asking.
fn posture(all: &[(String, Value)]) -> Value {
    let first = |k: &str| all.iter().find_map(|(_, s)| s.get(k).cloned());
    let b = |k: &str| first(k).and_then(|v| v.as_bool());
    json!({
        "model": first("model").and_then(|v| v.as_str().map(str::to_string)),
        "effortLevel": first("effortLevel").and_then(|v| v.as_str().map(str::to_string)),
        "autoCompact": b("autoCompactEnabled"),
        "alwaysThinking": b("alwaysThinkingEnabled"),
        "remoteControlAtStartup": b("remoteControlAtStartup"),
        // The one with teeth: it suppresses the prompt that stands between
        // --dangerously-skip-permissions and everything on the disk.
        "skipDangerousModePrompt": b("skipDangerousModePermissionPrompt"),
        "statusLine": first("statusLine").is_some(),
        "includeCoAuthoredBy": b("includeCoAuthoredBy"),
    })
}

pub fn collect_claude() -> Value {
    let files: Vec<(String, Value)> = settings_files()
        .into_iter()
        .filter_map(|(scope, p)| read_json(&p).map(|v| (scope.to_string(), v)))
        .collect();
    let sources: Vec<String> = settings_files()
        .into_iter()
        .filter(|(_, p)| p.is_file())
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .collect();

    let mut servers: Vec<Value> = Vec::new();
    for (scope, s) in &files {
        if let Some(obj) = s.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, cfg) in obj {
                servers.push(mcp_row(scope, name, cfg));
            }
        }
    }
    // Which of them Claude Code could not sign in to. A server that is mounted,
    // configured and unauthenticated is a row that looks fine everywhere else.
    if let Some(v) = read_json(&claude_dir().join("mcp-needs-auth-cache.json")) {
        let needs: Vec<String> = match &v {
            Value::Object(o) => o.keys().cloned().collect(),
            Value::Array(a) => a
                .iter()
                .filter_map(|x| x.as_str())
                .map(String::from)
                .collect(),
            _ => Vec::new(),
        };
        for row in servers.iter_mut() {
            let name = row["name"].as_str().unwrap_or("").to_string();
            row["needsAuth"] = json!(needs.contains(&name));
        }
    }
    servers.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    let agents = names_in(&claude_dir().join("agents"), false);
    let skills = names_in(&claude_dir().join("skills"), true);

    json!({
        "available": !files.is_empty(),
        "sources": sources,
        "posture": posture(&files),
        "permissions": permissions(&files),
        "hooks": hooks(&files),
        "mcpServers": servers,
        "plugins": plugins(&files),
        "skills": skills,
        "agents": agents,
        "note": "Read from Claude Code's own settings files. Environment variables and \
                 headers are listed by NAME only — no value from an MCP server's \
                 credentials block is ever read into this payload.",
    })
}

// ── Codex CLI ───────────────────────────────────────────────────────────
//
// `~/.codex/config.toml`, read by a deliberately narrow scanner rather than a
// TOML library. The agent is judged on what it costs to leave running and a
// full parser is a dependency for one file; what is needed here is section
// headers and scalar `key = value` lines, which is a shape this can state and
// hold to. Anything it does not understand is skipped rather than guessed at.

/// A minimal TOML reader: `[section]` headers and `key = value` scalars.
/// Multi-line values, inline tables and arrays of tables are not understood and
/// are skipped — every caller below reads scalars out of named sections.
struct Toml {
    /// (section, key, value) in file order, values still quoted as written.
    rows: Vec<(String, String, String)>,
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

/// Split a bracket header into its dotted parts, honouring quoted segments so
/// that `[projects."/a/b.c"]` is two parts and not four.
fn header_parts(h: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in h.chars() {
        match c {
            '"' => quoted = !quoted,
            '.' if !quoted => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    out.push(cur.trim().to_string());
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

impl Toml {
    fn parse(text: &str) -> Toml {
        let mut rows = Vec::new();
        let mut section = String::new();
        for line in text.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            if let Some(h) = t.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
                section =
                    header_parts(h.trim_start_matches('[').trim_end_matches(']')).join("\u{1}");
                continue;
            }
            let Some((k, v)) = t.split_once('=') else {
                continue;
            };
            rows.push((section.clone(), unquote(k), v.trim().to_string()));
        }
        Toml { rows }
    }

    fn get(&self, section: &str, key: &str) -> Option<&str> {
        self.rows
            .iter()
            .find(|(s, k, _)| s.as_str() == section && k.as_str() == key)
            .map(|(_, _, v)| v.as_str())
    }

    fn scalar(&self, section: &str, key: &str) -> Option<String> {
        self.get(section, key).map(unquote)
    }

    fn boolean(&self, section: &str, key: &str) -> Option<bool> {
        self.get(section, key).and_then(|v| v.trim().parse().ok())
    }

    /// The distinct immediate children of a section, in file order —
    /// `[mcp_servers.github]` under `mcp_servers` yields `github`.
    fn children(&self, parent: &str) -> Vec<String> {
        let prefix = format!("{parent}\u{1}");
        let mut out: Vec<String> = Vec::new();
        for (s, _, _) in &self.rows {
            let Some(rest) = s.strip_prefix(prefix.as_str()) else {
                continue;
            };
            let name = rest.split('\u{1}').next().unwrap_or(rest).to_string();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
        out
    }

    /// Keys declared directly in a section — used for `env`, where the keys are
    /// the whole reportable fact and the values are credentials.
    fn keys(&self, section: &str) -> Vec<String> {
        self.rows
            .iter()
            .filter(|(s, _, _)| s.as_str() == section)
            .map(|(_, k, _)| k.clone())
            .collect()
    }
}

pub fn codex_home() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(v) if !v.is_empty() => crate::transcripts::expand_tilde(&v),
        _ => home().join(".codex"),
    }
}

pub fn collect_codex() -> Value {
    let path = codex_home().join("config.toml");
    let Ok(text) = fs::read_to_string(&path) else {
        return json!({"available": false, "reason": "no config.toml"});
    };
    let t = Toml::parse(&text);

    let mut servers: Vec<Value> = Vec::new();
    for name in t.children("mcp_servers") {
        let sec = format!("mcp_servers\u{1}{name}");
        let url = t.scalar(&sec, "url").unwrap_or_default();
        let command = t.scalar(&sec, "command").unwrap_or_default();
        let (transport, target) = if !url.is_empty() {
            let host = url
                .split("://")
                .nth(1)
                .unwrap_or(&url)
                .split('/')
                .next()
                .unwrap_or(&url)
                .to_string();
            ("http", host)
        } else if !command.is_empty() {
            (
                "stdio",
                clip(command.rsplit('/').next().unwrap_or(&command), 120),
            )
        } else {
            ("unknown", String::new())
        };
        servers.push(json!({
            "name": name,
            "scope": "user",
            "transport": transport,
            "target": target,
            // Names only, same rule as the Claude side.
            "env": t.keys(&format!("{sec}\u{1}env")),
            "headers": Vec::<String>::new(),
            "enabled": t.boolean(&sec, "enabled").unwrap_or(true),
        }));
    }
    servers.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    let plugins: Vec<Value> = t
        .children("plugins")
        .into_iter()
        .map(|name| {
            let enabled = t
                .boolean(&format!("plugins\u{1}{name}"), "enabled")
                .unwrap_or(true);
            json!({"name": name, "enabled": enabled, "installed": true})
        })
        .collect();

    let trusted = t
        .children("projects")
        .into_iter()
        .filter(|p| {
            t.scalar(&format!("projects\u{1}{p}"), "trust_level")
                .as_deref()
                == Some("trusted")
        })
        .count();

    let features: Vec<Value> = t
        .keys("features")
        .into_iter()
        .map(|k| json!({"name": k.clone(), "on": t.boolean("features", &k).unwrap_or(false)}))
        .collect();

    json!({
        "available": true,
        "sources": [path.to_string_lossy()],
        "posture": {
            "model": t.scalar("", "model"),
            "effortLevel": t.scalar("", "model_reasoning_effort"),
            // Codex records the policy it actually ran under on every turn, so
            // the enforced values come from the rollouts (codex.rs) rather than
            // from here. What config.toml carries is the default.
            "approvalPolicy": t.scalar("", "approval_policy"),
            "sandboxMode": t.scalar("", "sandbox_mode"),
            "personality": t.scalar("", "personality"),
            "trustedProjects": trusted,
        },
        "mcpServers": servers,
        "plugins": plugins,
        "features": features,
        "skills": names_in(&codex_home().join("skills"), true),
        "note": "Read from ~/.codex/config.toml. Environment variables are listed by \
                 NAME only. The policy actually enforced per session is read from the \
                 rollouts instead, and shown beside this one.",
    })
}

pub fn collect() -> Value {
    json!({
        "claude": collect_claude(),
        "codex": collect_codex(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_mcp_servers_credentials_are_named_and_never_read() {
        let cfg: Value = serde_json::from_str(
            r#"{"command":"uvx","args":["mcp-server-git"],
                "env":{"GITHUB_TOKEN":"ghp_realsecret","OTHER":"x"}}"#,
        )
        .unwrap();
        let row = mcp_row("user", "git", &cfg);
        let dumped = serde_json::to_string(&row).unwrap();
        assert!(dumped.contains("GITHUB_TOKEN"));
        assert!(
            !dumped.contains("ghp_realsecret"),
            "an env VALUE reached the payload"
        );
        assert_eq!(row["target"], "uvx mcp-server-git");
        assert_eq!(row["transport"], "stdio");
    }

    #[test]
    fn a_url_server_is_reported_by_host_not_by_query_string() {
        let cfg: Value =
            serde_json::from_str(r#"{"url":"https://api.example.com/mcp/?token=secret"}"#).unwrap();
        let row = mcp_row("user", "s", &cfg);
        assert_eq!(row["target"], "api.example.com");
        assert!(!serde_json::to_string(&row).unwrap().contains("secret"));
    }

    #[test]
    fn a_configured_server_is_enabled_unless_it_says_otherwise() {
        let on: Value = serde_json::from_str(r#"{"url":"https://a/b"}"#).unwrap();
        let off: Value = serde_json::from_str(r#"{"url":"https://a/b","enabled":false}"#).unwrap();
        assert_eq!(mcp_row("user", "s", &on)["enabled"], true);
        assert_eq!(mcp_row("user", "s", &off)["enabled"], false);
    }

    #[test]
    fn the_toml_reader_finds_sections_keys_and_quoted_paths() {
        let t = Toml::parse(
            r#"
model = "gpt-5.4"
# a comment
[mcp_servers.github]
enabled = true
url = "https://api.githubcopilot.com/mcp/"

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/x/.codex"
SECRET_KEY = "sk-live-do-not-ship"

[projects."/Users/x/p.roj"]
trust_level = "trusted"
"#,
        );
        assert_eq!(t.scalar("", "model").as_deref(), Some("gpt-5.4"));
        assert_eq!(t.children("mcp_servers"), vec!["github", "node_repl"]);
        assert_eq!(t.boolean("mcp_servers\u{1}github", "enabled"), Some(true));
        // A dotted path inside quotes is ONE section name, not two.
        assert_eq!(t.children("projects"), vec!["/Users/x/p.roj"]);
        assert_eq!(
            t.keys("mcp_servers\u{1}node_repl\u{1}env"),
            vec!["CODEX_HOME", "SECRET_KEY"]
        );
    }

    #[test]
    fn a_hook_is_reported_as_the_program_it_runs() {
        assert_eq!(program("/usr/local/bin/notify --loud 'hi there'"), "notify");
        assert_eq!(program("python3 ~/.claude/hooks/x.py"), "python3");
        assert_eq!(program(""), "—");
    }

    #[test]
    fn a_machine_without_codex_config_says_so_rather_than_showing_empty_tables() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("CODEX_HOME", "/nonexistent/definitely/not/here");
        let v = collect_codex();
        std::env::remove_var("CODEX_HOME");
        assert_eq!(v["available"], false);
        assert!(v.get("mcpServers").is_none());
    }
}
