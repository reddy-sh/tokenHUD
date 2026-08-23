//! Rate card — the one place a dollar figure comes from.
//!
//! This file exists because of an honest problem. On a subscription plan the
//! CLI reports `costUSD: 0` for every model: the plan is a flat fee, so there
//! is no per-request price to report. True about billing, and useless to
//! anyone asking where their usage went.
//!
//! So the board answers a different question and says which one:
//!
//! ```text
//! not  "what were you charged"     — a flat subscription; the CLI knows
//!                                    this and reports zero
//! but  "what would this have cost
//!       at Anthropic's published
//!       API list prices"           — a yardstick for comparing sessions,
//!                                    models and days against each other
//! ```
//!
//! Both are honest. Only the second is useful, and only while it is labelled.
//! Every figure derived from here is prefixed `est` in the payload and carries
//! the note to the UI, so the label cannot be lost on the way to a screen.

use crate::transcripts::Tok;
use serde_json::{json, Value};

/// Published as of this date. Bump both when you edit the table.
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

pub fn rate(model: &str) -> Option<(f64, f64)> {
    let c = canonical(model);
    RATES
        .iter()
        .find(|(m, _, _)| *m == c)
        .map(|(_, i, o)| (*i, *o))
}

/// USD for one bucket of tokens, or `None` if the model has no rate.
///
/// `None` is deliberate, exactly as in the Python: a model released after this
/// table was written should make the board say "unpriced", not quietly add $0
/// to a total that then reads as complete.
pub fn cost(model: &str, t: &Tok) -> Option<f64> {
    let (rin, rout) = rate(model)?;
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

/// The rate card itself, shipped so the board can show its own arithmetic.
pub fn card() -> Value {
    let mut rates: Vec<&(&str, f64, f64)> = RATES.iter().collect();
    rates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    json!({
        "asOf": AS_OF,
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
