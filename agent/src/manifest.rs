//! Everything this agent will open, declared in one place.
//!
//! The product's central claim is that it is *structurally* unable to read what
//! it says it does not read — not that it promises politely. A promise written
//! in a README drifts from the code within two releases. So the list lives
//! here, `--what-i-read` prints it resolved against your actual machine, and
//! `tests/manifest.rs` greps the source for every path literal and fails if one
//! is not declared below. A collector cannot quietly start reading something
//! new: the test breaks first.
//!
//! The manifest is also hashed, and the hash is what consent is recorded
//! against. If a later release reads something new, the hash changes and the
//! agent asks again rather than assuming the earlier yes still covers it.

use crate::transcripts::{claude_dir, home};
use std::path::PathBuf;

pub struct Source {
    /// Shown to the user, with `~` rather than an absolute path.
    pub display: &'static str,
    /// What is taken from it, in one line.
    pub purpose: &'static str,
    /// The narrowing, where only part of the file is read.
    pub scope: Option<&'static str>,
    pub resolve: fn() -> PathBuf,
    pub kind: Kind,
}

#[derive(PartialEq, Clone, Copy)]
pub enum Kind {
    /// A directory walked for `*.jsonl`.
    Corpus,
    File,
    /// Not a file at all — a command this agent runs.
    Command,
}

/// Read. Nothing outside this list is opened.
pub const READS: &[Source] = &[
    Source {
        display: "~/.claude/projects/**/*.jsonl",
        purpose: "per-session token counts, models, timings and tool calls",
        scope: Some("only lines whose type is `assistant` or `ai-title`; read once, by byte offset"),
        resolve: || claude_dir().join("projects"),
        kind: Kind::Corpus,
    },
    Source {
        display: "~/.claude/stats-cache.json",
        purpose: "Claude Code's own daily activity roll-up",
        scope: None,
        resolve: || claude_dir().join("stats-cache.json"),
        kind: Kind::File,
    },
    Source {
        display: "~/.claude.json",
        purpose: "your plan's real 5-hour and 7-day usage windows",
        scope: Some("exactly one key: `cachedUsageUtilization`. Never `oauthAccount`, never `projects`, never `utilization.spend`"),
        resolve: || home().join(".claude.json"),
        kind: Kind::File,
    },
    Source {
        display: "~/.claude/daemon.status.json",
        purpose: "whether Claude Code's background daemon is alive",
        scope: None,
        resolve: || claude_dir().join("daemon.status.json"),
        kind: Kind::File,
    },
    Source {
        display: "~/.claude/history.jsonl",
        purpose: "recent prompt subjects — OFF unless TOKENHUD_SEND_PROMPTS=1",
        scope: Some("not opened at all unless you set that variable"),
        resolve: || claude_dir().join("history.jsonl"),
        kind: Kind::File,
    },
    Source {
        display: "~/.codex/sessions/**/*.jsonl",
        purpose: "Codex CLI token counts, models and plan windows, per session",
        scope: Some("only `token_count` events and session metadata; the cumulative total, not the turns"),
        resolve: || crate::codex::sessions_root(),
        kind: Kind::Corpus,
    },
    Source {
        display: "~/.codex/session_index.jsonl",
        purpose: "a count of Codex sessions, so \"detected\" means more than \"a directory exists\"",
        scope: Some("counted, not parsed"),
        resolve: || home().join(".codex").join("session_index.jsonl"),
        kind: Kind::File,
    },
    Source {
        display: "ps -Ao pid,etime,command",
        purpose: "which coding agents are running right now",
        scope: Some("command lines are truncated to 200 characters before they leave this machine"),
        resolve: || PathBuf::from("/bin/ps"),
        kind: Kind::Command,
    },
];

/// Checked for existence only — never opened. This is how the board can say
/// "Cursor is installed here" without reading anything Cursor wrote.
pub const PROBED: &[&str] = &[
    "~/.claude",
    "~/.codex",
    "~/.cursor",
    "~/.gemini",
    "~/.config/github-copilot",
    "~/.windsurf",
    "~/.codeium",
    "~/.antigravity-ide",
    "~/.aider.conf.yml",
];

/// Written. This list is exhaustive.
pub const WRITES: &[(&str, &str)] = &[
    (
        "~/.tokenhud/transcripts.json",
        "the index of what has already been read, so it is read once",
    ),
    (
        "~/.tokenhud/spool.jsonl",
        "readings that could not be sent yet",
    ),
    (
        "~/.tokenhud/salt",
        "a random per-install salt, so the account hash is not a cross-machine identifier",
    ),
    ("~/.tokenhud/consent.json", "what you agreed to, and when"),
];

/// Deliberately never read, with the reason. These are the load-bearing ones —
/// each names something the agent could trivially take and does not.
pub const NEVER: &[(&str, &str)] = &[
    ("prompt text and session titles", "the most sensitive thing on the machine; opt-in, off by default"),
    ("~/.claude.json → oauthAccount", "your identity. The file is mode 0600 and that is the OS agreeing it is private"),
    ("~/.claude.json → utilization.spend", "actual billed dollars. The board's one estimate is labelled an estimate, and a real bill beside it would destroy the distinction"),
    ("~/.claude.json → projects", "a second, richer per-project cost history. Usage is read from the transcripts instead"),
    ("your source code", "no collector opens a file outside the paths listed above"),
    ("environment variables", "other than the TOKENHUD_* ones that configure this agent"),
];

/// A stable digest of everything above. Consent is recorded against this, so a
/// release that reads something new cannot inherit an older yes.
pub fn digest() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for s in READS {
        h.update(s.display.as_bytes());
        h.update([0]);
        h.update(s.purpose.as_bytes());
        h.update([0]);
        h.update(s.scope.unwrap_or("").as_bytes());
        h.update([0x1f]);
    }
    for p in PROBED {
        h.update(p.as_bytes());
        h.update([0x1f]);
    }
    for (p, why) in WRITES {
        h.update(p.as_bytes());
        h.update([0]);
        h.update(why.as_bytes());
        h.update([0x1f]);
    }
    for (p, why) in NEVER {
        h.update(p.as_bytes());
        h.update([0]);
        h.update(why.as_bytes());
        h.update([0x1f]);
    }
    format!("{:x}", h.finalize())[..16].to_string()
}

// ── what is actually on this machine ────────────────────────────────────

pub struct Found {
    pub exists: bool,
    pub files: usize,
    pub bytes: u64,
}

fn walk(dir: &std::path::Path, found: &mut Found) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            walk(&e.path(), found);
        } else if e.path().extension().and_then(|x| x.to_str()) == Some("jsonl") {
            found.files += 1;
            found.bytes += md.len();
        }
    }
}

pub fn inspect(s: &Source) -> Found {
    let p = (s.resolve)();
    match s.kind {
        Kind::Corpus => {
            let mut f = Found {
                exists: p.is_dir(),
                files: 0,
                bytes: 0,
            };
            if f.exists {
                walk(&p, &mut f);
            }
            f
        }
        Kind::File => match std::fs::metadata(&p) {
            Ok(md) => Found {
                exists: true,
                files: 1,
                bytes: md.len(),
            },
            Err(_) => Found {
                exists: false,
                files: 0,
                bytes: 0,
            },
        },
        Kind::Command => Found {
            exists: p.exists(),
            files: 0,
            bytes: 0,
        },
    }
}

fn human(b: u64) -> String {
    const U: [(&str, u64); 4] = [("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10), ("B", 1)];
    for (unit, size) in U {
        if b >= size {
            return if size == 1 {
                format!("{b} B")
            } else {
                format!("{:.1} {unit}", b as f64 / size as f64)
            };
        }
    }
    "0 B".into()
}

/// `--what-i-read`, resolved against this machine.
pub fn render() -> String {
    let mut o = String::new();
    o.push_str("\nTokenHUD reads these, on this machine, and nothing else.\n");
    o.push_str(&format!(
        "Manifest {} · agent {}\n\n",
        digest(),
        crate::collect::AGENT_VERSION
    ));

    o.push_str("READS\n");
    for s in READS {
        let f = inspect(s);
        let state = match (s.kind, f.exists) {
            (Kind::Command, true) => "present".to_string(),
            (_, false) => "not present here".to_string(),
            (Kind::Corpus, true) => format!("{} files, {}", f.files, human(f.bytes)),
            (Kind::File, true) => human(f.bytes),
        };
        o.push_str(&format!("  {:<32} {}\n", s.display, state));
        o.push_str(&format!("  {:<32} {}\n", "", s.purpose));
        if let Some(scope) = s.scope {
            o.push_str(&format!("  {:<32} └ {}\n", "", scope));
        }
        o.push('\n');
    }

    o.push_str("CHECKED FOR EXISTENCE ONLY, NEVER OPENED\n  ");
    o.push_str(&PROBED.join("  "));
    o.push_str("\n\nWRITES — this list is exhaustive\n");
    for (p, why) in WRITES {
        o.push_str(&format!("  {p:<32} {why}\n"));
    }

    o.push_str("\nNEVER READ\n");
    for (p, why) in NEVER {
        o.push_str(&format!("  {p:<32} {why}\n"));
    }

    o.push_str("\nWhere it goes: whatever TOKENHUD_SERVER points at, which defaults to\n");
    o.push_str("127.0.0.1:8787 — your own machine. Nothing is sent anywhere else.\n");
    o.push_str(
        "\nSee exactly what would be sent, without sending it:\n  tokenhud-agent --dry-run\n",
    );
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digest_is_stable_and_short() {
        assert_eq!(digest().len(), 16);
        assert_eq!(digest(), digest());
    }

    #[test]
    fn every_source_renders_on_this_machine() {
        let out = render();
        for s in READS {
            assert!(
                out.contains(s.display),
                "{} missing from --what-i-read",
                s.display
            );
        }
        for (p, _) in WRITES {
            assert!(out.contains(p), "{p} missing from --what-i-read");
        }
        // The load-bearing exclusions have to be visible, or the disclosure is
        // only telling you the flattering half.
        assert!(out.contains("oauthAccount") && out.contains("utilization.spend"));
    }
}
