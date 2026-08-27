//! `tokenhud-agent enable <tool>` - the only thing this agent writes outside
//! its own state directory, and only when a person types the command.
//!
//! The integrations catalogue has always known what turns an unreadable tool
//! into a readable one; `integrations.rs` carries Gemini CLI's four steps as
//! prose, and a reader still had to open a JSON file and hand-merge a block
//! into it without breaking whatever else was in there. That is a chore with a
//! sharp edge - `settings.json` holds MCP servers and model preferences, and
//! the obvious "just write the file" fix silently destroys them.
//!
//! So this does the merge, and it is built around four refusals rather than
//! around the write:
//!
//!   · **It merges.** Every key already in the file survives, in the order it
//!     was in. Only the keys named below change.
//!   · **It refuses rather than repairs.** A `settings.json` that exists and
//!     does not parse is somebody's broken file, and overwriting it with a
//!     clean one loses the only copy of what they meant to write.
//!   · **It backs up first.** The file as it was goes to `<name>.bak`, at the
//!     mode it already had, before anything is written.
//!   · **It shows the diff and asks.** Not a summary of the change - the
//!     lines. `--print` is the same recipe as JSON, for the case where a
//!     coding agent is doing the edit instead of a person.
//!
//! **This deliberately does not touch consent.** Consent is recorded against
//! the manifest digest, and the digest covers what the reporting loop does
//! unattended - the part that could change under a user who is not watching.
//! `enable` is the opposite of unattended: it is typed by name, it prints what
//! it will do, and it does nothing until the answer is yes. See the
//! RUN_ON_REQUEST section of `manifest.rs`, which declares these paths without
//! folding them into the digest.

use crate::integrations::{Integration, CATALOGUE};
use crate::transcripts::home;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// What `enable <id>` would do, worked out without touching anything.
#[derive(Debug)]
pub struct Plan {
    pub id: &'static str,
    pub name: &'static str,
    pub path: PathBuf,
    /// Where the file as it stands will be copied. `None` when there is no
    /// file yet - backing up a thing that does not exist writes an empty file
    /// that later reads as "it used to be empty", which is a lie about history.
    pub backup: Option<PathBuf>,
    pub before: Option<String>,
    pub after: String,
    /// One line per key that changes, in the file's own terms.
    pub changes: Vec<String>,
    /// The block being merged, for `--print`. Null for the formats edited as
    /// text, where no such object exists.
    pub merge: Value,
    pub format: &'static str,
}

impl Plan {
    /// Nothing to do: the file already says what this would make it say.
    pub fn is_noop(&self) -> bool {
        self.changes.is_empty()
    }

    pub fn diff(&self) -> String {
        diff(
            self.before.as_deref().unwrap_or(""),
            &self.after,
            &self.path.to_string_lossy(),
        )
    }
}

/// The tools this build can enable. Everything else in the catalogue either
/// needs no local change or needs one this agent has no business making.
pub const ENABLEABLE: &[&str] = &["gemini-cli", "aider"];

/// Work out the change without making it.
pub fn plan(id: &str) -> Result<Plan, String> {
    match id {
        "gemini-cli" | "gemini" => gemini(),
        "aider" => aider(),
        other => Err(format!(
            "no recipe for {other:?}. This build can enable: {}",
            ENABLEABLE.join(", ")
        )),
    }
}

/// The catalogue entry this recipe belongs to, so the name, the prose steps
/// and the documentation link have exactly one home. A recipe that drifted
/// from the steps on the board would be two answers to one question.
fn entry(id: &str) -> Option<&'static Integration> {
    CATALOGUE.iter().find(|i| i.id == id)
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

fn backup_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(path.with_file_name(format!("{name}.bak")))
}

// ── gemini-cli ──────────────────────────────────────────────────────────

/// Merge a telemetry block into `~/.gemini/settings.json`.
///
/// The four keys are the ones `integrations.rs` names, and the reasons are
/// there too: `target: "local"` because the documented alternative is an OTLP
/// endpoint and a collector process nobody wants to run; an ABSOLUTE `outfile`
/// because the documented example is relative to the working directory and so
/// scatters one log per project; and `logPrompts: false` because TokenHUD
/// never wants prompt text and this stops the CLI writing any to disk in the
/// first place. Enabling telemetry without that last key would be turning on
/// a feature that records more than the thing asking for it wants.
fn gemini() -> Result<Plan, String> {
    let dir = home().join(".gemini");
    let path = dir.join("settings.json");
    let outfile = dir.join("telemetry.log");
    let before = read_existing(&path)?;

    let mut root: Map<String, Value> = match before.as_deref().map(str::trim) {
        None | Some("") => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => {
                return Err(format!(
                    "{} parses as JSON but is not an object, so there is nothing to merge \
                     into. Refusing to replace it.",
                    path.display()
                ))
            }
            Err(e) => {
                return Err(format!(
                    "{} exists and does not parse as JSON: {e}\n\
                     Refusing to touch it - writing a clean file here would destroy the only \
                     copy of whatever was meant to be in it. Fix the syntax, or move it aside, \
                     then run this again.",
                    path.display()
                ))
            }
        },
    };

    // `preserve_order` is on for this crate, so an existing telemetry block
    // keeps its key order and any key this recipe does not name stays exactly
    // where it was. That is the difference between merging and clobbering.
    let mut telemetry: Map<String, Value> = root
        .get("telemetry")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let wanted = [
        ("enabled", json!(true)),
        ("target", json!("local")),
        ("outfile", json!(outfile.to_string_lossy().into_owned())),
        ("logPrompts", json!(false)),
    ];
    let mut changes = Vec::new();
    let merge = json!({
        "telemetry": Value::Object(
            wanted
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    });
    for (key, want) in wanted {
        match telemetry.get(key) {
            Some(cur) if *cur == want => continue,
            Some(cur) => changes.push(format!("telemetry.{key}: {cur} → {want}")),
            None => changes.push(format!("telemetry.{key}: unset → {want}")),
        }
        telemetry.insert(key.to_string(), want);
    }
    root.insert("telemetry".to_string(), Value::Object(telemetry));

    let after = serde_json::to_string_pretty(&Value::Object(root))
        .map(|s| s + "\n")
        .map_err(|e| format!("could not render the merged settings: {e}"))?;

    Ok(Plan {
        id: "gemini-cli",
        name: entry("gemini-cli").map(|i| i.name).unwrap_or("Gemini CLI"),
        backup: before.as_ref().and(backup_path(&path)),
        path,
        before,
        after,
        changes,
        merge,
        format: "json",
    })
}

// ── aider ───────────────────────────────────────────────────────────────

/// Is this line a top-level `key:` - no indentation, not a comment?
///
/// Indented keys are somebody else's sub-setting and are none of this
/// recipe's business; a nested `analytics:` under another key means something
/// different from the top-level one and must not be rewritten.
fn top_level_key(line: &str) -> Option<&str> {
    if line.starts_with([' ', '\t', '#', '-']) {
        return None;
    }
    let (key, _) = line.split_once(':')?;
    let key = key.trim().trim_matches(['"', '\'']);
    (!key.is_empty()).then_some(key)
}

/// Set `analytics: true` in `~/.aider.conf.yml`.
///
/// This agent ships no YAML parser and is not about to grow one for a single
/// boolean, so the edit is exactly the one a person would make by hand: one
/// top-level line, set or appended, with every other line (comments included)
/// passed through untouched. A parser would have rewritten the file and lost
/// the comments, which is a worse outcome than not having a parser.
///
/// Aider's own analytics upload stays off unless the user opts into that
/// separately; this only writes the local event file, which is the one
/// TokenHUD would read.
fn aider() -> Result<Plan, String> {
    let path = home().join(".aider.conf.yml");
    let before = read_existing(&path)?;
    let text = before.clone().unwrap_or_default();

    let hits: Vec<usize> = text
        .lines()
        .enumerate()
        .filter(|(_, l)| top_level_key(l) == Some("analytics"))
        .map(|(i, _)| i)
        .collect();
    if hits.len() > 1 {
        return Err(format!(
            "{} sets `analytics` on {} separate top-level lines, and which one wins is a \
             question about YAML this recipe will not guess the answer to. Refusing - set it \
             by hand.",
            path.display(),
            hits.len()
        ));
    }

    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut changes = Vec::new();
    match hits.first() {
        Some(&i) => {
            // Compare against the value with any trailing comment removed, so
            // `analytics: true  # keep` is recognised as already set.
            let value = lines[i]
                .split_once(':')
                .map(|(_, v)| v.split('#').next().unwrap_or("").trim().to_string())
                .unwrap_or_default();
            if value != "true" {
                changes.push(format!("analytics: {value} → true"));
                lines[i] = "analytics: true".to_string();
            }
        }
        None => {
            changes.push("analytics: unset → true".to_string());
            lines.push("analytics: true".to_string());
        }
    }
    let after = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    };

    Ok(Plan {
        id: "aider",
        name: entry("aider").map(|i| i.name).unwrap_or("Aider"),
        backup: before.as_ref().and(backup_path(&path)),
        path,
        before,
        after,
        changes,
        merge: Value::Null,
        format: "yaml",
    })
}

// ── the diff ────────────────────────────────────────────────────────────

/// A unified diff of two texts, with three lines of context.
///
/// Common prefix and common suffix are trimmed and everything between them is
/// shown as replaced. That is not the minimal edit script a real diff produces,
/// but on a config file with one block changing it gives exactly the same
/// answer for a fraction of the code, and where it differs it errs by showing
/// the reader MORE of what is about to change, which is the safe direction for
/// something printed above a y/N prompt.
pub fn diff(before: &str, after: &str, label: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head
        && tail < b.len() - head
        && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    if head == a.len() && head == b.len() {
        return String::new();
    }

    const CONTEXT: usize = 3;
    let from = head.saturating_sub(CONTEXT);
    let mut out = format!("--- {label}\n+++ {label}\n@@ line {} @@\n", from + 1);
    for line in &a[from..head] {
        out.push_str(&format!("  {line}\n"));
    }
    for line in &a[head..a.len() - tail] {
        out.push_str(&format!("- {line}\n"));
    }
    for line in &b[head..b.len() - tail] {
        out.push_str(&format!("+ {line}\n"));
    }
    let after_start = a.len() - tail;
    for line in &a[after_start..(after_start + CONTEXT).min(a.len())] {
        out.push_str(&format!("  {line}\n"));
    }
    out
}

// ── writing it ──────────────────────────────────────────────────────────

/// Back up, then write. The only function here that touches the disk.
pub fn apply(plan: &Plan) -> std::io::Result<()> {
    if let Some(dir) = plan.path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if let (Some(before), Some(backup)) = (&plan.before, &plan.backup) {
        std::fs::write(backup, before)?;
        // At the mode the original had, not the default. A `settings.json`
        // kept at 0600 holds something its owner decided was private, and a
        // world-readable copy of it beside the original would quietly undo
        // that decision.
        #[cfg(unix)]
        if let Ok(md) = std::fs::metadata(&plan.path) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                backup,
                std::fs::Permissions::from_mode(md.permissions().mode() & 0o777),
            );
        }
    }
    std::fs::write(&plan.path, &plan.after)
}

/// The same change as JSON, for a coding agent doing the edit instead.
///
/// `contents` is the whole resulting file rather than a patch: an agent that
/// applies a patch has to reproduce this merge correctly, and an agent that
/// writes the given bytes cannot get it wrong. The steps and the docs link
/// come from the catalogue, so the machine-readable recipe and the tile on the
/// board are the same advice.
pub fn recipe(plan: &Plan) -> Value {
    let cat = entry(plan.id);
    json!({
        "tool": plan.id,
        "name": plan.name,
        "file": plan.path,
        "format": plan.format,
        "exists": plan.before.is_some(),
        "backupTo": plan.backup,
        "merge": plan.merge,
        "changes": plan.changes,
        "contents": plan.after,
        "diff": plan.diff(),
        "steps": cat.map(|i| i.steps).unwrap_or(&[]),
        "docs": cat.and_then(|i| i.docs),
        "note": "Write `contents` to `file`, having first copied the existing file to \
                 `backupTo`. Refuse if the file exists and does not parse - the merge in \
                 `changes` assumes the shape read here.",
    })
}

// ── the command ─────────────────────────────────────────────────────────

fn usage() {
    eprintln!("usage: tokenhud-agent enable <tool>");
    eprintln!("       tokenhud-agent enable --print <tool>   the same edit, as JSON");
    eprintln!();
    eprintln!("This build can enable: {}", ENABLEABLE.join(", "));
}

/// Returns the process exit code. Nothing here loops or reports; `enable` does
/// one edit and stops.
pub fn cmd(args: &[String]) -> i32 {
    let print = args.iter().any(|a| a == "--print");
    let Some(id) = args.iter().find(|a| !a.starts_with('-')) else {
        usage();
        return 2;
    };

    let plan = match plan(id) {
        Ok(p) => p,
        Err(why) => {
            eprintln!("{why}");
            return 1;
        }
    };

    if print {
        println!(
            "{}",
            serde_json::to_string_pretty(&recipe(&plan)).unwrap_or_default()
        );
        return 0;
    }

    if plan.is_noop() {
        println!(
            "{} is already set up in {} - nothing to change.",
            plan.name,
            plan.path.display()
        );
        return 0;
    }

    println!();
    println!("  {} - {}", plan.name, plan.path.display());
    println!();
    for change in &plan.changes {
        println!("    {change}");
    }
    println!();
    print!("{}", plan.diff());
    println!();
    match (&plan.before, &plan.backup) {
        (Some(_), Some(backup)) => println!(
            "  The file as it stands is copied to {} first.",
            backup.display()
        ),
        _ => println!("  There is no file there yet; this creates one."),
    }
    println!("  Nothing else in it changes, and TokenHUD writes nothing else outside");
    println!("  ~/.tokenhud. Run `tokenhud-agent --what-i-read` to see that in full.");
    println!();

    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprintln!("There is no terminal here to confirm on, and this is not a change to make");
        eprintln!("without one. Run it interactively, or take the recipe and apply it yourself:");
        eprintln!();
        eprintln!("  tokenhud-agent enable --print {id}");
        return 2;
    }

    print!("Write it? [y/N] ");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    let mut answer = String::new();
    if std::io::BufRead::read_line(&mut std::io::stdin().lock(), &mut answer).is_err() {
        return 1;
    }
    if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        println!("Not written. Nothing changed.");
        return 1;
    }
    match apply(&plan) {
        Ok(()) => {
            println!("Written to {}.", plan.path.display());
            if let Some(backup) = &plan.backup {
                println!("The previous version is at {}.", backup.display());
            }
            if let Some(i) = entry(plan.id) {
                println!();
                println!(
                    "Next: {}",
                    i.steps.last().copied().unwrap_or("use the tool")
                );
            }
            0
        }
        Err(e) => {
            eprintln!("could not write {}: {e}", plan.path.display());
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point HOME at a scratch directory for the length of one test. The env
    /// lock is the crate's, because `set_var` is process-global and the
    /// harness is multi-threaded.
    fn with_home<T>(tag: &str, body: impl FnOnce(&Path) -> T) -> T {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("enable-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", &dir);
        let out = body(&dir);
        match prev {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn a_settings_file_that_does_not_parse_is_refused_not_replaced() {
        with_home("badjson", |home| {
            let dir = home.join(".gemini");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("settings.json");
            std::fs::write(&path, "{ \"mcpServers\": { oops").unwrap();
            let err = plan("gemini-cli").expect_err("a broken file must be refused");
            assert!(err.contains("does not parse"), "{err}");
            // The point of refusing: the file is still exactly as it was.
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "{ \"mcpServers\": { oops"
            );
        });
    }

    #[test]
    fn every_existing_key_survives_the_merge() {
        with_home("merge", |home| {
            let dir = home.join(".gemini");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("settings.json"),
                r#"{"theme":"dark","mcpServers":{"github":{"command":"gh-mcp"}}}"#,
            )
            .unwrap();
            let p = plan("gemini-cli").unwrap();
            let after: Value = serde_json::from_str(&p.after).unwrap();
            assert_eq!(after["theme"], "dark");
            assert_eq!(after["mcpServers"]["github"]["command"], "gh-mcp");
            assert_eq!(after["telemetry"]["enabled"], true);
            assert_eq!(after["telemetry"]["target"], "local");
            assert_eq!(after["telemetry"]["logPrompts"], false);
        });
    }

    #[test]
    fn the_outfile_is_absolute_so_one_log_lands_in_one_place() {
        with_home("outfile", |home| {
            let p = plan("gemini-cli").unwrap();
            let after: Value = serde_json::from_str(&p.after).unwrap();
            let outfile = after["telemetry"]["outfile"].as_str().unwrap();
            assert!(
                Path::new(outfile).is_absolute(),
                "a relative outfile scatters one log per working directory: {outfile}"
            );
            assert_eq!(
                outfile,
                home.join(".gemini").join("telemetry.log").to_str().unwrap()
            );
        });
    }

    #[test]
    fn a_telemetry_block_that_already_says_this_is_left_alone() {
        with_home("noop", |home| {
            let dir = home.join(".gemini");
            std::fs::create_dir_all(&dir).unwrap();
            let outfile = dir.join("telemetry.log");
            std::fs::write(
                dir.join("settings.json"),
                serde_json::to_string(&json!({
                    "telemetry": {
                        "enabled": true,
                        "target": "local",
                        "outfile": outfile.to_string_lossy(),
                        "logPrompts": false
                    }
                }))
                .unwrap(),
            )
            .unwrap();
            let p = plan("gemini-cli").unwrap();
            assert!(p.is_noop(), "nothing to change, so nothing to ask about");
            // `after` is pretty-printed and the fixture is not, so the two
            // strings differ while the settings do not. `is_noop` is the fact
            // that matters and the one `cmd` stops on: a file that already
            // says this is not rewritten to reformat it.
            let before: Value = serde_json::from_str(p.before.as_deref().unwrap()).unwrap();
            let after: Value = serde_json::from_str(&p.after).unwrap();
            assert_eq!(before, after);
        });
    }

    /// Turning telemetry on without turning prompt logging off would make the
    /// CLI write prompt text to disk - more than the thing asking for it
    /// wants, and the opposite of what the manifest promises.
    #[test]
    fn enabling_telemetry_also_switches_prompt_logging_off() {
        with_home("prompts", |home| {
            let dir = home.join(".gemini");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("settings.json"),
                r#"{"telemetry":{"enabled":false,"logPrompts":true}}"#,
            )
            .unwrap();
            let p = plan("gemini-cli").unwrap();
            let after: Value = serde_json::from_str(&p.after).unwrap();
            assert_eq!(after["telemetry"]["logPrompts"], false);
            assert!(p.changes.iter().any(|c| c.contains("logPrompts")));
        });
    }

    #[test]
    fn a_missing_settings_file_is_created_and_has_nothing_to_back_up() {
        with_home("fresh", |_| {
            let p = plan("gemini-cli").unwrap();
            assert!(p.before.is_none());
            assert!(
                p.backup.is_none(),
                "backing up a file that does not exist writes an empty one, which later \
                 reads as a claim about history that was never true"
            );
            apply(&p).unwrap();
            let written: Value =
                serde_json::from_str(&std::fs::read_to_string(&p.path).unwrap()).unwrap();
            assert_eq!(written["telemetry"]["enabled"], true);
            assert!(!p.path.with_extension("json.bak").exists());
        });
    }

    #[test]
    fn the_file_as_it_stood_is_kept_beside_the_one_that_replaces_it() {
        with_home("backup", |home| {
            let dir = home.join(".gemini");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("settings.json");
            std::fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
            let p = plan("gemini-cli").unwrap();
            apply(&p).unwrap();
            let backup = p.backup.clone().unwrap();
            assert_eq!(backup.file_name().unwrap(), "settings.json.bak");
            assert_eq!(
                std::fs::read_to_string(&backup).unwrap(),
                r#"{"theme":"dark"}"#
            );
        });
    }

    #[test]
    fn an_aider_config_keeps_its_comments_and_its_other_settings() {
        with_home("aider", |home| {
            let path = home.join(".aider.conf.yml");
            std::fs::write(
                &path,
                "# my aider config\nmodel: gpt-5\nauto-commits: false\n",
            )
            .unwrap();
            let p = plan("aider").unwrap();
            assert_eq!(
                p.after,
                "# my aider config\nmodel: gpt-5\nauto-commits: false\nanalytics: true\n"
            );
        });
    }

    #[test]
    fn an_indented_analytics_key_belongs_to_something_else_and_is_not_rewritten() {
        with_home("aider-nested", |home| {
            let path = home.join(".aider.conf.yml");
            std::fs::write(&path, "some-block:\n  analytics: false\n").unwrap();
            let p = plan("aider").unwrap();
            assert!(
                p.after.contains("  analytics: false"),
                "a nested key is a different setting and must survive: {}",
                p.after
            );
            assert!(p.after.ends_with("analytics: true\n"));
        });
    }

    #[test]
    fn an_analytics_line_that_already_says_true_is_left_alone() {
        with_home("aider-noop", |home| {
            std::fs::write(
                home.join(".aider.conf.yml"),
                "analytics: true  # already on\n",
            )
            .unwrap();
            assert!(plan("aider").unwrap().is_noop());
        });
    }

    #[test]
    fn two_top_level_analytics_lines_are_refused_rather_than_guessed_at() {
        with_home("aider-ambiguous", |home| {
            std::fs::write(
                home.join(".aider.conf.yml"),
                "analytics: false\nmodel: gpt-5\nanalytics: false\n",
            )
            .unwrap();
            let err = plan("aider").expect_err("ambiguous files are refused");
            assert!(err.contains("separate top-level lines"), "{err}");
        });
    }

    #[test]
    fn the_printed_recipe_carries_the_whole_file_and_the_catalogue_steps() {
        with_home("recipe", |_| {
            let p = plan("gemini-cli").unwrap();
            let r = recipe(&p);
            assert_eq!(r["tool"], "gemini-cli");
            assert_eq!(r["format"], "json");
            assert_eq!(r["exists"], false);
            // An agent that writes these bytes cannot get the merge wrong; an
            // agent handed a patch has to reproduce it.
            let contents: Value = serde_json::from_str(r["contents"].as_str().unwrap()).unwrap();
            assert_eq!(contents["telemetry"]["target"], "local");
            assert!(
                r["steps"].as_array().is_some_and(|s| !s.is_empty()),
                "the machine-readable recipe and the board's tile must be one answer"
            );
        });
    }

    #[test]
    fn an_unknown_tool_names_the_ones_that_do_have_a_recipe() {
        let err = plan("cursor").expect_err("there is no recipe for Cursor");
        assert!(err.contains("gemini-cli") && err.contains("aider"), "{err}");
    }

    #[test]
    fn a_diff_shows_the_lines_and_not_a_summary_of_them() {
        let d = diff("a\nb\nc\n", "a\nB\nc\n", "/tmp/x");
        assert!(d.contains("- b"), "{d}");
        assert!(d.contains("+ B"), "{d}");
        assert!(
            d.contains("  a") && d.contains("  c"),
            "context is shown: {d}"
        );
        assert!(diff("same\n", "same\n", "/tmp/x").is_empty());
    }
}
