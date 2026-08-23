//! What the board reads, built once for everyone who is reading it.

use crate::store::Store;
use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// One counter and a notification, which is all a fan-out needs here.
///
/// Watchers wait for the counter to move; an ingest moves it. No queues, so a
/// slow watcher cannot make the server buffer without bound — it simply wakes
/// late and sends the current state, which for a status board is the correct
/// thing to send anyway. Missing an intermediate reading costs nothing when
/// every event carries the whole truth.
pub struct Broadcast {
    seq: AtomicU64,
    tx: tokio::sync::watch::Sender<u64>,
    pub readers: AtomicU64,
}

impl Broadcast {
    pub fn new() -> Broadcast {
        let (tx, _rx) = tokio::sync::watch::channel(0u64);
        Broadcast {
            seq: AtomicU64::new(0),
            tx,
            readers: AtomicU64::new(0),
        }
    }
    pub fn publish(&self) {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(n);
    }
    pub fn current(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.tx.subscribe()
    }
}

impl Default for Broadcast {
    fn default() -> Self {
        Self::new()
    }
}

pub struct App {
    pub store: Store,
    pub bus: Broadcast,
    pub key: String,
    pub protect_reads: bool,
    pub max_streams: u64,
    pub web: std::path::PathBuf,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    key: Option<(u64, i64)>,
    json: Vec<u8>,
    gzip: Vec<u8>,
}

impl App {
    pub fn new(
        store: Store,
        key: String,
        protect_reads: bool,
        max_streams: u64,
        web: std::path::PathBuf,
    ) -> Arc<App> {
        Arc::new(App {
            store,
            bus: Broadcast::new(),
            key,
            protect_reads,
            max_streams,
            web,
            cache: Mutex::new(Cache::default()),
        })
    }

    /// Everything the board reads, in one object.
    ///
    /// Built in one place because two callers need it identical: the poll and
    /// the event stream. A stream that sent a different shape from the poll it
    /// replaces would be a bug that only appeared on reconnect.
    fn overview(&self) -> Value {
        let now = Utc::now();
        let mut hosts = self.store.hosts();
        for h in &mut hosts {
            let age = h["last_seen"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| (now - t.with_timezone(&Utc)).num_milliseconds() as f64 / 1000.0);
            h["ageSeconds"] = match age {
                Some(a) => json!(a),
                None => Value::Null,
            };
            // "up" is about the AGENT reporting, not the machine being switched
            // on. Three missed intervals is the usual line.
            h["status"] = json!(match age {
                None => "unknown",
                Some(a) if a < 120.0 => "up",
                Some(a) if a < 900.0 => "stale",
                _ => "down",
            });
        }
        json!({
            "generatedAt": crate::store::iso(now),
            "hosts": hosts,
            "latest": self.store.all_latest(),
            // Carried here rather than left to its own endpoint: "what finished
            // while I was away" is the first thing someone returning to the
            // board wants, and a second round trip to learn it would be worse.
            "endings": self.store.endings(40, 24, None),
            "store": self.store.counts(),
            "streams": {
                "open": self.bus.readers.load(Ordering::SeqCst),
                "max": self.max_streams,
            },
        })
    }

    /// One reader's work, done once, for every reader.
    ///
    /// `overview()` takes every host out of SQLite under a single lock, parses a
    /// 61 KB reading for each and serialises the lot back out. Measured at
    /// 9.4 ms in the Python server — and the event stream did it once per reader
    /// per reading, so a hundred watchers meant a hundred times the work to
    /// produce a hundred identical copies. Fan-out cost grew with the audience,
    /// which is the wrong shape for a thing whose entire purpose is being
    /// watched.
    ///
    /// The key is the ingest counter and the current second: the counter because
    /// a new reading must never wait, the second because two fields —
    /// `generatedAt` and each host's age — are answers about now rather than
    /// about the data, and a second is finer than anyone reads a status board.
    pub fn board_json(&self) -> Vec<u8> {
        let key = (self.bus.current(), Utc::now().timestamp());
        let mut c = self.cache.lock().unwrap();
        if c.key != Some(key) {
            c.json = serde_json::to_vec(&self.overview()).unwrap_or_default();
            c.gzip.clear();
            c.key = Some(key);
        }
        c.json.clone()
    }

    pub fn board_gzip(&self) -> Vec<u8> {
        let raw = self.board_json();
        let mut c = self.cache.lock().unwrap();
        if c.gzip.is_empty() {
            let mut e = GzEncoder::new(Vec::new(), Compression::new(6));
            let _ = e.write_all(&raw);
            c.gzip = e.finish().unwrap_or_default();
        }
        c.gzip.clone()
    }

    /// `compare_digest`, not `==`, so a wrong key cannot be found one byte at a
    /// time.
    pub fn authorized(&self, sent: Option<&str>) -> bool {
        if self.key.is_empty() {
            return false;
        }
        let a = self.key.as_bytes();
        let b = sent.unwrap_or("").as_bytes();
        let mut diff = (a.len() ^ b.len()) as u8;
        for i in 0..a.len().max(b.len()) {
            diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
        }
        diff == 0
    }
}
