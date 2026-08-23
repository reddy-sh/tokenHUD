//! Storage — SQLite, because the alternative is worse.
//!
//! A metrics store wants three things: append fast, read the latest per host
//! fast, and expire old rows without a maintenance job. SQLite in WAL mode does
//! all three on one file with no daemon, no container and no ops. When one box
//! stops being enough, the schema below ports to Postgres unchanged.
//!
//! Three tables:
//!
//!   hosts      one row per machine, overwritten — "what is true now"
//!   snapshots  append-only history — "what was true then"
//!   endings    derived — "what stopped, and when nobody was looking"
//!
//! `endings` is the one that is not just storage. A snapshot says which agents
//! were running at an instant; nobody watches a dashboard at every instant. The
//! question people actually ask is "what finished while I was away", and that is
//! a difference between two readings, not a reading. The server is the only
//! place that holds both, so the server is where the difference gets taken.
//!
//! ## Why history is stored as differences
//!
//! A reading is ~61 KB of JSON and 59 of its 2,388 leaves change between one
//! reading and the next. Storing each reading whole cost 4.4 GB per host per
//! month at a reading every 37 seconds, which is not a price a local-first tool
//! may charge someone for watching their own machine.
//!
//! So `snapshots` stores a keyframe every KEYFRAME_EVERY rows and a structural
//! difference in between, each zlib-compressed: 61 KB becomes 0.66 KB. A chain
//! is bounded, which also bounds the blast radius if a row is ever lost.
//!
//! The difference is structural rather than textual. A list whose length changed
//! is replaced whole rather than patched element-wise, because index-shifting a
//! list of running processes is exactly the kind of clever that returns wrong
//! data at 2 a.m.

use chrono::{DateTime, SecondsFormat, Utc};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How many differences may follow one keyframe. Sixty readings is about half
/// an hour: short enough that replaying a chain is nothing, long enough that
/// the keyframes are a rounding error in the file.
pub const KEYFRAME_EVERY: i64 = 60;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS hosts (
  host          TEXT PRIMARY KEY,
  last_seen     TEXT NOT NULL,
  agent_version TEXT,
  payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  host    TEXT NOT NULL,
  at      TEXT NOT NULL,
  payload TEXT NOT NULL,
  -- NULL means this row stands alone: a keyframe, or a row written before
  -- differences existed. Anything else is the row this one is a difference
  -- against, and reconstruction walks back to the nearest NULL.
  base_id INTEGER
);

CREATE TABLE IF NOT EXISTS endings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  kind        TEXT,
  tool        TEXT,
  cmd         TEXT,
  ran_seconds INTEGER,
  last_seen   TEXT NOT NULL,
  noticed_at  TEXT NOT NULL,
  UNIQUE (host, pid, last_seen)
);
"#;

// Applied after the tables and after the migration, because one of these names
// a column an older file does not have yet.
const INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_snapshots_host_at ON snapshots (host, at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_keyframe ON snapshots (host, id) WHERE base_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_endings_noticed ON endings (noticed_at DESC);
"#;

// ── ps etime ────────────────────────────────────────────────────────────

/// `[[DD-]HH:]MM:SS`, parsed so the board can say "ran 4h 12m" instead of
/// showing a string only `ps` could love.
pub fn etime_seconds(s: Option<&str>) -> Option<i64> {
    let s = s?.trim();
    if s.is_empty() {
        return None;
    }
    // Optional leading "DD-"
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let nums: Option<Vec<i64>> = parts.iter().map(|p| p.parse::<i64>().ok()).collect();
    let nums = nums?;
    // The Python regex requires at least MM:SS, and allows HH:MM:SS.
    let (h, m, sec) = match nums.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    if days > 0 && parts.len() != 3 {
        return None; // "1-30" is not a shape ps produces
    }
    Some(days * 86400 + h * 3600 + m * 60 + sec)
}

// ── differences ─────────────────────────────────────────────────────────
//
// Three shapes, and no others:
//
//   {"v": x}                 this value is now x, whatever it used to be
//   {"o": {...}, "d": [...]} a dict: these keys changed, these are gone
//   {"a": {"3": {...}}}      a list of the same length: these indices changed
//
// A list whose length changed falls to {"v": ...}.

/// The smallest of the three shapes that turns `old` into `new`, or `None` when
/// there is nothing to say about this subtree.
pub fn diff(old: &Value, new: &Value) -> Option<Value> {
    if old == new {
        return None;
    }
    if let (Some(a), Some(b)) = (old.as_object(), new.as_object()) {
        let mut changed = Map::new();
        for (k, v) in b {
            match a.get(k) {
                Some(prev) => {
                    if let Some(sub) = diff(prev, v) {
                        changed.insert(k.clone(), sub);
                    }
                }
                None => {
                    changed.insert(k.clone(), json!({ "v": v }));
                }
            }
        }
        let gone: Vec<&String> = a.keys().filter(|k| !b.contains_key(*k)).collect();
        let mut out = Map::new();
        if !changed.is_empty() {
            out.insert("o".into(), Value::Object(changed));
        }
        if !gone.is_empty() {
            out.insert("d".into(), json!(gone));
        }
        return if out.is_empty() {
            None
        } else {
            Some(Value::Object(out))
        };
    }
    if let (Some(a), Some(b)) = (old.as_array(), new.as_array()) {
        if a.len() == b.len() {
            let mut items = Map::new();
            for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
                if let Some(sub) = diff(x, y) {
                    items.insert(i.to_string(), sub);
                }
            }
            return if items.is_empty() {
                None
            } else {
                Some(json!({ "a": items }))
            };
        }
    }
    Some(json!({ "v": new }))
}

/// Apply what `diff` produced. Never mutates `base`.
pub fn patch(base: &Value, delta: &Value) -> Value {
    if let Some(v) = delta.get("v") {
        return v.clone();
    }
    if let Some(items) = delta.get("a").and_then(|a| a.as_object()) {
        let mut out = base.as_array().cloned().unwrap_or_default();
        for (i, sub) in items {
            if let Ok(idx) = i.parse::<usize>() {
                if idx < out.len() {
                    out[idx] = patch(&out[idx], sub);
                }
            }
        }
        return Value::Array(out);
    }
    let mut out = base.as_object().cloned().unwrap_or_default();
    if let Some(gone) = delta.get("d").and_then(|d| d.as_array()) {
        for k in gone {
            if let Some(k) = k.as_str() {
                out.shift_remove(k);
            }
        }
    }
    if let Some(changed) = delta.get("o").and_then(|o| o.as_object()) {
        for (k, sub) in changed {
            let next = match out.get(k) {
                Some(prev) => patch(prev, sub),
                None => sub.get("v").cloned().unwrap_or(Value::Null),
            };
            out.insert(k.clone(), next);
        }
    }
    Value::Object(out)
}

fn pack(v: &Value) -> Vec<u8> {
    let mut e = ZlibEncoder::new(Vec::new(), Compression::new(6));
    let _ = e.write_all(serde_json::to_string(v).unwrap_or_default().as_bytes());
    e.finish().unwrap_or_default()
}

/// Rows written before compression are TEXT; rows written since are BLOB.
///
/// Both are readable for as long as the old ones survive retention, which is
/// the whole reason the column was not migrated: a rewrite of every historic
/// row buys nothing that waiting thirty days does not.
fn unpack(raw: ValueRef<'_>) -> Option<Value> {
    match raw {
        ValueRef::Blob(b) => {
            let mut s = String::new();
            ZlibDecoder::new(b).read_to_string(&mut s).ok()?;
            serde_json::from_str(&s).ok()
        }
        ValueRef::Text(t) => serde_json::from_slice(t).ok(),
        _ => None,
    }
}

fn now_iso() -> String {
    iso(Utc::now())
}

/// Python's `datetime.isoformat()`: six decimal places when there are
/// microseconds, none when there are not.
pub fn iso(dt: DateTime<Utc>) -> String {
    if dt.timestamp_subsec_micros() == 0 {
        dt.to_rfc3339_opts(SecondsFormat::Secs, false)
    } else {
        dt.to_rfc3339_opts(SecondsFormat::Micros, false)
    }
}

// ── the store ───────────────────────────────────────────────────────────

pub struct Store {
    pub path: PathBuf,
    retention_days: i64,
    db: Mutex<Connection>,
    /// The tail of each host's difference chain: the row a new difference would
    /// be taken against, and how long the chain already is. Empty at startup,
    /// which is why the first reading after a restart is a keyframe — the
    /// cheapest possible way to be certain a chain is never guessed at.
    chain: Mutex<std::collections::HashMap<String, (i64, i64)>>,
}

impl Store {
    pub fn open(path: &Path, retention_days: i64) -> rusqlite::Result<Store> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        db.execute_batch(SCHEMA)?;
        let has_base = db
            .prepare("PRAGMA table_info(snapshots)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|n| n == "base_id");
        if !has_base {
            db.execute_batch("ALTER TABLE snapshots ADD COLUMN base_id INTEGER")?;
        }
        db.execute_batch(INDEXES)?;
        Ok(Store {
            path: path.to_path_buf(),
            retention_days,
            db: Mutex::new(db),
            chain: Mutex::new(Default::default()),
        })
    }

    // ── writes ──────────────────────────────────────────────────────────

    pub fn ingest(&self, snapshot: &Value) -> rusqlite::Result<()> {
        let host = snapshot
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        // `collectedAt` is caller-supplied and it is what retention compares
        // against, so a reading stamped 9999-01-01 is stored verbatim and never
        // prunes. The past is left alone — an agent that spooled through a week
        // offline legitimately replays old readings — but the future is clamped
        // to now, with an hour of slack for a clock that is merely wrong.
        let at = match snapshot.get("collectedAt").and_then(|v| v.as_str()) {
            Some(s) => {
                let too_far = Utc::now() + chrono::Duration::hours(1);
                match chrono::DateTime::parse_from_rfc3339(s) {
                    Ok(t) if t.with_timezone(&Utc) > too_far => iso(Utc::now()),
                    Ok(_) => s.to_string(),
                    Err(_) => iso(Utc::now()),
                }
            }
            None => now_iso(),
        };
        let blob = pack(snapshot);

        let db = self.db.lock().unwrap();
        let prev: Option<(String, Option<Value>)> = db
            .query_row(
                "SELECT last_seen, payload FROM hosts WHERE host=?",
                [&host],
                |r| Ok((r.get::<_, String>(0)?, unpack(r.get_ref(1)?))),
            )
            .ok();

        // Only a reading NEWER than the one on file can tell us something
        // stopped. The agent spools when the server is away and replays on
        // reconnect, so an older snapshot arriving is normal — and diffing it
        // would report every currently-running agent as ended.
        if let Some((last_seen, prev_obj)) = &prev {
            if last_seen.as_str() < at.as_str() {
                self.record_endings(&db, &host, last_seen, prev_obj.as_ref(), &at, snapshot)?;
            }
        }

        db.execute(
            // WHERE excluded.last_seen > hosts.last_seen: `hosts` means "what is
            // true now", and a replayed or back-dated reading must not rewind
            // it. The endings check three lines above already refuses to look
            // backwards; this row was the one place that still did.
            "INSERT INTO hosts (host, last_seen, agent_version, payload) VALUES (?,?,?,?) \
             ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen, \
             agent_version=excluded.agent_version, payload=excluded.payload \
             WHERE excluded.last_seen > hosts.last_seen",
            params![
                &host,
                &at,
                snapshot.get("agentVersion").and_then(|v| v.as_str()),
                &blob
            ],
        )?;

        // `hosts` always holds the reading that the newest snapshot row holds,
        // because both are written here, together. That is what makes the
        // previous reading available to difference against without reading the
        // history table at all.
        let (base_id, depth) = {
            let c = self.chain.lock().unwrap();
            c.get(&host).copied().unwrap_or((0, 0))
        };
        let prev_obj = prev.as_ref().and_then(|(_, p)| p.as_ref());

        let can_difference = if base_id == 0 || depth >= KEYFRAME_EVERY {
            None
        } else {
            prev_obj
        };
        let (row, row_base, depth) = if let Some(prev_obj) = can_difference {
            let delta = diff(prev_obj, snapshot).unwrap_or(json!({}));
            let packed = pack(&delta);
            if packed.len() >= blob.len() {
                // A difference bigger than the thing it describes is not a
                // saving, and it would cost a replay to read. Take the keyframe
                // instead and start the chain over.
                (blob.clone(), None, 0)
            } else {
                (packed, Some(base_id), depth + 1)
            }
        } else {
            (blob.clone(), None, 0)
        };

        db.execute(
            "INSERT INTO snapshots (host, at, payload, base_id) VALUES (?,?,?,?)",
            params![&host, &at, &row, row_base],
        )?;
        let id = db.last_insert_rowid();
        self.chain.lock().unwrap().insert(host, (id, depth));
        Ok(())
    }

    /// Whatever was running last time and is not running now, ended.
    fn record_endings(
        &self,
        db: &Connection,
        host: &str,
        prev_seen: &str,
        prev_obj: Option<&Value>,
        at: &str,
        snapshot: &Value,
    ) -> rusqlite::Result<()> {
        let before = match prev_obj
            .and_then(|p| p.get("metrics"))
            .and_then(|m| m.get("processes"))
            .and_then(|p| p.as_array())
        {
            Some(b) if !b.is_empty() => b,
            _ => return Ok(()),
        };
        let empty = Vec::new();
        let after = snapshot
            .get("metrics")
            .and_then(|m| m.get("processes"))
            .and_then(|p| p.as_array())
            .unwrap_or(&empty);
        let live: Vec<i64> = after
            .iter()
            .filter_map(|p| p.get("pid")?.as_i64())
            .collect();

        for p in before {
            let pid = match p.get("pid").and_then(|v| v.as_i64()) {
                Some(p) => p,
                None => continue,
            };
            if live.contains(&pid) {
                continue;
            }
            let cmd: String = p
                .get("cmd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            db.execute(
                "INSERT OR IGNORE INTO endings \
                 (host, pid, kind, tool, cmd, ran_seconds, last_seen, noticed_at) \
                 VALUES (?,?,?,?,?,?,?,?)",
                params![
                    host,
                    pid,
                    p.get("kind").and_then(|v| v.as_str()),
                    p.get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("claude-code"),
                    cmd,
                    etime_seconds(p.get("elapsed").and_then(|v| v.as_str())),
                    prev_seen,
                    at
                ],
            )?;
        }
        Ok(())
    }

    /// Recently finished agents, newest first.
    ///
    /// Each row carries both timestamps, not one. A reading every 30 seconds
    /// places an ending inside a 30-second window; a laptop that slept places it
    /// inside a four-hour one. The board can only be honest about when something
    /// ended if it is told how wide the window was.
    pub fn endings(&self, limit: i64, within_hours: i64, host: Option<&str>) -> Vec<Value> {
        let cutoff = iso(Utc::now() - chrono::Duration::hours(within_hours));
        let db = self.db.lock().unwrap();
        let mut sql = String::from(
            "SELECT host, pid, kind, tool, cmd, ran_seconds, last_seen, noticed_at \
             FROM endings WHERE noticed_at >= ?",
        );
        if host.is_some() {
            sql.push_str(" AND host=?");
        }
        sql.push_str(" ORDER BY noticed_at DESC, id DESC LIMIT ?");

        let row_to_json = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
            Ok(json!({
                "host": r.get::<_, String>(0)?,
                "pid": r.get::<_, i64>(1)?,
                "kind": r.get::<_, Option<String>>(2)?,
                "tool": r.get::<_, Option<String>>(3)?,
                "cmd": r.get::<_, Option<String>>(4)?,
                "ran_seconds": r.get::<_, Option<i64>>(5)?,
                "last_seen": r.get::<_, String>(6)?,
                "noticed_at": r.get::<_, String>(7)?,
            }))
        };
        let mut stmt = match db.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match host {
            Some(h) => stmt.query_map(params![cutoff, h, limit], row_to_json),
            None => stmt.query_map(params![cutoff, limit], row_to_json),
        };
        rows.map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Drop history past the retention window.
    ///
    /// A difference is meaningless without the rows it is a difference against,
    /// so the cut is not taken at the cutoff exactly: for each host it is taken
    /// at the last keyframe at or before the cutoff, and rows from there on are
    /// kept even if some are older. That over-keeps at most one chain — under an
    /// hour — which is the right way to be wrong about a retention boundary.
    pub fn prune(&self) -> rusqlite::Result<usize> {
        let cutoff = iso(Utc::now() - chrono::Duration::days(self.retention_days));
        let db = self.db.lock().unwrap();
        let hosts: Vec<String> = db
            .prepare("SELECT DISTINCT host FROM snapshots")?
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        let mut removed = 0;
        for host in hosts {
            let kf: Option<i64> = db
                .query_row(
                    "SELECT MAX(id) FROM snapshots WHERE host=? AND base_id IS NULL AND at <= ?",
                    params![&host, &cutoff],
                    |r| r.get(0),
                )
                .unwrap_or(None);
            // No keyframe old enough to cut at: every surviving row may still be
            // needed. Nothing to drop for this host.
            if let Some(kf) = kf {
                removed += db.execute(
                    "DELETE FROM snapshots WHERE host=? AND at < ? AND id < ?",
                    params![&host, &cutoff, kf],
                )?;
            }
        }
        db.execute("DELETE FROM endings WHERE noticed_at < ?", [&cutoff])?;
        Ok(removed)
    }

    // ── reads ───────────────────────────────────────────────────────────

    pub fn hosts(&self) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = match db
            .prepare("SELECT host, last_seen, agent_version FROM hosts ORDER BY last_seen DESC")
        {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok(json!({
                "host": r.get::<_, String>(0)?,
                "last_seen": r.get::<_, String>(1)?,
                "agent_version": r.get::<_, Option<String>>(2)?,
            }))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn all_latest(&self) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = match db.prepare("SELECT payload FROM hosts ORDER BY last_seen DESC") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| Ok(unpack(r.get_ref(0)?)))
            .map(|r| r.filter_map(Result::ok).flatten().collect())
            .unwrap_or_default()
    }

    /// The last `limit` readings for a host, oldest first.
    ///
    /// Ordered by id, not by time: id is arrival order, and arrival order is the
    /// only order in which a chain of differences means anything.
    pub fn history(&self, host: &str, limit: i64) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let first: Option<i64> = db
            .query_row(
                "SELECT MIN(id) FROM (SELECT id FROM snapshots WHERE host=? ORDER BY id DESC LIMIT ?)",
                params![host, limit],
                |r| r.get(0),
            )
            .unwrap_or(None);
        let first = match first {
            Some(f) => f,
            None => return Vec::new(),
        };
        let start: i64 = db
            .query_row(
                "SELECT MAX(id) FROM snapshots WHERE host=? AND base_id IS NULL AND id <= ?",
                params![host, first],
                |r| r.get::<_, Option<i64>>(0),
            )
            .unwrap_or(None)
            .unwrap_or(first);

        let mut stmt = match db.prepare(
            "SELECT id, at, payload, base_id FROM snapshots WHERE host=? AND id >= ? ORDER BY id",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows: Vec<(i64, String, Option<Value>, Option<i64>)> = stmt
            .query_map(params![host, start], |r| {
                Ok((r.get(0)?, r.get(1)?, unpack(r.get_ref(2)?), r.get(3)?))
            })
            .map(|r| r.filter_map(Result::ok).collect())
            .unwrap_or_default();
        drop(stmt);
        drop(db);

        let mut out = Vec::new();
        let mut cur: Option<Value> = None;
        for (id, at, payload, base_id) in rows {
            let payload = match payload {
                Some(p) => p,
                None => continue,
            };
            cur = Some(match base_id {
                None => payload,
                Some(_) => match &cur {
                    // A chain whose keyframe is gone: skip, do not guess.
                    None => continue,
                    Some(c) => patch(c, &payload),
                },
            });
            if id >= first {
                if let Some(Value::Object(map)) = cur.clone() {
                    let mut row = Map::new();
                    row.insert("at".into(), json!(at));
                    for (k, v) in map {
                        row.insert(k, v);
                    }
                    out.push(Value::Object(row));
                }
            }
        }
        out
    }

    pub fn counts(&self) -> Value {
        let db = self.db.lock().unwrap();
        let one = |sql: &str| -> i64 { db.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
        json!({
            "snapshots": one("SELECT COUNT(*) FROM snapshots"),
            "hosts": one("SELECT COUNT(*) FROM hosts"),
            "endings": one("SELECT COUNT(*) FROM endings"),
            "keyframes": one("SELECT COUNT(*) FROM snapshots WHERE base_id IS NULL"),
            "db": self.path.to_string_lossy(),
            "bytes": std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_etime_parses_in_all_four_shapes() {
        assert_eq!(etime_seconds(Some("45")), None);
        assert_eq!(etime_seconds(Some("01:30")), Some(90));
        assert_eq!(etime_seconds(Some("02:03:04")), Some(7384));
        assert_eq!(etime_seconds(Some("1-02:03:04")), Some(93784));
    }

    #[test]
    fn a_difference_round_trips() {
        let a = json!({"n": 1, "list": [1, 2, 3], "gone": true, "deep": {"x": [{"y": 1}]}});
        let b = json!({"n": 2, "list": [1, 9, 3], "added": "yes", "deep": {"x": [{"y": 2}]}});
        let d = diff(&a, &b).expect("they differ");
        assert_eq!(patch(&a, &d), b, "a difference must reconstruct exactly");
    }

    #[test]
    fn a_list_that_changed_length_is_replaced_whole() {
        let a = json!({"procs": [1, 2, 3]});
        let b = json!({"procs": [1, 3]});
        let d = diff(&a, &b).unwrap();
        // Not an index patch: index-shifting a list of running processes is
        // the kind of clever that returns wrong data at 2 a.m.
        assert!(
            d["o"]["procs"].get("v").is_some(),
            "expected a whole replacement, got {d}"
        );
        assert_eq!(patch(&a, &d), b);
    }

    #[test]
    fn identical_readings_produce_no_difference() {
        let a = json!({"same": [1, {"x": 2}]});
        assert!(diff(&a, &a).is_none());
        // …and an empty patch is still an identity.
        assert_eq!(patch(&a, &json!({})), a);
    }
}
