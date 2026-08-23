//! The manifest has to stay true, and prose cannot be trusted to.
//!
//! `manifest.rs` claims the agent reads a specific list of paths and nothing
//! else. That claim is the product's central one, so it is checked mechanically
//! rather than reviewed: this greps the collectors for every path literal and
//! fails if one is not declared. A new collector that quietly starts reading
//! `~/.ssh` breaks the build before it breaks the promise.
//!
//! It is a grep, so it is defeatable by someone determined — a path assembled
//! at runtime slips through. It is not an adversarial sandbox and does not
//! claim to be. What it catches is the realistic failure: a well-meaning change
//! that reads one more file and forgets the disclosure.

use std::collections::BTreeSet;
use tokenhud_agent::manifest::{self, Kind};

fn collector_sources() -> Vec<(&'static str, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    ["collect.rs", "transcripts.rs", "limits.rs"]
        .iter()
        .map(|f| {
            let text = std::fs::read_to_string(dir.join(f))
                .unwrap_or_else(|e| panic!("cannot read {f}: {e}"));
            (*f, text)
        })
        .collect()
}

/// Every `.join("literal")` in the collectors, which is how a path is built here.
fn joined_literals(src: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = src;
    while let Some(i) = rest.find(".join(\"") {
        rest = &rest[i + 7..];
        if let Some(j) = rest.find('"') {
            let lit = &rest[..j];
            // `.join(" ")` is string joining, not a path.
            if !lit.trim().is_empty() && lit != " " {
                out.insert(lit.to_string());
            }
            rest = &rest[j..];
        }
    }
    out
}

#[test]
fn every_path_the_collectors_read_is_declared() {
    // What the manifest says, reduced to the components it names.
    let mut declared: BTreeSet<String> = BTreeSet::new();
    for s in manifest::READS {
        for part in s.display.split('/') {
            let part = part.trim_start_matches('~').trim_start_matches('.');
            if !part.is_empty() && !part.contains('*') {
                declared.insert(part.to_string());
                declared.insert(format!(".{part}"));
            }
        }
    }
    for p in manifest::PROBED {
        let leaf = p.trim_start_matches("~/");
        declared.insert(leaf.to_string());
        if let Some(last) = leaf.rsplit('/').next() {
            declared.insert(last.to_string());
        }
    }
    for (p, _) in manifest::WRITES {
        if let Some(last) = p.rsplit('/').next() {
            declared.insert(last.to_string());
        }
    }
    // The state directory itself, and the config directory the manifest names
    // by its display form.
    for extra in [".tokenhud", "projects", "tmp"] {
        declared.insert(extra.to_string());
    }

    let mut undeclared: Vec<String> = Vec::new();
    for (file, src) in collector_sources() {
        for lit in joined_literals(&src) {
            if !declared.contains(&lit) {
                undeclared.push(format!("{file}: .join({lit:?})"));
            }
        }
    }

    assert!(
        undeclared.is_empty(),
        "these paths are read but not declared in manifest.rs — either add them to the \
         manifest (and accept that the consent digest changes, so every user is asked \
         again) or stop reading them:\n  {}",
        undeclared.join("\n  ")
    );
}

#[test]
fn the_manifest_does_not_claim_paths_that_are_never_read() {
    // The opposite failure: a disclosure that over-claims is also a lie, and it
    // makes users refuse a permission the agent does not need.
    let all: String = collector_sources().iter().map(|(_, s)| s.clone()).collect();
    for s in manifest::READS {
        if s.kind == Kind::Command {
            assert!(
                all.contains("\"ps\""),
                "the manifest declares ps but no collector runs it"
            );
            continue;
        }
        let leaf = s.display.rsplit('/').next().unwrap_or(s.display);
        let leaf = leaf.trim_start_matches('*').trim_start_matches('.');
        let stem = leaf.split('.').next().unwrap_or(leaf);
        assert!(
            all.contains(stem) || all.contains(leaf),
            "manifest declares {} but nothing in the collectors mentions it",
            s.display
        );
    }
}

#[test]
fn the_exclusions_name_things_the_code_could_take_but_does_not() {
    // `~/.claude.json` really is opened — so the value of the NEVER list is
    // that the keys it names are genuinely absent from the code that reads it.
    let raw = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/limits.rs"),
    )
    .unwrap();
    // Comments only, stripped: that file documents at length what it refuses to
    // read, and naming a key in prose is the opposite of reading it. What must
    // be absent is the key appearing in an expression.
    let limits: String = raw
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["oauthAccount", "\"projects\"", "spend", "extra_usage"] {
        assert!(
            !limits.contains(forbidden),
            "limits.rs mentions {forbidden}, which the manifest promises is never read"
        );
    }
    assert!(
        limits.contains("cachedUsageUtilization"),
        "limits.rs should read exactly the one key the manifest declares"
    );
}
