//! The store, against a real SQLite file in a temp directory.
//!
//! These four came from a Python suite that no longer exists, where they ran
//! against the Python store this one replaced. They moved as they were: same assertions, same thresholds,
//! nothing mocked. A test that passes against a fake would tell you nothing
//! about whether the board works.

use serde_json::{json, Value};
use tokenhud_server::store::{Store, KEYFRAME_EVERY};

struct Tmp(std::path::PathBuf);
impl Tmp {
    fn new(name: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("tokenhud-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    fn db(&self) -> std::path::PathBuf {
        self.0.join("t.db")
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A snapshot. `pad` inflates it past the compression floor.
fn snap(host: &str, at: &str, pids: &[i64], pad: usize) -> Value {
    json!({
        "host": host, "agentVersion": "test", "collectedAt": at,
        "metrics": {
            "processes": pids.iter().map(|p| json!({
                "pid": p, "kind": "test", "elapsed": "01:00:00", "cmd": "x"
            })).collect::<Vec<_>>(),
            "filler": vec!["compressible ".repeat(8); pad],
        }
    })
}

fn iso(minutes: f64) -> String {
    let t =
        chrono::Utc::now() - chrono::Duration::milliseconds(((10.0 - minutes) * 60_000.0) as i64);
    tokenhud_server::store::iso(t)
}

#[test]
fn endings_are_derived_and_a_replay_adds_none() {
    let tmp = Tmp::new("endings");
    let st = Store::open(&tmp.db(), 30).unwrap();

    st.ingest(&snap("h", &iso(0.0), &[1, 2, 3], 0)).unwrap();
    st.ingest(&snap("h", &iso(1.0), &[1, 3], 0)).unwrap(); // 2 ended
    st.ingest(&snap("h", &iso(2.0), &[1], 0)).unwrap(); // 3 ended
    st.ingest(&snap("h", &iso(0.5), &[1, 2, 3], 0)).unwrap(); // a spooled replay

    let ends = st.endings(50, 24, None);
    let mut pids: Vec<i64> = ends.iter().map(|e| e["pid"].as_i64().unwrap()).collect();
    pids.sort_unstable();
    assert_eq!(pids, vec![2, 3], "expected pids 2 and 3 to have ended");
    for e in &ends {
        assert!(
            e["last_seen"].as_str() < e["noticed_at"].as_str(),
            "an ending must be bracketed by two readings"
        );
        assert_eq!(e["ran_seconds"], 3600, "01:00:00 should parse to 3600s");
    }
}

#[test]
fn history_round_trips_through_the_chain() {
    // Not "close enough": the board prices sessions off these numbers. This
    // walks past the keyframe interval on purpose, so the chain is replayed
    // rather than read, and it varies the shape — a list that grows, a key that
    // appears, a key that goes away — because those are the three cases where a
    // structural difference can be wrong.
    let tmp = Tmp::new("history");
    let st = Store::open(&tmp.db(), 30).unwrap();
    let n = KEYFRAME_EVERY * 2 + 5;

    let mut sent = Vec::new();
    for k in 0..n {
        let pids: Vec<i64> = (1..2 + k % 7).collect();
        let mut s = snap("h", &iso(k as f64 * 0.01), &pids, 2);
        s["metrics"]["tick"] = json!(k); // a value that moves
        if k % 3 == 0 {
            s["metrics"]["sometimes"] = json!({ "k": k }); // a key that comes and goes
        }
        s["sessions"] = json!((0..k % 4)
            .map(|i| json!({"id": format!("s{i}"), "cost": i as f64 + k as f64 * 0.01}))
            .collect::<Vec<_>>());
        sent.push(s.clone());
        st.ingest(&s).unwrap();
    }

    let got = st.history("h", n);
    assert_eq!(
        got.len() as i64,
        n,
        "asked for {n} readings, got {}",
        got.len()
    );
    for (want, have) in sent.iter().zip(got.iter()) {
        let mut have = have.clone();
        have.as_object_mut().unwrap().shift_remove("at");
        if &have != want {
            // Show the first field that differs rather than two 4 KB blobs.
            let w = want.as_object().unwrap();
            let h = have.as_object().unwrap();
            for k in w.keys().chain(h.keys()) {
                if w.get(k) != h.get(k) {
                    panic!(
                        "reading {} differs at {k:?}\n  want {}\n  got  {}",
                        want["metrics"]["tick"],
                        serde_json::to_string(&w.get(k)).unwrap_or_default(),
                        serde_json::to_string(&h.get(k)).unwrap_or_default()
                    );
                }
            }
            panic!("reading {} came back changed", want["metrics"]["tick"]);
        }
    }
    let kf = st.counts()["keyframes"].as_i64().unwrap();
    assert!(
        kf <= n / KEYFRAME_EVERY + 2,
        "{kf} keyframes in {n} readings — the chain is not forming"
    );
}

#[test]
fn a_difference_costs_less_than_a_reading() {
    // The differences have to actually save something, or they are only risk.
    let tmp = Tmp::new("size");
    let st = Store::open(&tmp.db(), 30).unwrap();
    // A reading with a lot of unchanging bulk, which is what a real one is.
    let base = snap("h", &iso(0.0), &[1, 2, 3], 400);
    let whole = serde_json::to_vec(&base).unwrap().len();
    st.ingest(&base).unwrap();
    for k in 1..=40 {
        let mut s = base.clone();
        s["collectedAt"] = json!(iso(k as f64 * 0.01));
        s["metrics"]["processes"][0]["elapsed"] = json!(format!("0{}:{:02}:00", k / 60, k % 60));
        st.ingest(&s).unwrap();
    }

    // The rows themselves, not the file: SQLite grows a page at a time and
    // would hide the answer behind its own allocator.
    let db = rusqlite::Connection::open(tmp.db()).unwrap();
    let sizes: Vec<i64> = db
        .prepare("SELECT LENGTH(payload) FROM snapshots WHERE base_id IS NOT NULL ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(
        sizes.len(),
        40,
        "expected 40 differences, got {}",
        sizes.len()
    );
    let each = sizes.iter().sum::<i64>() as f64 / sizes.len() as f64;
    assert!(
        each < whole as f64 / 10.0,
        "each further reading cost {each:.0} B against {whole} B whole — \
         the difference is not paying for itself"
    );
}

#[test]
fn pruning_never_orphans_a_chain() {
    // Retention may not delete a keyframe that surviving rows still need.
    let tmp = Tmp::new("prune");
    let st = Store::open(&tmp.db(), 1).unwrap();
    let old = chrono::Utc::now() - chrono::Duration::days(3);
    let now = chrono::Utc::now() - chrono::Duration::minutes(5);

    for k in 0..10 {
        let at = tokenhud_server::store::iso(old + chrono::Duration::minutes(k));
        st.ingest(&snap("h", &at, &[1], 1)).unwrap(); // past the cutoff
    }
    for k in 0..5 {
        let at = tokenhud_server::store::iso(now + chrono::Duration::seconds(k));
        let mut s = snap("h", &at, &[1], 1);
        s["metrics"]["tick"] = json!(k);
        st.ingest(&s).unwrap(); // inside the window
    }
    st.prune().unwrap();

    let got = st.history("h", 50);
    let ticks: Vec<i64> = got
        .iter()
        .filter_map(|r| r["metrics"]["tick"].as_i64())
        .collect();
    assert_eq!(
        ticks,
        vec![0, 1, 2, 3, 4],
        "a surviving reading came back wrong — its keyframe was pruned out from under it"
    );
}

#[test]
fn an_older_reading_does_not_rewind_current_state() {
    // `hosts` means "what is true now". A replayed or back-dated reading is
    // normal — the agent spools when the server is away — but it must not move
    // the present backwards. This failed before the upsert grew its guard.
    let tmp = Tmp::new("rewind");
    let st = Store::open(&tmp.db(), 30).unwrap();
    let now = chrono::Utc::now();
    let iso_at = |d: chrono::Duration| tokenhud_server::store::iso(now + d);

    let mut fresh = snap("h", &iso_at(chrono::Duration::zero()), &[1], 1);
    fresh["metrics"]["tick"] = json!("present");
    st.ingest(&fresh).unwrap();

    let mut ancient = snap("h", "2001-01-01T00:00:00+00:00", &[1], 1);
    ancient["metrics"]["tick"] = json!("past");
    st.ingest(&ancient).unwrap();

    let hosts = st.hosts();
    assert_eq!(hosts.len(), 1);
    assert!(
        hosts[0]["last_seen"]
            .as_str()
            .unwrap()
            .starts_with(&now.format("%Y").to_string()),
        "a 2001 reading rewound the host row to {}",
        hosts[0]["last_seen"]
    );
}

#[test]
fn a_reading_from_the_future_cannot_outlive_retention() {
    // `collectedAt` is caller-supplied and retention compares against it, so an
    // absurd future stamp used to produce a row that could never be pruned.
    let tmp = Tmp::new("future");
    let st = Store::open(&tmp.db(), 1).unwrap();
    st.ingest(&snap("h", "9999-01-01T00:00:00+00:00", &[1], 1))
        .unwrap();
    let stored = st.hosts()[0]["last_seen"].as_str().unwrap().to_string();
    assert!(
        !stored.starts_with("9999"),
        "a year-9999 timestamp was stored verbatim: {stored}"
    );
}
