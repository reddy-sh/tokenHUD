//! Transcript index — per-session usage, read once and never re-read.
//!
//! Three decisions worth keeping, and the reason this is not a naive reader:
//!
//!   · **A byte budget per cycle.** The corpus reaches a gigabyte. Each cycle
//!     reads at most `TOKENHUD_SCAN_BUDGET_MB` and stops mid-file; the next one
//!     resumes at the offset.
//!   · **Tokens are stored, dollars are not.** A rate-card change must not
//!     require re-reading a gigabyte, and a stored dollar figure would quietly
//!     mix two rate cards in one total.
//!   · **Buckets are decided while reading.** Whether a request ran over a 150k
//!     context, and whether it came from a subagent, is known per request and
//!     lost afterwards.
//!
//! Nothing here sends anything. It reads local files and writes one local index.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const VERSION: u32 = 4;
pub const BIG_CONTEXT: i64 = 150_000;
pub const LONG_SESSION_HOURS: f64 = 8.0;
const KEEP_DAYS: usize = 120;
const KEEP_SESSIONS: usize = 3000;
const KEEP_MINUTE_DAYS: i64 = 9;
pub const BLOCK_HOURS: i64 = 5;
/// How much of a transcript is held in memory at once. Small enough that the
/// agent's peak is a property of this constant rather than of the user's
/// corpus, large enough that a gigabyte still reads in one cycle.
const CHUNK: usize = 4 * 1024 * 1024;
/// A JSONL record longer than this is not a record worth waiting for.
const MAX_LINE: u64 = 64 * 1024 * 1024;

// ── the token bucket ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Tok {
    // "in" is a keyword here and a key there.
    #[serde(rename = "in", default)]
    pub tin: i64,
    #[serde(default)]
    pub out: i64,
    #[serde(default)]
    pub cr: i64,
    #[serde(default)]
    pub cw5: i64,
    #[serde(default)]
    pub cw1: i64,
}

impl Tok {
    pub fn add(&mut self, o: &Tok) {
        self.tin += o.tin;
        self.out += o.out;
        self.cr += o.cr;
        self.cw5 += o.cw5;
        self.cw1 += o.cw1;
    }
    pub fn sum(&self) -> i64 {
        self.tin + self.out + self.cr + self.cw5 + self.cw1
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Session {
    pub id: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub first: Option<String>,
    #[serde(default)]
    pub last: Option<String>,
    #[serde(default)]
    pub req: i64,
    #[serde(default)]
    pub tools: i64,
    #[serde(rename = "maxCtx", default)]
    pub max_ctx: i64,
    #[serde(default)]
    pub models: IndexMap<String, Tok>,
    #[serde(default)]
    pub sub: IndexMap<String, Tok>,
    #[serde(default)]
    pub ctx: IndexMap<String, Tok>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct FileState {
    #[serde(default)]
    pub off: u64,
    #[serde(default)]
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Index {
    pub version: u32,
    #[serde(default)]
    pub files: IndexMap<String, FileState>,
    #[serde(default)]
    pub sessions: IndexMap<String, Session>,
    #[serde(default)]
    pub days: IndexMap<String, IndexMap<String, Tok>>,
    #[serde(default)]
    pub minutes: IndexMap<String, i64>,
    #[serde(rename = "outMinutes", default)]
    pub out_minutes: IndexMap<String, i64>,
}

impl Default for Index {
    fn default() -> Self {
        Index {
            version: VERSION,
            files: IndexMap::new(),
            sessions: IndexMap::new(),
            days: IndexMap::new(),
            minutes: IndexMap::new(),
            out_minutes: IndexMap::new(),
        }
    }
}

pub struct Scan {
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub complete: bool,
    pub files: usize,
    pub read_this_cycle: u64,
    pub seconds: f64,
}

// ── paths ───────────────────────────────────────────────────────────────

pub fn state_dir() -> PathBuf {
    match std::env::var("TOKENHUD_STATE") {
        Ok(v) if !v.is_empty() => expand_tilde(&v),
        _ => home().join(".tokenhud"),
    }
}

pub fn home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

pub fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        home().join(rest)
    } else if s == "~" {
        home()
    } else {
        PathBuf::from(s)
    }
}

pub fn claude_dir() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(v) if !v.is_empty() => expand_tilde(&v),
        _ => home().join(".claude"),
    }
}

fn index_path() -> PathBuf {
    state_dir().join("transcripts.json")
}

fn budget() -> u64 {
    std::env::var("TOKENHUD_SCAN_BUDGET_MB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|m| m.max(1))
        .unwrap_or(512)
        * 1024
        * 1024
}

fn projects_root() -> PathBuf {
    claude_dir().join("projects")
}

// ── index io ────────────────────────────────────────────────────────────

pub fn load() -> Index {
    // A schema change re-reads the corpus once. Cheaper than migrating, and the
    // alternative is a total that silently mixes two shapes.
    match fs::read(index_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Index>(&b).ok())
    {
        Some(idx) if idx.version == VERSION => idx,
        _ => Index::default(),
    }
}

pub fn save(idx: &Index) {
    let p = index_path();
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("tmp");
    if serde_json::to_vec(idx)
        .ok()
        .map(|b| fs::write(&tmp, b).is_ok())
        .unwrap_or(false)
    {
        // atomic: a killed agent leaves the old index
        let _ = fs::rename(&tmp, &p);
    }
}

// ── accumulation ────────────────────────────────────────────────────────

fn bump(bucket: &mut IndexMap<String, Tok>, model: &str, t: &Tok) {
    bucket.entry(model.to_string()).or_default().add(t);
}

/// Whole minutes since the epoch, UTC, from an ISO timestamp.
///
/// Minutes rather than seconds because a block boundary is never worth more
/// precision, and a minute key costs a fifth of the index a second key would.
/// The prefix cache is the same trick the Python uses: consecutive transcript
/// lines almost always share one.
fn epoch_minute(ts: &str, cache: &mut HashMap<String, i64>) -> Option<i64> {
    if ts.len() < 16 {
        return None;
    }
    let key = &ts[..16];
    if let Some(hit) = cache.get(key) {
        return Some(*hit);
    }
    let dt = parse_iso(ts)?;
    let m = dt.timestamp().div_euclid(60);
    if cache.len() > 20000 {
        cache.clear();
    }
    cache.insert(key.to_string(), m);
    Some(m)
}

/// Local calendar day for an ISO timestamp.
///
/// Local, not UTC: the rest of the board bins by local day, and a chart where
/// one panel rolls over at midnight and another at 5pm is a bug report.
fn local_day(ts: &str, cache: &mut HashMap<String, String>) -> Option<String> {
    if ts.len() < 16 {
        return None;
    }
    let key = &ts[..16];
    if let Some(hit) = cache.get(key) {
        return Some(hit.clone());
    }
    let dt = parse_iso(ts)?;
    let day = dt.with_timezone(&chrono::Local).date_naive().to_string();
    if cache.len() > 20000 {
        cache.clear();
    }
    cache.insert(key.to_string(), day.clone());
    Some(day)
}

pub fn parse_iso(ts: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let s = ts.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
        return Some(dt.with_timezone(&chrono::Utc));
    }
    // Naive timestamps are read as UTC, as `datetime.fromisoformat` + the
    // tzinfo fallback in the Python does.
    chrono::NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|n| chrono::DateTime::from_naive_utc_and_offset(n, chrono::Utc))
}

struct Caches {
    minute: HashMap<String, i64>,
    day: HashMap<String, String>,
}

/// One transcript record into the index. Assistant turns carry the usage.
fn absorb(idx: &mut Index, rec: &serde_json::Value, c: &mut Caches) {
    let kind = rec.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let sid = match rec.get("sessionId").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s,
        _ => return,
    };

    if kind == "ai-title" {
        if let Some(t) = rec.get("aiTitle").and_then(|v| v.as_str()) {
            if let Some(s) = idx.sessions.get_mut(sid) {
                s.title = Some(clip(t, 120));
            }
        }
        return;
    }
    if kind != "assistant" {
        return;
    }

    let msg = match rec.get("message") {
        Some(m) if m.is_object() => m,
        _ => return,
    };
    let u = match msg.get("usage") {
        Some(u) if u.is_object() && !u.as_object().unwrap().is_empty() => u,
        _ => return,
    };

    let s = idx
        .sessions
        .entry(sid.to_string())
        .or_insert_with(|| Session {
            id: sid.to_string(),
            ..Default::default()
        });

    if s.project.is_none() {
        if let Some(v) = rec.get("cwd").and_then(|v| v.as_str()) {
            s.project = Some(v.to_string());
        }
    }
    if s.branch.is_none() {
        if let Some(v) = rec.get("gitBranch").and_then(|v| v.as_str()) {
            s.branch = Some(v.to_string());
        }
    }
    if s.title.is_none() {
        if let Some(v) = rec.get("slug").and_then(|v| v.as_str()) {
            s.title = Some(clip(v, 120));
        }
    }
    if s.entry.is_none() {
        if let Some(v) = rec.get("entrypoint").and_then(|v| v.as_str()) {
            s.entry = Some(v.to_string());
        }
    }

    let ts = rec.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    if !ts.is_empty() {
        if s.first.as_deref().map_or(true, |f| ts < f) {
            s.first = Some(ts.to_string());
        }
        if s.last.as_deref().map_or(true, |l| ts > l) {
            s.last = Some(ts.to_string());
        }
    }

    let model = msg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    // `<synthetic>` is the CLI's marker for a message it wrote itself — a
    // cancellation notice, a replayed error. No request was made and no tokens
    // were billed, so counting it would put a model on the board nobody ran.
    if model.starts_with('<') {
        return;
    }

    let n = |v: Option<&serde_json::Value>| -> i64 { v.and_then(|x| x.as_i64()).unwrap_or(0) };
    let cc = u.get("cache_creation");
    let cw1 = n(cc.and_then(|c| c.get("ephemeral_1h_input_tokens")));
    let mut cw5 = n(cc.and_then(|c| c.get("ephemeral_5m_input_tokens")));
    if cw1 == 0 && cw5 == 0 {
        // Older transcripts report one total. Assume the cheaper TTL rather
        // than the dearer one — an estimate should not flatter itself.
        cw5 = n(u.get("cache_creation_input_tokens"));
    }
    let tin = n(u.get("input_tokens"));
    let tout = n(u.get("output_tokens"));
    let tcr = n(u.get("cache_read_input_tokens"));
    let tok = Tok {
        tin,
        out: tout,
        cr: tcr,
        cw5,
        cw1,
    };

    s.req += 1;
    bump(&mut s.models, &model, &tok);
    if rec
        .get("isSidechain")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        bump(&mut s.sub, &model, &tok);
    }
    let context = tin + tcr + cw5 + cw1;
    if context > s.max_ctx {
        s.max_ctx = context;
    }
    if context > BIG_CONTEXT {
        bump(&mut s.ctx, &model, &tok);
    }
    if let Some(list) = msg.get("content").and_then(|v| v.as_array()) {
        for b in list {
            if b.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                s.tools += 1;
            }
        }
    }

    if let Some(day) = local_day(ts, &mut c.day) {
        bump(idx.days.entry(day).or_default(), &model, &tok);
    }
    if let Some(minute) = epoch_minute(ts, &mut c.minute) {
        let k = minute.to_string();
        *idx.minutes.entry(k.clone()).or_insert(0) += 1;
        if tout != 0 {
            *idx.out_minutes.entry(k).or_insert(0) += tout;
        }
    }
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ── the scan ────────────────────────────────────────────────────────────

fn walk_jsonl(root: &Path, out: &mut Vec<(String, u64, SystemTime)>) {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            walk_jsonl(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push((
                p.to_string_lossy().into_owned(),
                md.len(),
                md.modified().unwrap_or(UNIX_EPOCH),
            ));
        }
    }
}

/// Read what is new (up to the byte budget), update the index, return it.
pub fn scan() -> (Index, Scan) {
    let started = std::time::Instant::now();
    let mut idx = load();
    let budget = budget();

    let mut files: Vec<(String, u64, SystemTime)> = Vec::new();
    walk_jsonl(&projects_root(), &mut files);
    // Newest first: a fresh session should reach the board on the first cycle,
    // not after a year of transcripts has been chewed through.
    files.sort_by_key(|f| std::cmp::Reverse(f.2));

    let mut caches = Caches {
        minute: HashMap::new(),
        day: HashMap::new(),
    };
    let (mut total, mut read, mut done_bytes) = (0u64, 0u64, 0u64);
    let mut touched = false;

    for (path, size, _m) in &files {
        let size = *size;
        // A file that shrank was rotated or rewritten; the offsets no longer
        // mean anything, so read it again from the top.
        let mut off = idx
            .files
            .get(path)
            .map(|f| if f.off <= size { f.off } else { 0 })
            .unwrap_or(0);
        total += size;

        if off >= size || budget.saturating_sub(read) == 0 {
            done_bytes += off.min(size);
            continue;
        }

        // Read the window in bounded slices rather than in one allocation.
        // The budget is 512 MB by default and a single transcript can pass
        // 200 MB; sizing the buffer to either of those makes an agent that
        // watches your machine cost more than the thing it is watching. Peak
        // memory here is CHUNK plus one line, whatever the corpus looks like.
        let allowance = (size - off).min(budget - read);
        let started_at = off;
        let mut left = allowance;
        let mut carry: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; CHUNK.min(allowance as usize).max(1)];

        let opened = fs::File::open(path).and_then(|mut fh| {
            fh.seek(SeekFrom::Start(off))?;
            Ok(fh)
        });
        let mut fh = match opened {
            Ok(f) => f,
            Err(_) => {
                done_bytes += off;
                continue;
            }
        };

        let mut failed = false;
        while left > 0 {
            let want = (CHUNK as u64).min(left) as usize;
            if buf.len() < want {
                buf.resize(want, 0);
            }
            let n = match fh.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => {
                    failed = true;
                    break;
                }
            };
            left -= n as u64;
            read += n as u64;
            carry.extend_from_slice(&buf[..n]);

            if let Some(end) = carry.iter().rposition(|b| *b == b'\n') {
                for raw in carry[..end].split(|b| *b == b'\n') {
                    if raw.is_empty() {
                        continue;
                    }
                    // Substring first: parsing every user turn would chew
                    // through megabytes of tool output to learn nothing.
                    if !contains(raw, b"\"assistant\"") && !contains(raw, b"\"ai-title\"") {
                        continue;
                    }
                    if let Ok(rec) = serde_json::from_slice::<serde_json::Value>(raw) {
                        if rec.is_object() {
                            absorb(&mut idx, &rec, &mut caches);
                        }
                    }
                }
                off += end as u64 + 1;
                carry.drain(..=end);
            } else if carry.len() as u64 > MAX_LINE {
                // A single record longer than any sane line. Stop rather than
                // grow without bound; the offset stays where the last complete
                // line ended, which is what the next cycle resumes from.
                break;
            }
        }

        if failed && off == started_at {
            done_bytes += off;
            continue;
        }
        if off == started_at {
            // Nothing complete was read — leave the offset alone, as the
            // Python does when its window holds no newline.
            done_bytes += off;
            continue;
        }
        idx.files.insert(path.clone(), FileState { off, size });
        done_bytes += off;
        touched = true;
    }

    // Forget the file, keep its totals: a deleted transcript is still usage
    // that happened.
    let gone: Vec<String> = idx
        .files
        .keys()
        .filter(|p| !Path::new(p).exists())
        .cloned()
        .collect();
    if !gone.is_empty() {
        for p in gone {
            idx.files.shift_remove(&p);
        }
        touched = true;
    }

    trim(&mut idx);
    if touched {
        save(&idx);
    }

    let scan = Scan {
        bytes_total: total,
        bytes_done: done_bytes.min(total),
        complete: done_bytes >= total,
        files: files.len(),
        read_this_cycle: read,
        seconds: crate::pricing::round(started.elapsed().as_secs_f64(), 2),
    };
    (idx, scan)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn trim(idx: &mut Index) {
    let now_min = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 60)
        .unwrap_or(0);
    let cutoff = now_min - KEEP_MINUTE_DAYS * 24 * 60;
    for bucket in [&mut idx.minutes, &mut idx.out_minutes] {
        let old: Vec<String> = bucket
            .keys()
            .filter(|m| m.parse::<i64>().map(|v| v < cutoff).unwrap_or(false))
            .cloned()
            .collect();
        for m in old {
            bucket.shift_remove(&m);
        }
    }

    if idx.days.len() > KEEP_DAYS {
        let mut keys: Vec<String> = idx.days.keys().cloned().collect();
        keys.sort();
        for d in &keys[..keys.len() - KEEP_DAYS] {
            idx.days.shift_remove(d);
        }
    }
    if idx.sessions.len() > KEEP_SESSIONS {
        let mut order: Vec<(String, String)> = idx
            .sessions
            .values()
            .map(|s| (s.id.clone(), s.last.clone().unwrap_or_default()))
            .collect();
        order.sort_by(|a, b| a.1.cmp(&b.1));
        let drop = idx.sessions.len() - KEEP_SESSIONS;
        for (id, _) in &order[..drop] {
            idx.sessions.shift_remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absorbed(lines: &[&str]) -> Index {
        let mut idx = Index::default();
        let mut c = Caches {
            minute: HashMap::new(),
            day: HashMap::new(),
        };
        for l in lines {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            absorb(&mut idx, &v, &mut c);
        }
        idx
    }

    #[test]
    fn a_synthetic_model_is_not_a_model() {
        let idx = absorbed(&[
            r#"{"type":"assistant","sessionId":"s","timestamp":"2026-08-01T10:00:00Z",
            "message":{"model":"<synthetic>","usage":{"output_tokens":10}}}"#,
        ]);
        // The session exists (it was opened before the model was read) but no
        // model bucket was created, which is the property that matters.
        assert!(idx.sessions["s"].models.is_empty());
    }

    #[test]
    fn one_cache_total_is_assumed_to_be_the_cheaper_ttl() {
        let idx = absorbed(&[
            r#"{"type":"assistant","sessionId":"s","timestamp":"2026-08-01T10:00:00Z",
            "message":{"model":"claude-opus-5","usage":{"cache_creation_input_tokens":500}}}"#,
        ]);
        let t = &idx.sessions["s"].models["claude-opus-5"];
        assert_eq!((t.cw5, t.cw1), (500, 0));
    }

    #[test]
    fn a_big_context_request_lands_in_its_own_bucket() {
        let idx = absorbed(&[format!(
            r#"{{"type":"assistant","sessionId":"s","timestamp":"2026-08-01T10:00:00Z",
            "message":{{"model":"claude-opus-5","usage":{{"input_tokens":{}}}}}}}"#,
            BIG_CONTEXT + 1
        )
        .as_str()]);
        assert_eq!(idx.sessions["s"].ctx["claude-opus-5"].tin, BIG_CONTEXT + 1);
        assert_eq!(idx.sessions["s"].max_ctx, BIG_CONTEXT + 1);
    }

    #[test]
    fn a_sidechain_request_is_counted_twice_on_purpose() {
        let idx = absorbed(&[r#"{"type":"assistant","sessionId":"s","isSidechain":true,
            "timestamp":"2026-08-01T10:00:00Z",
            "message":{"model":"claude-opus-5","usage":{"output_tokens":7}}}"#]);
        assert_eq!(idx.sessions["s"].models["claude-opus-5"].out, 7);
        assert_eq!(idx.sessions["s"].sub["claude-opus-5"].out, 7);
    }
}
