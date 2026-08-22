"""
Rate card — the one place a dollar figure comes from.

This file exists because of an honest problem. On a subscription plan the CLI
reports `costUSD: 0` for every model: the plan is a flat fee, so there is no
per-request price to report. That is a true statement about billing and a
useless one for anyone asking "where is my usage going".

So the board answers a different question, and says which one it is answering:

    not  "what were you charged"        — a flat subscription; the CLI knows
                                          this and reports zero
    but  "what would this have cost at
          Anthropic's published API
          list prices"                  — a yardstick for comparing sessions,
                                          models, and days against each other

Both numbers are honest. Only the second one is useful, and only while it is
labelled. Every figure derived from this file is prefixed `est` in the payload
and carries `PRICING["note"]` to the UI, so the label cannot be lost on the
way to the screen.

Rates are Anthropic first-party API list prices, USD per million tokens.
Partner platforms (Bedrock, Vertex) price separately and are not modelled.
"""
from __future__ import annotations

import re

# Published as of this date. Bump both when you edit the table.
AS_OF = "2026-06-24"

# model id -> (input $/MTok, output $/MTok)
RATES: dict[str, tuple[float, float]] = {
    "claude-fable-5":   (10.0, 50.0),
    "claude-mythos-5":  (10.0, 50.0),
    "claude-opus-5":    (5.0,  25.0),
    "claude-opus-4-8":  (5.0,  25.0),
    "claude-opus-4-7":  (5.0,  25.0),
    "claude-opus-4-6":  (5.0,  25.0),
    "claude-opus-4-5":  (5.0,  25.0),
    "claude-sonnet-5":  (3.0,  15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0,   5.0),
}

# Cache is priced off the input rate, not separately.
CACHE_READ = 0.10     # a cache hit is a tenth of fresh input
CACHE_WRITE_5M = 1.25  # the write premium for the 5-minute TTL
CACHE_WRITE_1H = 2.00  # ... and for the 1-hour TTL

NOTE = (
    "Estimated at Anthropic API list prices (as of " + AS_OF + "). Not what you "
    "were charged: this plan is a flat subscription and the CLI reports $0 for "
    "every model. Read it as a yardstick between sessions, not as a bill."
)

CAVEATS = [
    "Sonnet 5 carries introductory pricing ($2/$10) through 2026-08-31; it is "
    "priced here at the standard $3/$15, so recent Sonnet figures run high.",
    "Cache writes are split 1.25x (5-minute TTL) and 2x (1-hour TTL) where the "
    "transcript records the split, and assumed 5-minute where it does not.",
    "Models with no entry in the rate card are counted in tokens and excluded "
    "from every dollar figure rather than guessed at.",
]

_DATE_SUFFIX = re.compile(r"-\d{8}$")


def canonical(model: str) -> str:
    """`claude-haiku-4-5-20251001` and `claude-haiku-4-5` are one rate."""
    return _DATE_SUFFIX.sub("", str(model or "").strip())


def rate(model: str) -> tuple[float, float] | None:
    return RATES.get(canonical(model))


def cost(model: str, tok: dict) -> float | None:
    """USD for one bucket of tokens, or None if the model has no rate.

    None is deliberate. A model released after this table was written should
    make the board say "unpriced", not silently contribute $0 to a total that
    then reads as complete.
    """
    r = rate(model)
    if not r:
        return None
    rin, rout = r
    per = 1_000_000.0
    return (
        (tok.get("in", 0) or 0) * rin / per
        + (tok.get("out", 0) or 0) * rout / per
        + (tok.get("cr", 0) or 0) * rin * CACHE_READ / per
        + (tok.get("cw5", 0) or 0) * rin * CACHE_WRITE_5M / per
        + (tok.get("cw1", 0) or 0) * rin * CACHE_WRITE_1H / per
    )


def cost_of(models: dict) -> tuple[float, int]:
    """Sum a {model: tokens} map. Returns (USD, tokens on unpriced models)."""
    total, unpriced = 0.0, 0
    for name, tok in (models or {}).items():
        c = cost(name, tok)
        if c is None:
            unpriced += sum(v for v in tok.values() if isinstance(v, (int, float)))
        else:
            total += c
    return round(total, 4), unpriced


def card() -> dict:
    """The rate card itself, shipped so the board can show its own arithmetic."""
    return {
        "asOf": AS_OF,
        "note": NOTE,
        "caveats": CAVEATS,
        "cacheRead": CACHE_READ,
        "cacheWrite5m": CACHE_WRITE_5M,
        "cacheWrite1h": CACHE_WRITE_1H,
        "rates": [
            {"model": m, "input": r[0], "output": r[1]}
            for m, r in sorted(RATES.items(), key=lambda kv: -kv[1][1])
        ],
    }
