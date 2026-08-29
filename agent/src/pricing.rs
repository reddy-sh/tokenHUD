//! Rate card - the one place a dollar figure comes from.
//!
//! This file exists because of an honest problem. On a subscription plan the
//! CLI reports `costUSD: 0` for every model: the plan is a flat fee, so there
//! is no per-request price to report. True about billing, and useless to
//! anyone asking where their usage went.
//!
//! So the board answers a different question and says which one:
//!
//! ```text
//! not  "what were you charged"     - a flat subscription; the CLI knows
//!                                    this and reports zero
//! but  "what would this have cost
//!       at Anthropic's published
//!       API list prices"           - a yardstick for comparing sessions,
//!                                    models and days against each other
//! ```
//!
//! Both are honest. Only the second is useful, and only while it is labelled.
//! Every figure derived from here is prefixed `est` in the payload and carries
//! the note to the UI, so the label cannot be lost on the way to a screen.

use crate::transcripts::Tok;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Published as of this date. Bump both when you edit the table.
/// How many days of the daily series travel with a reading.
///
/// The boards keep 90 (`WINDOW_DAYS` in server/src/share.rs and `slice(-90)`
/// in shared/profile.mjs); the agent used to ship 60, so the last thirty days
/// of any 90-day cost figure were structurally zero.
pub const BOARD_WINDOW_DAYS: usize = 90;

/// The reading's shape, not the rate card's date. An upstream CLI changing its
/// format, or a collector gaining a field, moves this - which is how a stale
/// parser becomes detectable rather than silently zero.
pub const SCHEMA_VERSION: u32 = 1;

pub const AS_OF: &str = "2026-06-24";

/// model id -> (input $/MTok, output $/MTok)
const RATES: &[(&str, f64, f64)] = &[
    ("claude-fable-5", 10.0, 50.0),
    ("claude-mythos-5", 10.0, 50.0),
    ("claude-opus-5", 5.0, 25.0),
    ("claude-opus-4-8", 5.0, 25.0),
    ("claude-opus-4-7", 5.0, 25.0),
    ("claude-opus-4-6", 5.0, 25.0),
    ("claude-opus-4-5", 5.0, 25.0),
    ("claude-sonnet-5", 3.0, 15.0),
    ("claude-sonnet-4-6", 3.0, 15.0),
    ("claude-sonnet-4-5", 3.0, 15.0),
    ("claude-haiku-4-5", 1.0, 5.0),
];

// Cache is priced off the input rate, not separately.
pub const CACHE_READ: f64 = 0.10;
pub const CACHE_WRITE_5M: f64 = 1.25;
pub const CACHE_WRITE_1H: f64 = 2.00;

pub fn note() -> String {
    format!(
        "Estimated at Anthropic API list prices (as of {AS_OF}). Not what you \
         were charged: this plan is a flat subscription and the CLI reports $0 for \
         every model. Read it as a yardstick between sessions, not as a bill."
    )
}

const CAVEATS: &[&str] = &[
    "Sonnet 5 carries introductory pricing ($2/$10) through 2026-08-31; it is \
     priced here at the standard $3/$15, so recent Sonnet figures run high.",
    "Cache writes are split 1.25x (5-minute TTL) and 2x (1-hour TTL) where the \
     transcript records the split, and assumed 5-minute where it does not.",
    "Models with no entry in the rate card are counted in tokens and excluded \
     from every dollar figure rather than guessed at.",
];

/// `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are one rate.
///
/// The Python does this with `-\d{8}$`; hand-rolled here rather than pulling in
/// a regex engine for one pattern that a byte comparison answers.
pub fn canonical(model: &str) -> &str {
    let m = model.trim();
    let b = m.as_bytes();
    if b.len() > 9 && b[b.len() - 9] == b'-' && b[b.len() - 8..].iter().all(u8::is_ascii_digit) {
        &m[..m.len() - 9]
    } else {
        m
    }
}

/// Rates the user supplied, from `~/.tokenhud/rates.json`.
///
/// The built-in card is Anthropic's, which leaves two holes: a model released
/// after this build silently becomes "unpriced", and every non-Anthropic tool
/// is unpriced forever. Shipping invented OpenAI numbers to close the second
/// would be exactly the "present a calculation as a measurement" mistake this
/// file exists to avoid - so the rates come from whoever is willing to vouch
/// for them. Absent the file, nothing changes.
///
/// ```json
/// { "asOf": "2026-08-27",
///   "rates": { "gpt-5-codex": { "input": 1.25, "output": 10.0 } } }
/// ```
/// Dollars per million tokens, matching the built-in card.
fn overrides() -> std::collections::HashMap<String, (f64, f64)> {
    // Keyed by path and mtime rather than read once: a OnceLock would mean an
    // edit to the card needs the agent restarted to take effect, and would make
    // the behaviour untestable in a process that has already asked once.
    type Cached = (Option<std::time::SystemTime>, std::collections::HashMap<String, (f64, f64)>);
    static CARD: std::sync::Mutex<Option<(PathBuf, Cached)>> = std::sync::Mutex::new(None);

    let path = crate::transcripts::state_dir().join("rates.json");
    let mtime = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());
    if let Ok(g) = CARD.lock() {
        if let Some((p, (seen, map))) = g.as_ref() {
            if *p == path && *seen == mtime {
                return map.clone();
            }
        }
    }

    let mut out = std::collections::HashMap::new();
    if let Ok(text) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => {
                if let Some(map) = v.get("rates").and_then(|r| r.as_object()) {
                    for (model, r) in map {
                        let i = r.get("input").and_then(|x| x.as_f64());
                        let o = r.get("output").and_then(|x| x.as_f64());
                        if let (Some(i), Some(o)) = (i, o) {
                            if i.is_finite() && o.is_finite() && i >= 0.0 && o >= 0.0 {
                                out.insert(canonical(model).to_string(), (i, o));
                            }
                        }
                    }
                }
            }
            // A malformed card is not a reason to stop reporting, and it is not
            // a reason to price anything either. Say so once and carry on.
            Err(e) => eprintln!("  rates.json is not valid JSON ({e}) - ignoring it"),
        }
    }
    if let Ok(mut g) = CARD.lock() {
        *g = Some((path, (mtime, out.clone())));
    }
    out
}

/// The date the user stamped on their own card, if they supplied one.
pub fn overrides_as_of() -> Option<String> {
    let path = crate::transcripts::state_dir().join("rates.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("asOf")?.as_str().map(str::to_string)
}

/// The built-in card only. This is the figure that may be published or ranked.
pub fn rate_builtin(model: &str) -> Option<(f64, f64)> {
    let c = canonical(model);
    RATES
        .iter()
        .find(|(m, _, _)| *m == c)
        .map(|(_, i, o)| (*i, *o))
}

/// The rate this machine will price a model at.
///
/// **The built-in card wins.** A user card fills gaps - models this build ships
/// no rate for - and cannot restate one it does. `estUSD` is a ranked metric on
/// the leaderboard, so a card that could overwrite Anthropic's rates would be a
/// way to buy first place by editing a file. Filling a gap cannot do that,
/// because a gap-filled price is marked `api_equivalent` and never published.
pub fn rate(model: &str) -> Option<(f64, f64)> {
    rate_builtin(model).or_else(|| overrides().get(canonical(model)).copied())
}

/// Did this price come from the user's own card rather than the built-in one?
/// Such a figure is for this machine's own board and goes no further.
pub fn is_user_priced(model: &str) -> bool {
    rate_builtin(model).is_none() && overrides().contains_key(canonical(model))
}

/// Cost for a source whose token shape is not Claude's.
///
/// Reasoning tokens are billed as output (every provider surveyed does this),
/// cache reads at the cache-read multiple of input, cache writes at the 5-minute
/// multiple. `None` when no rate is known - never `0.0`.
pub fn cost_parts(model: &str, input: i64, cached_read: i64, cache_write: i64, output: i64, reasoning: i64) -> Option<f64> {
    cost_with(rate(model)?, input, cached_read, cache_write, output, reasoning)
}

/// The same arithmetic, but only from the built-in card - the figure that is
/// safe to publish, because every machine computes it from the same numbers.
pub fn cost_parts_builtin(model: &str, input: i64, cached_read: i64, cache_write: i64, output: i64, reasoning: i64) -> Option<f64> {
    cost_with(rate_builtin(model)?, input, cached_read, cache_write, output, reasoning)
}

fn cost_with((rin, rout): (f64, f64), input: i64, cached_read: i64, cache_write: i64, output: i64, reasoning: i64) -> Option<f64> {
    const PER: f64 = 1_000_000.0;
    Some(
        input as f64 * rin / PER
            + (output + reasoning) as f64 * rout / PER
            + cached_read as f64 * rin * CACHE_READ / PER
            + cache_write as f64 * rin * CACHE_WRITE_5M / PER,
    )
}

/// USD for one bucket of tokens, or `None` if the model has no rate.
///
/// `None` is deliberate, exactly as in the Python: a model released after this
/// table was written should make the board say "unpriced", not quietly add $0
/// to a total that then reads as complete.
/// Cost for the Claude transcript path - **built-in rates only**.
///
/// This figure becomes `usage.allTime.estUSD`, which is the leaderboard's
/// `spend` metric and travels to shared and public boards. It therefore must
/// not be reachable from a file on the machine being ranked: a user card that
/// could name, say, a Claude model released after this build would otherwise be
/// a way to buy first place. A model this card does not cover is unpriced,
/// which is the honest answer and a fixable one - by updating the card here.
pub fn cost(model: &str, t: &Tok) -> Option<f64> {
    let (rin, rout) = rate_builtin(model)?;
    const PER: f64 = 1_000_000.0;
    Some(
        t.tin as f64 * rin / PER
            + t.out as f64 * rout / PER
            + t.cr as f64 * rin * CACHE_READ / PER
            + t.cw5 as f64 * rin * CACHE_WRITE_5M / PER
            + t.cw1 as f64 * rin * CACHE_WRITE_1H / PER,
    )
}

/// Sum a {model: tokens} map. Returns (USD rounded to 4dp, tokens on unpriced models).
pub fn cost_of<'a, I>(models: I) -> (f64, i64)
where
    I: IntoIterator<Item = (&'a String, &'a Tok)>,
{
    let (mut total, mut unpriced) = (0.0f64, 0i64);
    for (name, t) in models {
        match cost(name, t) {
            Some(c) => total += c,
            None => unpriced += t.sum(),
        }
    }
    (round(total, 4), unpriced)
}

/// Python's `round()` is banker's rounding; `format!` and `f64::round` are not.
/// The difference shows up in the fourth decimal of a dollar total and then in
/// every conformance diff, so it is reproduced rather than approximated.
pub fn round(v: f64, places: u32) -> f64 {
    let f = 10f64.powi(places as i32);
    let scaled = v * f;
    let r = scaled.round();
    // Exactly .5 away from zero: round half to even, as Python does.
    let out = if (scaled - scaled.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - scaled.signum()
    } else {
        r
    };
    out / f
}

/// Where a dollar figure came from.
///
/// Every tool surveyed collapses "free", "no pricing data for this model" and
/// "included in a subscription" into the same `$0.00`, and that single ambiguity
/// is the most misleading thing a usage dashboard can print. A cost is not a
/// number on its own - it is a number and a claim about how it was arrived at,
/// and the claim travels with it.
///
/// - `list_price` - tokens counted here, priced at the provider's published list
///   rates. An estimate, labelled as one. Not a bill.
/// - `unpriced` - tokens counted, but this build has no rate for the model.
///   Never render as `$0`: the work happened.
/// - `not_metered` - a flat subscription; there is no per-request price to
///   report, so a dollar figure would be invented.
/// - `credits` - the provider meters in its own unit (Copilot premium requests,
///   Devin ACU). Reported in that unit, not converted.
pub const BASIS_LIST_PRICE: &str = "list_price";
pub const BASIS_UNPRICED: &str = "unpriced";
pub const BASIS_NOT_METERED: &str = "not_metered";
pub const BASIS_CREDITS: &str = "credits";
/// Priced from a rate card the *user* supplied for a provider this build ships
/// no rates for. Still an estimate at list prices, and still never a bill - but
/// it is their number, vouched for by them, not one this repo invented.
pub const BASIS_API_EQUIVALENT: &str = "api_equivalent";

/// The rate card itself, shipped so the board can show its own arithmetic.
pub fn card() -> Value {
    let mut rates: Vec<&(&str, f64, f64)> = RATES.iter().collect();
    rates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    json!({
        "asOf": AS_OF,
        // Bumped when the shape of a reading changes, so a consumer can tell a
        // missing field from an older agent apart from one that is absent
        // because nothing was measured.
        "schemaVersion": SCHEMA_VERSION,
        "note": note(),
        "caveats": CAVEATS,
        "cacheRead": CACHE_READ,
        "cacheWrite5m": CACHE_WRITE_5M,
        "cacheWrite1h": CACHE_WRITE_1H,
        "rates": rates.iter()
            .map(|(m, i, o)| json!({"model": m, "input": i, "output": o}))
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ranked Claude figure is unreachable from a user's own file.
    #[test]
    fn a_user_card_cannot_price_the_ranked_claude_figure() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("th-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("TOKENHUD_STATE").ok();
        std::env::set_var("TOKENHUD_STATE", &dir);
        std::fs::write(
            dir.join("rates.json"),
            r#"{"rates":{"claude-from-the-future":{"input":99999.0,"output":99999.0}}}"#,
        )
        .unwrap();

        let t = Tok { tin: 1_000_000, out: 1_000_000, cr: 0, cw5: 0, cw1: 0 };
        let ranked = cost("claude-from-the-future", &t);
        // The same model does price on the local-only path, which is what the
        // machine's own board may show.
        let local = cost_parts("claude-from-the-future", 1_000_000, 0, 0, 1_000_000, 0);

        match prev {
            Some(p) => std::env::set_var("TOKENHUD_STATE", p),
            None => std::env::remove_var("TOKENHUD_STATE"),
        }
        assert_eq!(ranked, None, "a self-supplied rate must not reach the ranked figure");
        assert!(local.is_some(), "but it may price the owner's own board");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A card cannot restate a rate the built-in card already sets.
    ///
    /// `estUSD` is a ranked metric on the leaderboard. If a user's own file
    /// could overwrite Anthropic's rates, first place would go to whoever typed
    /// the largest number into it. The built-in card wins; a user card fills
    /// gaps and nothing else.
    #[test]
    fn a_user_card_cannot_overwrite_a_built_in_rate() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("th-nogame-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("TOKENHUD_STATE").ok();
        std::env::set_var("TOKENHUD_STATE", &dir);

        std::fs::write(
            dir.join("rates.json"),
            r#"{"rates":{"claude-opus-5":{"input":99999.0,"output":99999.0}}}"#,
        )
        .unwrap();
        let opus = rate("claude-opus-5");
        let user_priced = is_user_priced("claude-opus-5");

        match prev {
            Some(p) => std::env::set_var("TOKENHUD_STATE", p),
            None => std::env::remove_var("TOKENHUD_STATE"),
        }
        assert_eq!(opus, Some((5.0, 25.0)), "the built-in rate stands");
        assert!(!user_priced, "and it is not marked as user-priced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rate card the user supplies prices models this build ships no rates
    /// for - which is how Codex gets a dollar figure without this repo
    /// inventing OpenAI's prices.
    #[test]
    fn a_user_supplied_rate_prices_a_model_this_build_does_not_know() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("th-rates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("TOKENHUD_STATE").ok();

        std::env::set_var("TOKENHUD_STATE", &dir);

        // No card: an unknown model is unpriced, never $0.
        let before = cost_parts("made-up-model", 1_000_000, 0, 0, 1_000_000, 0);

        // A card the user vouched for: the same model now prices.
        let card = r#"{"asOf":"2026-08-27","rates":{"made-up-model":{"input":2.0,"output":10.0}}}"#;
        std::fs::write(dir.join("rates.json"), card).unwrap();
        let after = cost_parts("made-up-model", 1_000_000, 0, 0, 1_000_000, 0);
        // A model the card does not mention stays unpriced.
        let other = cost_parts("still-unknown-model", 1_000_000, 0, 0, 1_000_000, 0);

        match prev {
            Some(p) => std::env::set_var("TOKENHUD_STATE", p),
            None => std::env::remove_var("TOKENHUD_STATE"),
        }
        assert_eq!(before, None, "no rate means no number, not zero");
        assert_eq!(after, Some(12.0), "input 2.00 + output 10.00 per million");
        assert_eq!(other, None, "a card prices what it names and nothing else");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Reasoning is billed as output, cache reads at the cache-read multiple.
    #[test]
    fn reasoning_is_billed_as_output_and_cache_reads_are_discounted() {
        // claude-opus-5 is in the built-in card at 5 / 25 per million.
        let out_only = cost_parts("claude-opus-5", 0, 0, 0, 1_000_000, 0).unwrap();
        let with_reasoning = cost_parts("claude-opus-5", 0, 0, 0, 500_000, 500_000).unwrap();
        assert!(
            (out_only - with_reasoning).abs() < 1e-9,
            "reasoning tokens cost what output tokens cost"
        );
        let cached = cost_parts("claude-opus-5", 0, 1_000_000, 0, 0, 0).unwrap();
        assert!((cached - 5.0 * CACHE_READ).abs() < 1e-9, "got {cached}");
    }

    #[test]
    fn canonical_strips_only_a_date_suffix() {
        assert_eq!(canonical("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
        assert_eq!(canonical("claude-opus-5"), "claude-opus-5");
        assert_eq!(canonical("claude-sonnet-4-5"), "claude-sonnet-4-5");
        assert_eq!(canonical("  claude-opus-5  "), "claude-opus-5");
    }

    #[test]
    fn an_unknown_model_is_unpriced_not_free() {
        let t = Tok {
            tin: 1000,
            out: 1000,
            cr: 0,
            cw5: 0,
            cw1: 0,
        };
        assert!(cost("claude-from-the-future", &t).is_none());
        let priced = cost("claude-opus-5", &t).unwrap();
        assert!((priced - (0.005 + 0.025)).abs() < 1e-9, "got {priced}");
    }

    #[test]
    fn cache_is_priced_off_the_input_rate() {
        let t = Tok {
            tin: 0,
            out: 0,
            cr: 1_000_000,
            cw5: 0,
            cw1: 0,
        };
        assert!((cost("claude-opus-5", &t).unwrap() - 0.5).abs() < 1e-9);
    }
}
