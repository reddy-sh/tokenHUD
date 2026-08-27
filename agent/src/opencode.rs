//! OpenCode - a tool the board claimed to read for months before anything read it.
//!
//! The integrations catalogue listed OpenCode as `Access::Local`, which the UI
//! renders as "Installed and readable - it has not recorded anything yet". On a
//! machine with 5,225 assistant messages and 344 million cache-read tokens
//! sitting in `~/.local/share/opencode/opencode.db`, that sentence was false in
//! both halves: nothing was reading it, and it had recorded plenty. This is the
//! reader that makes the claim true.
//!
//! **Two layouts, and only ever one of them is read.** OpenCode 1.2 moved to a
//! single SQLite store; before that it wrote one JSON file per message under
//! `storage/message/<session>/`. An upgraded machine has both, and the same
//! message ids are in both - so reading both would double every number on the
//! board. The database wins whenever it is there, and the legacy tree is read
//! only in its absence. The payload says which one it used.
//!
//! **What is named, and what is therefore not read.** The store mixes usage
//! with content: `part` holds the conversation, `session` holds a title, and a
//! user message's `data` carries a summary title of what was asked. So the
//! query is column- and field-scoped in the same way the Devin reader's is -
//! it selects from `message` alone, filters to `role = 'assistant'`, and names
//! only the model, the provider, the token counts, the cost OpenCode recorded
//! and the timestamps. It cannot return a title or a prompt even in principle,
//! because it never mentions one. The working directory each message ran in is
//! there and is deliberately not taken either: knowing which model burned what
//! does not require knowing where.
//!
//! **Cost.** OpenCode records a `cost` per message from its own model registry,
//! and writes 0 for anything billed against a subscription or a free tier -
//! which on this machine is every message, including several hundred Opus ones.
//! Summing those to "$0.00" and putting it on a board would be the exact
//! "present a calculation as a measurement" failure the rest of this codebase
//! refuses, so a zero total is reported as no figure at all, with the reason.
//! The estimate beside it is priced from the same card the Claude board uses,
//! and is marked as an estimate.

use crate::codex::Tokens;
use crate::transcripts::data_home;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

/// A legacy store big enough to stall a 30-second loop is a store that wants
/// the database it has already been told to migrate to. Read what fits and say
/// the reading is partial rather than blocking the cycle.
const LEGACY_FILE_CAP: usize = 20_000;

pub fn store() -> PathBuf {
    data_home().join("opencode")
}

/// The single-file store, OpenCode 1.2 and later.
pub fn db() -> PathBuf {
    store().join("opencode.db")
}

/// One JSON file per message, as builds before 1.2 wrote it.
pub fn legacy_messages() -> PathBuf {
    store().join("storage").join("message")
}

#[derive(Default)]
struct Day {
    tokens: i64,
    output: i64,
    messages: i64,
}

#[derive(Default)]
struct ModelRow {
    provider: String,
    model: String,
    messages: i64,
    tokens: Tokens,
    /// What OpenCode itself recorded, summed. Not this agent's estimate.
    reported_usd: f64,
}

/// Everything one store yields, in the shape the payload is built from. Both
/// readers fill the same fields, so the payload does not change shape when a
/// machine is upgraded out from under it.
#[derive(Default)]
struct Agg {
    /// Keyed `provider/model`, because the same model id arrives through more
    /// than one provider and they are different bills.
    by_model: BTreeMap<String, ModelRow>,
    days: BTreeMap<String, Day>,
    sessions: i64,
    messages: i64,
    last_ms: Option<i64>,
    /// Set when a legacy tree was larger than the cap, so the payload can say
    /// the reading is partial instead of quietly under-reporting.
    truncated: bool,
}

impl Agg {
    fn totals(&self) -> Tokens {
        let mut t = Tokens::default();
        for r in self.by_model.values() {
            t.add(&r.tokens);
        }
        t
    }

    fn reported_usd(&self) -> f64 {
        self.by_model.values().map(|r| r.reported_usd).sum()
    }
}

/// The day a millisecond timestamp falls on, in this machine's timezone.
fn local_day(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&chrono::Local).date_naive().to_string())
}

fn as_i(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0)
}

// ── the database ────────────────────────────────────────────────────────

/// Three statements in one `sqlite3` call: totals by model, totals by day, and
/// the two counts that must be taken over every row rather than derived from a
/// truncated list. Each row is tagged with `k` so one stream of JSON lines can
/// carry all three shapes.
///
/// `-readonly` is not decoration. OpenCode may be running, and a reader that
/// could take a write lock on somebody's live session store is a reader that
/// can lose their work.
const QUERY: &str = "\
SELECT json_object('k','model','model',model,'provider',provider,'messages',n,\
'input',i,'output',o,'reasoning',r,'cacheRead',cr,'cacheWrite',cw,'cost',c) FROM (\
SELECT COALESCE(NULLIF(json_extract(data,'$.modelID'),''),'unknown') AS model,\
COALESCE(NULLIF(json_extract(data,'$.providerID'),''),'unknown') AS provider,\
COUNT(*) AS n,\
SUM(COALESCE(json_extract(data,'$.tokens.input'),0)) AS i,\
SUM(COALESCE(json_extract(data,'$.tokens.output'),0)) AS o,\
SUM(COALESCE(json_extract(data,'$.tokens.reasoning'),0)) AS r,\
SUM(COALESCE(json_extract(data,'$.tokens.cache.read'),0)) AS cr,\
SUM(COALESCE(json_extract(data,'$.tokens.cache.write'),0)) AS cw,\
SUM(COALESCE(json_extract(data,'$.cost'),0)) AS c \
FROM message WHERE json_extract(data,'$.role')='assistant' GROUP BY model,provider);\
SELECT json_object('k','day','date',d,'messages',n,'tokens',t,'output',o) FROM (\
SELECT date(time_created/1000,'unixepoch','localtime') AS d,COUNT(*) AS n,\
SUM(COALESCE(json_extract(data,'$.tokens.input'),0)\
+COALESCE(json_extract(data,'$.tokens.output'),0)\
+COALESCE(json_extract(data,'$.tokens.reasoning'),0)\
+COALESCE(json_extract(data,'$.tokens.cache.read'),0)\
+COALESCE(json_extract(data,'$.tokens.cache.write'),0)) AS t,\
SUM(COALESCE(json_extract(data,'$.tokens.output'),0)) AS o \
FROM message WHERE json_extract(data,'$.role')='assistant' GROUP BY d ORDER BY d DESC LIMIT 60);\
SELECT json_object('k','meta','sessions',COUNT(DISTINCT session_id),'messages',COUNT(*),\
'last',MAX(time_created)) FROM message WHERE json_extract(data,'$.role')='assistant';";

fn read_db(sqlite: &str) -> Option<Agg> {
    let out = Command::new(sqlite)
        .arg("-readonly")
        .arg(db())
        .arg(QUERY)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut agg = Agg::default();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("k").and_then(|k| k.as_str()) {
            Some("model") => {
                let provider = v["provider"].as_str().unwrap_or("unknown").to_string();
                let model = v["model"].as_str().unwrap_or("unknown").to_string();
                let mut row = ModelRow {
                    messages: as_i(v.get("messages")),
                    reported_usd: v.get("cost").and_then(|c| c.as_f64()).unwrap_or(0.0),
                    tokens: Tokens {
                        input: as_i(v.get("input")),
                        cached_input: as_i(v.get("cacheRead")),
                        cache_write: as_i(v.get("cacheWrite")),
                        output: as_i(v.get("output")),
                        reasoning: as_i(v.get("reasoning")),
                        total: 0,
                    },
                    provider,
                    model,
                };
                row.tokens.total = total_of(&row.tokens);
                agg.by_model
                    .insert(format!("{}/{}", row.provider, row.model), row);
            }
            Some("day") => {
                let Some(date) = v.get("date").and_then(|d| d.as_str()) else {
                    continue;
                };
                agg.days.insert(
                    date.to_string(),
                    Day {
                        tokens: as_i(v.get("tokens")),
                        output: as_i(v.get("output")),
                        messages: as_i(v.get("messages")),
                    },
                );
            }
            Some("meta") => {
                agg.sessions = as_i(v.get("sessions"));
                agg.messages = as_i(v.get("messages"));
                agg.last_ms = v.get("last").and_then(|x| x.as_i64());
            }
            _ => {}
        }
    }
    Some(agg)
}

/// OpenCode reports the five counters separately and no total, so this is a sum
/// of five measurements rather than a sixth measurement. They are disjoint -
/// a cached read is not also counted as input - so adding them is the number a
/// reader means by "tokens".
fn total_of(t: &Tokens) -> i64 {
    t.input + t.cached_input + t.cache_write + t.output + t.reasoning
}

// ── the layout before 1.2 ───────────────────────────────────────────────

/// Walk `storage/message/<session>/*.json`, taking the same fields the query
/// names and nothing else.
///
/// Only reached when there is no database. See the module comment: the same
/// messages live in both stores on an upgraded machine, and summing the two
/// would double every figure on the board.
fn read_legacy() -> Option<Agg> {
    let root = legacy_messages();
    let sessions = std::fs::read_dir(&root).ok()?;
    let mut agg = Agg::default();
    let mut files = 0usize;
    for session in sessions.flatten() {
        let dir = session.path();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut counted_session = false;
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if files >= LEGACY_FILE_CAP {
                agg.truncated = true;
                break;
            }
            files += 1;
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if v.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                continue;
            }
            if !counted_session {
                agg.sessions += 1;
                counted_session = true;
            }
            agg.messages += 1;

            let tokens = v.get("tokens");
            let cache = tokens.and_then(|t| t.get("cache"));
            let mut t = Tokens {
                input: as_i(tokens.and_then(|t| t.get("input"))),
                cached_input: as_i(cache.and_then(|c| c.get("read"))),
                cache_write: as_i(cache.and_then(|c| c.get("write"))),
                output: as_i(tokens.and_then(|t| t.get("output"))),
                reasoning: as_i(tokens.and_then(|t| t.get("reasoning"))),
                total: 0,
            };
            t.total = total_of(&t);

            let provider = v
                .get("providerID")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown");
            let model = v
                .get("modelID")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown");
            let row = agg
                .by_model
                .entry(format!("{provider}/{model}"))
                .or_insert_with(|| ModelRow {
                    provider: provider.to_string(),
                    model: model.to_string(),
                    ..ModelRow::default()
                });
            row.messages += 1;
            row.tokens.add(&t);
            row.reported_usd += v.get("cost").and_then(|c| c.as_f64()).unwrap_or(0.0);

            let created = v
                .get("time")
                .and_then(|x| x.get("created"))
                .and_then(|x| x.as_i64());
            if let Some(ms) = created {
                // `is_none_or` is 1.82 and this crate declares 1.75.
                if agg.last_ms.map_or(true, |n| ms > n) {
                    agg.last_ms = Some(ms);
                }
                if let Some(day) = local_day(ms) {
                    let d = agg.days.entry(day).or_default();
                    d.tokens += t.total;
                    d.output += t.output;
                    d.messages += 1;
                }
            }
        }
        if agg.truncated {
            break;
        }
    }
    (agg.messages > 0).then_some(agg)
}

// ── the payload ─────────────────────────────────────────────────────────

fn day_view(days: &BTreeMap<String, Day>) -> Vec<Value> {
    days.iter()
        .rev()
        .take(60)
        .map(|(date, d)| {
            json!({"date": date, "tokens": d.tokens, "output": d.output, "messages": d.messages})
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Everything OpenCode has recorded on this machine, or `available: false`
/// with the reason it has not.
pub fn collect() -> Value {
    if !store().is_dir() {
        return json!({"available": false, "reason": "not installed"});
    }
    let has_db = db().is_file();
    let sqlite = crate::devin::sqlite3_bin();

    let (agg, source) = match (has_db, sqlite) {
        (true, Some(bin)) => match read_db(&bin) {
            Some(a) => (a, "sqlite"),
            None => {
                return json!({
                    "available": false,
                    "reason": "installed, but its database could not be read",
                })
            }
        },
        // A store that is there and unreadable is not a store with nothing in
        // it, and the two must not render the same. Falling back to the legacy
        // tree here would be worse than saying so: on an upgraded machine that
        // tree is a stale fragment, and reporting it as the total would be a
        // wrong number where this is a missing one.
        (true, None) => {
            return json!({
                "available": false,
                "reason": "installed, but this machine has no sqlite3 to read opencode.db with",
            })
        }
        (false, _) => match read_legacy() {
            Some(a) => (a, "legacy-json"),
            None => {
                return json!({
                    "available": false,
                    "reason": "installed, but no sessions recorded",
                })
            }
        },
    };
    if agg.messages == 0 {
        return json!({"available": false, "reason": "installed, but no sessions recorded"});
    }

    // Priced exactly as the Codex board is: from the built-in card where it
    // knows the model, from the user's own card where it does not, and not at
    // all otherwise. An unpriced model contributes tokens and no dollars.
    let mut total_est: Option<f64> = None;
    let mut total_public: Option<f64> = None;
    let mut user_priced_models = 0usize;
    for r in agg.by_model.values() {
        let t = &r.tokens;
        if let Some(c) = crate::pricing::cost_parts(
            &r.model,
            t.input,
            t.cached_input,
            t.cache_write,
            t.output,
            t.reasoning,
        ) {
            total_est = Some(total_est.unwrap_or(0.0) + c);
        }
        if let Some(c) = crate::pricing::cost_parts_builtin(
            &r.model,
            t.input,
            t.cached_input,
            t.cache_write,
            t.output,
            t.reasoning,
        ) {
            total_public = Some(total_public.unwrap_or(0.0) + c);
        }
        if crate::pricing::is_user_priced(&r.model) {
            user_priced_models += 1;
        }
    }

    let reported = agg.reported_usd();
    let mut by_model: Vec<Value> = agg
        .by_model
        .values()
        .map(|r| {
            let t = &r.tokens;
            let est = crate::pricing::cost_parts(
                &r.model,
                t.input,
                t.cached_input,
                t.cache_write,
                t.output,
                t.reasoning,
            );
            json!({
                "model": r.model,
                "provider": r.provider,
                "messages": r.messages,
                "tokens": t,
                "estUSD": est.map(|v| crate::pricing::round(v, 2)),
                "priced": est.is_some(),
            })
        })
        .collect();
    by_model.sort_by(|a, b| {
        b["tokens"]["total"]
            .as_i64()
            .cmp(&a["tokens"]["total"].as_i64())
    });

    json!({
        "available": true,
        // Which store answered. An upgraded machine has both and only one is
        // read; a reader comparing two machines needs to know which.
        "source": source,
        "sessionCount": agg.sessions,
        "messageCount": agg.messages,
        "partial": agg.truncated,
        "totals": agg.totals(),
        "totalsNote": "OpenCode reports five counters and no total; `total` is their sum. They \
                       are disjoint - a cached read is not also counted as input.",
        "byModel": by_model,
        "byDay": day_view(&agg.days),
        "lastActive": agg
            .last_ms
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(crate::collect::iso_of),
        "priced": total_est.is_some(),
        "estUSD": total_est.map(|v| crate::pricing::round(v, 2)),
        "costBasis": if total_est.is_some() {
            crate::pricing::BASIS_API_EQUIVALENT
        } else {
            crate::pricing::BASIS_UNPRICED
        },
        "ratesAsOf": crate::pricing::overrides_as_of(),
        "publicEstUSD": total_public.map(|v| crate::pricing::round(v, 2)),
        "userPricedModels": user_priced_models,
        // What OpenCode itself wrote, not what this agent worked out. Null when
        // every message it recorded came to zero, which is what it writes for
        // subscription and free-tier work - a fact about billing arrangements,
        // not a measurement that the work was free.
        "reportedUSD": (reported > 0.0).then(|| crate::pricing::round(reported, 4)),
        "reportedNote": "OpenCode records its own cost per message and writes 0 for anything \
                         billed against a subscription or a free tier. A zero total is \
                         reported as no figure rather than as $0.00.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point HOME and XDG_DATA_HOME at a scratch tree for one test.
    fn with_store<T>(tag: &str, body: impl FnOnce(&std::path::Path) -> T) -> T {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("opencode-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("opencode")).unwrap();
        let prev = std::env::var("XDG_DATA_HOME").ok();
        std::env::set_var("XDG_DATA_HOME", &root);
        let out = body(&root.join("opencode"));
        match prev {
            Some(p) => std::env::set_var("XDG_DATA_HOME", p),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
        let _ = std::fs::remove_dir_all(&root);
        out
    }

    fn write_legacy(store: &std::path::Path, session: &str, id: &str, body: Value) {
        let dir = store.join("storage").join("message").join(session);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_string(&body).unwrap(),
        )
        .unwrap();
    }

    fn assistant(model: &str, created: i64, input: i64, output: i64) -> Value {
        json!({
            "role": "assistant",
            "modelID": model,
            "providerID": "anthropic",
            "time": {"created": created},
            "cost": 0,
            "tokens": {"input": input, "output": output, "reasoning": 0,
                       "cache": {"read": 7, "write": 3}},
        })
    }

    #[test]
    fn a_machine_without_opencode_says_so_rather_than_showing_zeroes() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("XDG_DATA_HOME", "/nonexistent/definitely/not/here");
        let v = collect();
        std::env::remove_var("XDG_DATA_HOME");
        assert_eq!(v["available"], false);
        assert_eq!(v["reason"], "not installed");
        // No zeroed totals, which would render as "0 tokens" and read as a
        // measurement of nothing rather than an absence of measurement.
        assert!(v.get("totals").is_none());
    }

    #[test]
    fn an_installed_opencode_with_no_messages_is_not_the_same_as_no_opencode() {
        with_store("empty", |_| {
            let v = collect();
            assert_eq!(v["available"], false);
            assert_eq!(v["reason"], "installed, but no sessions recorded");
        });
    }

    #[test]
    fn the_legacy_layout_is_summed_per_model_and_per_day() {
        with_store("legacy", |store| {
            // 2026-08-01T12:00:00Z and one an hour later, plus a message from
            // a different model on the same day.
            write_legacy(
                store,
                "ses_a",
                "msg_1",
                assistant("claude-opus-4-6", 1785931200000, 10, 5),
            );
            write_legacy(
                store,
                "ses_a",
                "msg_2",
                assistant("claude-opus-4-6", 1785934800000, 20, 6),
            );
            write_legacy(
                store,
                "ses_b",
                "msg_3",
                assistant("claude-sonnet-4-6", 1785934800000, 1, 1),
            );
            let v = collect();
            assert_eq!(v["available"], true);
            assert_eq!(v["source"], "legacy-json");
            assert_eq!(v["sessionCount"], 2);
            assert_eq!(v["messageCount"], 3);
            assert_eq!(v["totals"]["input"], 31);
            assert_eq!(v["totals"]["output"], 12);
            assert_eq!(v["totals"]["cached_input"], 21, "three messages at 7 each");
            assert_eq!(v["byModel"].as_array().unwrap().len(), 2);
            let days = v["byDay"].as_array().unwrap();
            assert!(!days.is_empty(), "timestamps must land on a day");
        });
    }

    /// A user message carries the title of what was asked. The reader filters
    /// on role, so it must never be counted and never be quoted.
    #[test]
    fn a_user_message_is_neither_counted_nor_quoted() {
        with_store("roles", |store| {
            write_legacy(
                store,
                "ses_a",
                "msg_1",
                assistant("claude-opus-4-6", 1785931200000, 10, 5),
            );
            write_legacy(
                store,
                "ses_a",
                "msg_0",
                json!({
                    "role": "user",
                    "time": {"created": 1785931100000i64},
                    "summary": {"title": "the secret project name"},
                }),
            );
            let v = collect();
            assert_eq!(v["messageCount"], 1, "only the assistant message counts");
            assert!(
                !serde_json::to_string(&v).unwrap().contains("secret"),
                "nothing from a user message may reach the payload"
            );
        });
    }

    /// The failure this guards against is a board that shows "$0.00 spent" for
    /// several hundred Opus messages, because that is literally what OpenCode
    /// wrote in the file.
    #[test]
    fn a_cost_of_zero_reported_for_subscription_work_is_not_published_as_a_bill() {
        with_store("cost", |store| {
            write_legacy(
                store,
                "ses_a",
                "msg_1",
                assistant("claude-opus-4-6", 1785931200000, 1000, 500),
            );
            let v = collect();
            assert!(
                v["reportedUSD"].is_null(),
                "a total of zero is no figure, not a figure of zero"
            );
            // The estimate is a different column and is allowed to exist,
            // because it says on its face that it is an estimate.
            assert_eq!(v["costBasis"], crate::pricing::BASIS_API_EQUIVALENT);
            assert!(v["estUSD"].as_f64().unwrap() > 0.0);
        });
    }

    #[test]
    fn an_unpriced_model_contributes_tokens_and_no_dollars() {
        with_store("unpriced", |store| {
            write_legacy(
                store,
                "ses_a",
                "msg_1",
                assistant("glm-4.7-free", 1785931200000, 100, 50),
            );
            let v = collect();
            let row = &v["byModel"][0];
            assert_eq!(row["model"], "glm-4.7-free");
            assert_eq!(row["priced"], false);
            assert!(row["estUSD"].is_null(), "unpriced is not $0");
            assert_eq!(row["tokens"]["input"], 100);
            assert_eq!(v["costBasis"], crate::pricing::BASIS_UNPRICED);
        });
    }

    /// The one that would have been an invisible doubling: an upgraded machine
    /// holds the same messages in both stores.
    #[test]
    fn the_legacy_tree_is_ignored_when_a_database_is_present() {
        with_store("both", |store| {
            write_legacy(
                store,
                "ses_a",
                "msg_1",
                assistant("claude-opus-4-6", 1785931200000, 10, 5),
            );
            // Not a real database - enough to be present. The reader must go
            // to it and refuse to fall back, rather than quietly adding the
            // legacy tree's messages to whatever the database holds.
            std::fs::write(store.join("opencode.db"), b"not a database").unwrap();
            let v = collect();
            assert_eq!(v["available"], false);
            assert_ne!(
                v["messageCount"], 1,
                "an unreadable database must not silently become the legacy tree's numbers"
            );
        });
    }

    #[test]
    fn tokens_total_is_the_sum_of_the_five_counters_opencode_reports() {
        let t = Tokens {
            input: 1,
            cached_input: 2,
            cache_write: 4,
            output: 8,
            reasoning: 16,
            total: 0,
        };
        assert_eq!(total_of(&t), 31);
    }
}
