//! Storage - SQLite, because the alternative is worse.
//!
//! A metrics store wants three things: append fast, read the latest per host
//! fast, and expire old rows without a maintenance job. SQLite in WAL mode does
//! all three on one file with no daemon, no container and no ops. When one box
//! stops being enough, the schema below ports to Postgres unchanged.
//!
//! The tables:
//!
//!   hosts      one row per machine, overwritten - "what is true now"
//!   snapshots  append-only history - "what was true then"
//!   endings    derived - "what stopped, and when nobody was looking"
//!   shares     one row per public leaderboard link - "who may look, as what"
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

-- One row per enrollment link. The token itself never lands here: only its
-- hash, so the database is not a second place the secret lives. `install_id`
-- is NULL until a machine claims the link, and the row is deleted the moment
-- the machine key is delivered - a link is a one-shot thing.
CREATE TABLE IF NOT EXISTS enroll_tokens (
  token_hash TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  install_id TEXT
);

-- One row per machine that has ever enrolled. The machine's key is stored as
-- a hash for the same reason the token is; `label` is the name every other
-- table files this machine under, disambiguated at claim time so two laptops
-- called MacBook-Pro.local stay two rows.
CREATE TABLE IF NOT EXISTS machines (
  install_id       TEXT PRIMARY KEY,
  label            TEXT NOT NULL UNIQUE,
  hostname         TEXT NOT NULL,
  platform         TEXT,
  agent_version    TEXT,
  manifest_digest  TEXT,
  assistants       TEXT,
  code             TEXT NOT NULL,
  status           TEXT NOT NULL,
  key_hash         TEXT,
  -- Hash of a secret the CLAIMING machine invented. Key delivery requires it,
  -- so a link that leaked after the claim delivers nothing to the thief: the
  -- token says which enrollment, the secret says which machine may collect.
  poll_secret_hash TEXT,
  created_at       TEXT NOT NULL,
  decided_at       TEXT
);

-- One row per share link. A share is a public, read-only view of the
-- leaderboard: a URL anyone may open, holding token counts, model names and
-- daily activity - and nothing that says what the work was about. What may
-- leave is decided in one place, `share.rs`, by naming the fields that go
-- rather than the fields that stay.
--
-- `identities` is the one thing the person sharing chooses about privacy:
-- 'alias' replaces every machine name with a pseudonym derived from the slug,
-- so two shares of the same fleet cannot be lined up against each other;
-- 'host' prints the real names, which is what a team board wants.
--
-- Revoking sets `revoked_at` rather than deleting the row: a link that was
-- public once is worth remembering, and the view count is the only evidence
-- of who ever looked.
CREATE TABLE IF NOT EXISTS shares (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  identities TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  views      INTEGER NOT NULL DEFAULT 0,
  last_view  TEXT
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
    /// which is why the first reading after a restart is a keyframe - the
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
        let has_secret = db
            .prepare("PRAGMA table_info(machines)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|n| n == "poll_secret_hash");
        if !has_secret {
            db.execute_batch("ALTER TABLE machines ADD COLUMN poll_secret_hash TEXT")?;
        }
        // Stable machine identity: survives hostname renames.
        let hosts_cols: Vec<String> = db
            .prepare("PRAGMA table_info(hosts)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();
        if !hosts_cols.iter().any(|n| n == "machine_id") {
            db.execute_batch("ALTER TABLE hosts ADD COLUMN machine_id TEXT")?;
        }
        if !hosts_cols.iter().any(|n| n == "label") {
            db.execute_batch("ALTER TABLE hosts ADD COLUMN label TEXT")?;
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
        let machine_id = snapshot
            .get("machineId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let host = snapshot
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        // If a machineId is present and we already know this machine under a
        // different hostname, update the row to the new name. This makes
        // hostname renames seamless: the board keeps the history.
        if let Some(mid) = &machine_id {
            let db = self.db.lock().unwrap();
            if let Ok(old_host) =
                db.query_row("SELECT host FROM hosts WHERE machine_id = ?", [mid], |r| {
                    r.get::<_, String>(0)
                })
            {
                if old_host != host {
                    // Same machine, different hostname: update in place.
                    db.execute(
                        "UPDATE hosts SET host = ? WHERE machine_id = ?",
                        rusqlite::params![&host, mid],
                    )?;
                    db.execute(
                        "UPDATE snapshots SET host = ? WHERE host = ?",
                        rusqlite::params![&host, &old_host],
                    )?;
                    db.execute(
                        "UPDATE endings SET host = ? WHERE host = ?",
                        rusqlite::params![&host, &old_host],
                    )?;
                }
            }
            drop(db);
        }
        // `collectedAt` is caller-supplied and it is what retention compares
        // against, so a reading stamped 9999-01-01 is stored verbatim and never
        // prunes. The past is left alone - an agent that spooled through a week
        // offline legitimately replays old readings - but the future is clamped
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
        // reconnect, so an older snapshot arriving is normal - and diffing it
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
            "INSERT INTO hosts (host, last_seen, agent_version, machine_id, payload) \
             VALUES (?,?,?,?,?) \
             ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen, \
             agent_version=excluded.agent_version, \
             machine_id=COALESCE(excluded.machine_id, hosts.machine_id), \
             payload=excluded.payload \
             WHERE excluded.last_seen > hosts.last_seen",
            params![
                &host,
                &at,
                snapshot.get("agentVersion").and_then(|v| v.as_str()),
                &machine_id,
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
    /// kept even if some are older. That over-keeps at most one chain - under an
    /// hour - which is the right way to be wrong about a retention boundary.
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
        let mut stmt = match db.prepare(
            "SELECT host, last_seen, agent_version, machine_id, label \
             FROM hosts ORDER BY last_seen DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok(json!({
                "host": r.get::<_, String>(0)?,
                "last_seen": r.get::<_, String>(1)?,
                "agent_version": r.get::<_, Option<String>>(2)?,
                "machine_id": r.get::<_, Option<String>>(3)?,
                "label": r.get::<_, Option<String>>(4)?,
            }))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn rename_host(&self, machine_id: &str, label: &str) -> rusqlite::Result<bool> {
        let db = self.db.lock().unwrap();
        let n = db.execute(
            "UPDATE hosts SET label = ? WHERE machine_id = ?",
            params![label, machine_id],
        )?;
        Ok(n > 0)
    }

    pub fn remove_host(&self, host: &str) -> rusqlite::Result<bool> {
        let db = self.db.lock().unwrap();
        let n = db.execute("DELETE FROM hosts WHERE host = ?", params![host])?;
        // Clean up related data.
        let _ = db.execute("DELETE FROM snapshots WHERE host = ?", params![host]);
        let _ = db.execute("DELETE FROM endings WHERE host = ?", params![host]);
        Ok(n > 0)
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

    // ── enrollment ──────────────────────────────────────────────────────
    //
    // The flow, end to end: the board mints a link (a one-time token); a new
    // machine claims it, which creates a `machines` row in `pending`; a person
    // approves that row on the board; the machine's next status poll delivers
    // its own key, exactly once, and the token row is deleted. From then on the
    // machine authenticates with its key alone, and revoking it removes one
    // machine - never the fleet.

    /// How long a minted link is claimable, and how long an unapproved claim
    /// may sit before the whole attempt expires.
    pub const ENROLL_TTL_SECS: i64 = 900;

    /// Record a freshly minted enrollment token (as its hash). Expired,
    /// never-delivered attempts are swept here rather than on a timer: minting
    /// is rare, and it is the moment staleness could actually accumulate.
    pub fn enroll_mint(&self, token_hash: &str, code: &str) -> rusqlite::Result<String> {
        let now = Utc::now();
        let expires = iso(now + chrono::Duration::seconds(Self::ENROLL_TTL_SECS));
        let db = self.db.lock().unwrap();
        // An UNCLAIMED link dies at its TTL. A claimed one must outlive it:
        // approval can legitimately land after the link's own window, and the
        // agent is still polling - deleting its token then would strand an
        // approved machine keyless. Claimed tokens die at delivery, at denial,
        // or after a day, whichever comes first.
        db.execute(
            "DELETE FROM enroll_tokens WHERE expires_at < ? AND install_id IS NULL",
            [&now_iso()],
        )?;
        db.execute(
            "DELETE FROM enroll_tokens WHERE created_at < ?",
            [&iso(now - chrono::Duration::hours(24))],
        )?;
        // Pending rows whose token is gone: a first-time attempt is a dead
        // card and is dropped; a machine that had been decided before (it
        // re-claimed a link and stalled) falls back to revoked rather than
        // being erased - its label is what the history tables file data under.
        db.execute(
            "DELETE FROM machines WHERE status='pending' AND decided_at IS NULL \
             AND install_id NOT IN \
             (SELECT install_id FROM enroll_tokens WHERE install_id IS NOT NULL)",
            [],
        )?;
        db.execute(
            "UPDATE machines SET status='revoked' WHERE status='pending' \
             AND decided_at IS NOT NULL AND install_id NOT IN \
             (SELECT install_id FROM enroll_tokens WHERE install_id IS NOT NULL)",
            [],
        )?;
        db.execute(
            "INSERT INTO enroll_tokens (token_hash, code, created_at, expires_at) VALUES (?,?,?,?)",
            params![token_hash, code, iso(now), &expires],
        )?;
        Ok(expires)
    }

    /// A machine presents a link's token, a secret it just invented (key
    /// delivery will demand it back), and its facts. Idempotent for the same
    /// install id, so a retried request is a refresh rather than an error.
    /// Nine arguments because they are nine columns of one row; a struct
    /// with one caller would be ceremony.
    #[allow(clippy::too_many_arguments)]
    pub fn enroll_claim(
        &self,
        token_hash: &str,
        poll_secret_hash: &str,
        install_id: &str,
        hostname: &str,
        platform: &str,
        agent_version: &str,
        manifest_digest: &str,
        assistants: &Value,
    ) -> rusqlite::Result<Result<String, &'static str>> {
        let db = self.db.lock().unwrap();
        let row: Option<(String, String, Option<String>)> = db
            .query_row(
                "SELECT code, expires_at, install_id FROM enroll_tokens WHERE token_hash=?",
                [token_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let (code, expires_at, bound) = match row {
            Some(r) => r,
            None => return Ok(Err("unknown enrollment link")),
        };
        if expires_at < now_iso() {
            return Ok(Err("enrollment link expired"));
        }
        // One link, one machine. The same machine retrying is fine; a second
        // machine on a link someone already used is exactly the theft this
        // check exists for.
        if let Some(b) = &bound {
            if b != install_id {
                return Ok(Err("enrollment link already used"));
            }
        }
        // An approved machine holding a working key must not be dragged back
        // to pending by a claim - that would revoke it without a decision.
        // Whoever wants to re-enroll it revokes it on the board first.
        let approved: bool = db
            .query_row(
                "SELECT 1 FROM machines WHERE install_id=? AND status='approved' \
                 AND key_hash IS NOT NULL",
                [install_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if approved {
            return Ok(Err(
                "this machine is already enrolled - revoke it on the board first",
            ));
        }
        // A denial is terminal for THIS link: the machine may not re-claim its
        // way back onto the pending list and ask again. A fresh link, minted
        // by a person who changed their mind, enrolls it fine.
        if bound.is_some() {
            let denied: bool = db
                .query_row(
                    "SELECT 1 FROM machines WHERE install_id=? AND status='denied'",
                    [install_id],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if denied {
                return Ok(Err("denied on this board - ask for a fresh link"));
            }
        }

        // The label is what every other table files this machine under, and
        // the namespace is shared with legacy shared-key hosts - so a name is
        // taken if EITHER table knows it. Collisions get a suffix of the
        // install id, lengthened until unique, so two identically named
        // laptops stay two rows and an enrolling machine can never write over
        // a legacy host's data.
        let existing_label: Option<String> = db
            .query_row(
                "SELECT label FROM machines WHERE install_id=?",
                [install_id],
                |r| r.get(0),
            )
            .ok();
        let label = match existing_label {
            Some(l) => l,
            None => {
                let taken = |candidate: &str| -> bool {
                    db.query_row(
                        "SELECT 1 FROM machines WHERE label=? AND install_id != ?",
                        params![candidate, install_id],
                        |_| Ok(true),
                    )
                    .unwrap_or(false)
                        || db
                            .query_row("SELECT 1 FROM hosts WHERE host=?", [candidate], |_| {
                                Ok(true)
                            })
                            .unwrap_or(false)
                };
                let mut pick = hostname.to_string();
                let mut n = 4;
                while taken(&pick) && n <= install_id.len() {
                    pick = format!("{} · {}", hostname, &install_id[..n]);
                    n += 2;
                }
                pick
            }
        };

        db.execute(
            "INSERT INTO machines (install_id, label, hostname, platform, agent_version, \
             manifest_digest, assistants, code, status, key_hash, poll_secret_hash, \
             created_at, decided_at) \
             VALUES (?,?,?,?,?,?,?,?,'pending',NULL,?,?,NULL) \
             ON CONFLICT(install_id) DO UPDATE SET hostname=excluded.hostname, \
             platform=excluded.platform, agent_version=excluded.agent_version, \
             manifest_digest=excluded.manifest_digest, assistants=excluded.assistants, \
             code=excluded.code, status='pending', key_hash=NULL, \
             poll_secret_hash=excluded.poll_secret_hash",
            params![
                install_id,
                &label,
                hostname,
                platform,
                agent_version,
                manifest_digest,
                serde_json::to_string(assistants).unwrap_or_default(),
                &code,
                poll_secret_hash,
                &now_iso(),
            ],
        )?;
        db.execute(
            "UPDATE enroll_tokens SET install_id=? WHERE token_hash=?",
            params![install_id, token_hash],
        )?;
        Ok(Ok(code))
    }

    /// One status poll. When the machine is approved and no key has been
    /// delivered yet, the caller's candidate key is committed and returned -
    /// and never again: the token row is deleted in the same transaction-shaped
    /// moment, so a second poll (or a stolen link replayed later) gets nothing.
    ///
    /// Delivery demands the poll secret from the CLAIM, not just the token: a
    /// link that leaked (chat, shell history, a shoulder) identifies the
    /// enrollment, but only the machine that claimed it can collect the key.
    pub fn enroll_state(
        &self,
        token_hash: &str,
        poll_secret_hash: &str,
        candidate_key: &str,
        candidate_hash: &str,
    ) -> Option<Value> {
        let db = self.db.lock().unwrap();
        let install_id: Option<String> = db
            .query_row(
                "SELECT install_id FROM enroll_tokens WHERE token_hash=?",
                [token_hash],
                |r| r.get(0),
            )
            .ok()?;
        let install_id = install_id?; // minted but never claimed: nothing to report
        let (status, key_hash, label, code): (String, Option<String>, String, String) = db
            .query_row(
                "SELECT status, key_hash, label, code FROM machines \
                 WHERE install_id=? AND poll_secret_hash=?",
                params![&install_id, poll_secret_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok()?;
        match status.as_str() {
            "approved" if key_hash.is_none() => {
                if db
                    .execute(
                        "UPDATE machines SET key_hash=? WHERE install_id=? AND key_hash IS NULL",
                        params![candidate_hash, &install_id],
                    )
                    .unwrap_or(0)
                    == 1
                {
                    let _ =
                        db.execute("DELETE FROM enroll_tokens WHERE token_hash=?", [token_hash]);
                    Some(json!({
                        "status": "approved",
                        "key": candidate_key,
                        "installId": install_id,
                        "label": label,
                    }))
                } else {
                    Some(json!({"status": "approved", "delivered": true}))
                }
            }
            "approved" => Some(json!({"status": "approved", "delivered": true})),
            other => Some(json!({"status": other, "code": code})),
        }
    }

    /// Approve, deny, or revoke one machine. Revoking clears the key hash, so
    /// a revoked laptop cannot come back without a fresh link - re-approval is
    /// re-enrollment, not a toggle. Deny and revoke also burn the enrollment
    /// token, so a denied machine cannot use the same link to reappear as
    /// pending and ask again.
    pub fn machine_decide(&self, install_id: &str, action: &str) -> rusqlite::Result<bool> {
        let db = self.db.lock().unwrap();
        let n = match action {
            "approve" => db.execute(
                "UPDATE machines SET status='approved', decided_at=? \
                 WHERE install_id=? AND status='pending'",
                params![&now_iso(), install_id],
            )?,
            // The token survives a denial so the waiting agent's next poll can
            // say "denied" rather than vanishing on it; enroll_claim refuses a
            // re-claim on a denied machine's link, so surviving ≠ reusable.
            "deny" => db.execute(
                "UPDATE machines SET status='denied', decided_at=?, key_hash=NULL \
                 WHERE install_id=? AND status='pending'",
                params![&now_iso(), install_id],
            )?,
            "revoke" => {
                let n = db.execute(
                    "UPDATE machines SET status='revoked', decided_at=?, key_hash=NULL \
                     WHERE install_id=? AND status IN ('approved','pending')",
                    params![&now_iso(), install_id],
                )?;
                if n == 1 {
                    db.execute("DELETE FROM enroll_tokens WHERE install_id=?", [install_id])?;
                }
                n
            }
            _ => 0,
        };
        Ok(n == 1)
    }

    /// Every machine that has ever enrolled, for the board. The pairing code
    /// travels only while the decision is still open - once decided it is
    /// nobody's business, and before that it is exactly the thing the person
    /// approving is asked to compare.
    pub fn machines(&self) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = match db.prepare(
            "SELECT install_id, label, hostname, platform, agent_version, manifest_digest, \
             assistants, code, status, created_at, decided_at FROM machines ORDER BY created_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            let status: String = r.get(8)?;
            Ok(json!({
                "installId": r.get::<_, String>(0)?,
                "label": r.get::<_, String>(1)?,
                "hostname": r.get::<_, String>(2)?,
                "platform": r.get::<_, Option<String>>(3)?,
                "agentVersion": r.get::<_, Option<String>>(4)?,
                "manifestDigest": r.get::<_, Option<String>>(5)?,
                "assistants": r.get::<_, Option<String>>(6)?
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or(Value::Null),
                "code": if status == "pending" { json!(r.get::<_, String>(7)?) } else { Value::Null },
                "status": status,
                "created_at": r.get::<_, String>(9)?,
                "decided_at": r.get::<_, Option<String>>(10)?,
            }))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    // ── shares ──────────────────────────────────────────────────────────
    //
    // A share is a slug and two settings. Everything a public reader sees is
    // computed from live data at request time, so revoking one really does
    // stop it: there is no rendered copy anywhere to keep serving.

    /// Mint a share. The slug is the credential - unguessable, and the only
    /// thing standing between a public URL and this fleet's numbers.
    pub fn share_create(&self, slug: &str, title: &str, identities: &str) -> rusqlite::Result<()> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO shares (slug, title, identities, created_at) VALUES (?,?,?,?)",
            params![slug, title, identities, now_iso()],
        )?;
        Ok(())
    }

    /// Change a live share's title or identity mode. Returns false for a slug
    /// that does not exist or has been revoked - a revoked share is finished,
    /// not paused.
    pub fn share_update(
        &self,
        slug: &str,
        title: Option<&str>,
        identities: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let db = self.db.lock().unwrap();
        let n = db.execute(
            "UPDATE shares SET title = COALESCE(?, title), \
             identities = COALESCE(?, identities) \
             WHERE slug = ? AND revoked_at IS NULL",
            params![title, identities, slug],
        )?;
        Ok(n == 1)
    }

    /// A live share, by slug. `None` covers both "no such share" and "revoked",
    /// which is the same answer as far as a public reader is concerned.
    pub fn share_get(&self, slug: &str) -> Option<Value> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT slug, title, identities, created_at, views, last_view \
             FROM shares WHERE slug = ? AND revoked_at IS NULL",
            [slug],
            |r| {
                Ok(json!({
                    "slug": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "identities": r.get::<_, String>(2)?,
                    "createdAt": r.get::<_, String>(3)?,
                    "views": r.get::<_, i64>(4)?,
                    "lastView": r.get::<_, Option<String>>(5)?,
                }))
            },
        )
        .ok()
    }

    /// Every share this fleet has ever minted, newest first - revoked ones
    /// included, because "this link used to be public" is something the person
    /// running the board should be able to see.
    pub fn share_list(&self) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        let mut stmt = match db.prepare(
            "SELECT slug, title, identities, created_at, revoked_at, views, last_view \
             FROM shares ORDER BY created_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok(json!({
                "slug": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "identities": r.get::<_, String>(2)?,
                "createdAt": r.get::<_, String>(3)?,
                "revokedAt": r.get::<_, Option<String>>(4)?,
                "views": r.get::<_, i64>(5)?,
                "lastView": r.get::<_, Option<String>>(6)?,
            }))
        })
        .map(|r| r.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    /// Take a share private again. Idempotent: revoking twice is not an error,
    /// but only the first one returns true.
    pub fn share_revoke(&self, slug: &str) -> rusqlite::Result<bool> {
        let db = self.db.lock().unwrap();
        let n = db.execute(
            "UPDATE shares SET revoked_at = ? WHERE slug = ? AND revoked_at IS NULL",
            params![now_iso(), slug],
        )?;
        Ok(n == 1)
    }

    /// Count a public read. Best-effort on purpose - a failed counter must
    /// never be the reason a shared board does not render.
    pub fn share_viewed(&self, slug: &str) {
        let db = self.db.lock().unwrap();
        let _ = db.execute(
            "UPDATE shares SET views = views + 1, last_view = ? WHERE slug = ?",
            params![now_iso(), slug],
        );
    }

    /// The machine behind a presented key, if that machine is still approved.
    pub fn machine_by_key_hash(&self, key_hash: &str) -> Option<(String, String)> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT install_id, label FROM machines WHERE key_hash=? AND status='approved'",
            [key_hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
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
