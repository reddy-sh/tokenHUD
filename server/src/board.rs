//! What the board reads, built once for everyone who is reading it.

use crate::store::Store;
use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 32 bytes of OS randomness, base64url, unpadded - the shape Python's
/// `secrets.token_urlsafe(32)` produces. Used for the board key, enrollment
/// tokens, and per-machine keys alike, so every secret in the system has the
/// same strength and the same look.
pub fn new_secret() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut buf = [0u8; 32];
    if unsafe { libc::getentropy(buf.as_mut_ptr() as *mut libc::c_void, buf.len()) } != 0 {
        eprintln!("could not read randomness from the OS - refusing to invent a secret");
        std::process::exit(1);
    }
    let mut out = String::new();
    for chunk in buf.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let take = chunk.len() + 1; // 3 bytes -> 4 chars, 2 -> 3, 1 -> 2
        for i in 0..take {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3F) as usize] as char);
        }
    }
    out
}

/// Secrets are stored and looked up as hashes, never as themselves.
pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The human half of the handshake: six characters derived from the token, so
/// the terminal that ran `enroll` and the board deciding whether to approve it
/// can be checked against each other by eye. The alphabet drops 0/O/1/I/L/U -
/// a code someone reads aloud must not have two spellings.
pub fn pairing_code(token: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";
    let mut h = Sha256::new();
    h.update(b"tokenhud-pair:");
    h.update(token.as_bytes());
    let d = h.finalize();
    let pick = |i: usize| ALPHABET[d[i] as usize % ALPHABET.len()] as char;
    format!(
        "{}{}{}-{}{}{}",
        pick(0),
        pick(1),
        pick(2),
        pick(3),
        pick(4),
        pick(5)
    )
}

/// One counter and a notification, which is all a fan-out needs here.
///
/// Watchers wait for the counter to move; an ingest moves it. No queues, so a
/// slow watcher cannot make the server buffer without bound - it simply wakes
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
    /// True when the server is bound to 127.0.0.1 - only then is it safe
    /// for the portal to fetch the admin key without a header.
    pub loopback_only: bool,
    /// The address this server is reachable at from outside, when that is not
    /// the address a request arrived on - a reverse proxy, a tunnel, a
    /// hostname. Empty means "answer with whatever Host the caller used",
    /// which is right until something sits in front.
    ///
    /// It exists for one reason: a share link has to name an API a stranger's
    /// browser can reach, and only the operator knows what that is.
    pub public_url: String,
    cache: Mutex<Cache>,
    /// One-time stream tokens: EventSource cannot set a header, and putting
    /// the board key itself in a URL would write the fleet's admin credential
    /// into every access log. So the browser trades the key (in a header) for
    /// a 60-second single-use token, and only THAT rides the query string -
    /// worthless the moment it is seen.
    stream_tokens: Mutex<std::collections::HashMap<String, std::time::Instant>>,
    /// One-time install tokens: same idea as stream tokens, but for the
    /// install-script endpoint. The portal trades the admin key for a token
    /// that rides the curl URL, so the admin key itself never appears in a
    /// command the user copies. 5-minute window, single use.
    install_tokens: Mutex<std::collections::HashMap<String, std::time::Instant>>,
}

/// The overview is cached in two shapes: the public one, and the one for a
/// caller holding the board key. They differ by exactly one field - the
/// machines list, which carries pending pairing codes and fleet inventory
/// that open-by-default reads have no business serving.
#[derive(Default)]
struct Cache {
    key: Option<(u64, i64)>,
    json_public: Vec<u8>,
    json_admin: Vec<u8>,
    gzip_public: Vec<u8>,
    gzip_admin: Vec<u8>,
}

impl App {
    pub fn new(
        store: Store,
        key: String,
        protect_reads: bool,
        max_streams: u64,
        loopback_only: bool,
        public_url: String,
    ) -> Arc<App> {
        Arc::new(App {
            store,
            bus: Broadcast::new(),
            key,
            protect_reads,
            max_streams,
            loopback_only,
            public_url: public_url.trim_end_matches('/').to_string(),
            cache: Mutex::new(Cache::default()),
            stream_tokens: Mutex::new(Default::default()),
            install_tokens: Mutex::new(Default::default()),
        })
    }

    /// Trade the board key (already verified by the caller) for a one-time
    /// stream token.
    pub fn mint_stream_token(&self) -> String {
        let token = new_secret();
        let mut t = self.stream_tokens.lock().unwrap();
        // A tab that fetched a token and never opened the stream must not
        // accumulate: sweep anything stale while we are here.
        t.retain(|_, at| at.elapsed().as_secs() < 60);
        t.insert(token.clone(), std::time::Instant::now());
        token
    }

    /// Redeem a stream token. True at most once per token, and only inside
    /// its 60-second window.
    pub fn take_stream_token(&self, token: &str) -> bool {
        let mut t = self.stream_tokens.lock().unwrap();
        match t.remove(token) {
            Some(at) => at.elapsed().as_secs() < 60,
            None => false,
        }
    }

    /// Trade the board key for a one-time install token (5-minute window).
    pub fn mint_install_token(&self) -> String {
        let token = new_secret();
        let mut t = self.install_tokens.lock().unwrap();
        t.retain(|_, at| at.elapsed().as_secs() < 300);
        t.insert(token.clone(), std::time::Instant::now());
        token
    }

    /// Redeem an install token. True at most once, within 5 minutes.
    pub fn take_install_token(&self, token: &str) -> bool {
        let mut t = self.install_tokens.lock().unwrap();
        match t.remove(token) {
            Some(at) => at.elapsed().as_secs() < 300,
            None => false,
        }
    }

    /// Everything the board reads, in one object.
    ///
    /// Built in one place because two callers need it identical: the poll and
    /// the event stream. A stream that sent a different shape from the poll it
    /// replaces would be a bug that only appeared on reconnect.
    fn overview(&self, admin: bool) -> Value {
        let hosts = self.hosts_with_status();
        let mut out = json!({
            "generatedAt": crate::store::iso(Utc::now()),
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
        });
        // Enrollment state rides the same payload the board already watches,
        // so a machine claiming a link appears on screen the moment it happens
        // - but only for a reader holding the board key. Pending pairing codes
        // and the fleet inventory are not for the open-reads default.
        if admin {
            out["machines"] = json!(self.store.machines());
        }
        out
    }

    /// Every reporting machine with its liveness worked out.
    ///
    /// Public because the shared board needs the same verdict the private one
    /// shows: two places calling a machine "up" by different rules would be a
    /// difference nobody could explain.
    pub fn hosts_with_status(&self) -> Vec<Value> {
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
        hosts
    }

    /// One reader's work, done once, for every reader.
    ///
    /// `overview()` takes every host out of SQLite under a single lock, parses a
    /// 61 KB reading for each and serialises the lot back out. Measured at
    /// 9.4 ms in the Python server - and the event stream did it once per reader
    /// per reading, so a hundred watchers meant a hundred times the work to
    /// produce a hundred identical copies. Fan-out cost grew with the audience,
    /// which is the wrong shape for a thing whose entire purpose is being
    /// watched.
    ///
    /// The key is the ingest counter and the current second: the counter because
    /// a new reading must never wait, the second because two fields -
    /// `generatedAt` and each host's age - are answers about now rather than
    /// about the data, and a second is finer than anyone reads a status board.
    pub fn board_json(&self, admin: bool) -> Vec<u8> {
        let key = (self.bus.current(), Utc::now().timestamp());
        let mut c = self.cache.lock().unwrap();
        if c.key != Some(key) {
            c.json_public = serde_json::to_vec(&self.overview(false)).unwrap_or_default();
            c.json_admin = serde_json::to_vec(&self.overview(true)).unwrap_or_default();
            c.gzip_public.clear();
            c.gzip_admin.clear();
            c.key = Some(key);
        }
        if admin {
            c.json_admin.clone()
        } else {
            c.json_public.clone()
        }
    }

    pub fn board_gzip(&self, admin: bool) -> Vec<u8> {
        let raw = self.board_json(admin);
        let mut c = self.cache.lock().unwrap();
        let slot = if admin {
            &mut c.gzip_admin
        } else {
            &mut c.gzip_public
        };
        if slot.is_empty() {
            let mut e = GzEncoder::new(Vec::new(), Compression::new(6));
            let _ = e.write_all(&raw);
            *slot = e.finish().unwrap_or_default();
        }
        slot.clone()
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
