//! The three jobs, and nothing else:
//!
//! ```text
//! POST /api/v1/ingest      an agent's snapshot            (key required)
//! GET  /api/v1/stream      server-sent events: pushed the instant a
//!                          reading lands, so the board stops guessing
//! GET  /api/v1/overview    latest reading for every host  (key optional)
//! GET  /api/v1/history     one host's recent snapshots
//! GET  /api/v1/endings     agents that stopped recently
//! GET  /                   the dashboard
//! ```

use crate::board::App;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// A snapshot is ~60 KB; this is a wide ceiling.
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// Long enough not to be chatter, short enough that a connection the client has
/// already abandoned is reclaimed quickly.
const HEARTBEAT: Duration = Duration::from_secs(15);

fn base_headers(h: &mut HeaderMap) {
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
}

fn wants_gzip(h: &HeaderMap) -> bool {
    h.get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("gzip"))
}

/// The overview payload is ~69 KB of JSON and compresses about 5x. Over loopback
/// that is not bandwidth, it is memcpy and parse time, and both are worth
/// cutting on a board that refreshes forever. Small responses are deliberately
/// left alone: compressing 200 bytes costs CPU and can make them bigger.
fn send(
    code: StatusCode,
    body: Vec<u8>,
    ctype: &str,
    req: &HeaderMap,
    pre_gzipped: Option<Vec<u8>>,
) -> Response {
    let compressible = ctype.starts_with("application/json") || ctype.starts_with("text/");
    let mut resp = if body.len() > 1400 && compressible && wants_gzip(req) {
        let gz = pre_gzipped.unwrap_or_else(|| {
            let mut e = GzEncoder::new(Vec::new(), Compression::new(6));
            let _ = e.write_all(&body);
            e.finish().unwrap_or_default()
        });
        let mut r = Response::new(Body::from(gz));
        r.headers_mut()
            .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        r.headers_mut()
            .insert(header::VARY, "Accept-Encoding".parse().unwrap());
        r
    } else {
        Response::new(Body::from(body))
    };
    *resp.status_mut() = code;
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, ctype.parse().unwrap());
    base_headers(resp.headers_mut());
    resp
}

fn json_response(code: StatusCode, v: Value, req: &HeaderMap) -> Response {
    send(
        code,
        serde_json::to_vec(&v).unwrap_or_default(),
        "application/json",
        req,
        None,
    )
}

// ── writes ──────────────────────────────────────────────────────────────

pub async fn ingest(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error": "bad or missing X-TokenHUD-Key"}),
            &headers,
        );
    }
    if body.is_empty() || body.len() > MAX_BODY {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error": "body missing or too large"}),
            &headers,
        );
    }

    // Agents gzip their uploads; anything older or hand-rolled with curl does
    // not. Both are accepted, so the wire format can move without a flag day
    // across a fleet nobody controls.
    let gzipped = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("gzip"));
    let raw: Vec<u8> = if gzipped {
        let mut out = Vec::new();
        // Bounded: a small body that inflates to gigabytes is a denial of
        // service, not a reading.
        match GzDecoder::new(&body[..])
            .take((MAX_BODY + 1) as u64)
            .read_to_end(&mut out)
        {
            Ok(_) if out.len() <= MAX_BODY => out,
            Ok(_) => {
                return json_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error": "body missing or too large"}),
                    &headers,
                )
            }
            Err(e) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": format!("bad json: {e}")}),
                    &headers,
                )
            }
        }
    } else {
        body.to_vec()
    };

    let snap: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": format!("bad json: {e}")}),
                &headers,
            )
        }
    };
    let host = match snap.get("host").and_then(|v| v.as_str()) {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "snapshot needs a host"}),
                &headers,
            )
        }
    };

    let a = app.clone();
    let stored = tokio::task::spawn_blocking(move || {
        // Note what is NOT here: prune(). It used to run on every POST, inside
        // the one lock that also serialises every read, doing two queries per
        // distinct host — and `host` comes from the request body, so its
        // cardinality is caller-controlled. Measured: 1.0 ms per ingest at one
        // host, 14.5 ms at five thousand. Retention is a housekeeping job with
        // a 30-day horizon; it has no business on the hot path. It runs on a
        // timer in main.rs instead.
        a.store.ingest(&snap)?;
        Ok::<_, rusqlite::Error>(())
    })
    .await;
    match stored {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": e.to_string()}),
                &headers,
            )
        }
        Err(e) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": e.to_string()}),
                &headers,
            )
        }
    }

    // Everyone watching hears about it now, not on their next timer.
    app.bus.publish();
    json_response(
        StatusCode::ACCEPTED,
        json!({"ok": true, "host": host}),
        &headers,
    )
}

// ── reads ───────────────────────────────────────────────────────────────

fn reads_allowed(app: &App, headers: &HeaderMap) -> bool {
    !app.protect_reads
        || app.authorized(headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok()))
}

fn unauthorized(headers: &HeaderMap) -> Response {
    json_response(
        StatusCode::UNAUTHORIZED,
        json!({"error": "bad or missing X-TokenHUD-Key"}),
        headers,
    )
}

pub async fn healthz(headers: HeaderMap) -> impl IntoResponse {
    send(StatusCode::OK, b"ok".to_vec(), "text/plain", &headers, None)
}

pub async fn overview(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    if !reads_allowed(&app, &headers) {
        return unauthorized(&headers);
    }
    let raw = app.board_json();
    let gz = if raw.len() > 1400 && wants_gzip(&headers) {
        Some(app.board_gzip())
    } else {
        None
    };
    send(StatusCode::OK, raw, "application/json", &headers, gz)
}

pub async fn endings(
    State(app): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !reads_allowed(&app, &headers) {
        return unauthorized(&headers);
    }
    let num = |k: &str, dflt: i64, hi: i64| -> Result<i64, ()> {
        match q.get(k) {
            None => Ok(dflt),
            Some(v) => v.parse::<i64>().map(|n| n.clamp(1, hi)).map_err(|_| ()),
        }
    };
    let (limit, hours) = match (num("limit", 100, 500), num("hours", 24, 720)) {
        (Ok(l), Ok(h)) => (l, h),
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "limit and hours must be integers"}),
                &headers,
            )
        }
    };
    let host = q.get("host").filter(|h| !h.is_empty()).map(String::as_str);
    json_response(
        StatusCode::OK,
        json!({"endings": app.store.endings(limit, hours, host)}),
        &headers,
    )
}

pub async fn history(
    State(app): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !reads_allowed(&app, &headers) {
        return unauthorized(&headers);
    }
    let host = match q.get("host").filter(|h| !h.is_empty()) {
        Some(h) => h.clone(),
        None => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "host is required"}),
                &headers,
            )
        }
    };
    let limit = match q.get("limit") {
        None => 200,
        Some(v) => match v.parse::<i64>() {
            Ok(n) => n.min(1000),
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "limit must be an integer"}),
                    &headers,
                )
            }
        },
    };
    let snaps = app.store.history(&host, limit);
    json_response(
        StatusCode::OK,
        json!({"host": host, "snapshots": snaps}),
        &headers,
    )
}

// ── push ────────────────────────────────────────────────────────────────

/// Server-sent events: one `reading` event per ingest.
///
/// The client gets the current state immediately on connect, so a reconnect
/// after a dropped link is a resync and not a gap. That is also why no delta
/// protocol is needed for correctness: every event carries the whole truth, and
/// a reader that missed one is not behind.
pub async fn stream(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !reads_allowed(&app, &headers) {
        return unauthorized(&headers);
    }
    if app.bus.readers.load(Ordering::SeqCst) >= app.max_streams {
        // Not an error the board should retry: it says so, and the client falls
        // back to polling, which needs no held connection.
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": format!("too many streams open (max {}) — poll instead", app.max_streams)}),
            &headers,
        );
    }

    // A stream that is not compressed is WORSE than the poll it replaces: each
    // reading is 69 KB where a gzipped poll is 14 KB. One deflate context across
    // the whole stream, flushed after every event, means the second reading —
    // being nearly identical to the first — costs a fraction of even that.
    let mut sink = if wants_gzip(&headers) {
        Sink::Gzip(Box::new(GzEncoder::new(Vec::new(), Compression::new(6))))
    } else {
        Sink::Plain
    };

    app.bus.readers.fetch_add(1, Ordering::SeqCst);
    let guard = ReaderGuard(app.clone());
    let mut rx = app.bus.subscribe();

    let body = async_stream::stream! {
        let _guard = guard;
        let mut send_state = true;   // the state on connect, so joining is a resync
        loop {
            if send_state {
                let mut frame = Vec::from("event: reading\ndata: ");
                frame.extend_from_slice(&app.board_json());
                frame.extend_from_slice(b"\n\n");
                match encode(&mut sink, &frame) {
                    Some(bytes) => yield Ok::<_, std::io::Error>(Bytes::from(bytes)),
                    None => return,
                }
                send_state = false;
            }
            match tokio::time::timeout(HEARTBEAT, rx.changed()).await {
                Ok(Ok(())) => {
                    rx.borrow_and_update();
                    send_state = true;
                }
                Ok(Err(_)) => return,      // the bus is gone
                Err(_) => {
                    // Nothing new, so nothing is sent. A comment line is a valid
                    // SSE no-op and is how a dead connection gets discovered:
                    // this write is what fails once the tab has gone. It must
                    // NOT fall through to the payload above, or an idle board
                    // would pull 69 KB every fifteen seconds for no reason.
                    match encode(&mut sink, b": beat\n\n") {
                        Some(bytes) => yield Ok(Bytes::from(bytes)),
                        None => return,
                    }
                }
            }
        }
    };

    let mut resp = Response::new(Body::from_stream(body));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        "text/event-stream; charset=utf-8".parse().unwrap(),
    );
    h.insert("x-accel-buffering", "no".parse().unwrap()); // in case anyone proxies this
    if gz_was_requested(&headers) {
        h.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
    }
    base_headers(h);
    resp
}

fn gz_was_requested(h: &HeaderMap) -> bool {
    wants_gzip(h)
}

/// One deflate context for the whole stream, flushed after every event.
///
/// `GzEncoder::flush` ends a block without ending the stream — Z_SYNC_FLUSH —
/// so the browser can decode this event now and the next one still benefits
/// from everything already in the window. That is what makes the second reading
/// cost a fraction of the first: they are nearly identical.
enum Sink {
    Plain,
    Gzip(Box<GzEncoder<Vec<u8>>>),
}

fn encode(sink: &mut Sink, data: &[u8]) -> Option<Vec<u8>> {
    match sink {
        Sink::Plain => Some(data.to_vec()),
        Sink::Gzip(e) => {
            e.write_all(data).ok()?;
            e.flush().ok()?;
            Some(std::mem::take(e.get_mut()))
        }
    }
}

struct ReaderGuard(Arc<App>);
impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.0.bus.readers.fetch_sub(1, Ordering::SeqCst);
    }
}

// ── static ──────────────────────────────────────────────────────────────

pub async fn static_file(
    State(app): State<Arc<App>>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    let rel = match uri.path() {
        "" | "/" => "index.html",
        p => p.trim_start_matches('/'),
    };
    let target = app.web.join(rel);
    // Resolve before comparing: `..` in a path is only harmless once it has
    // been collapsed and the result is still inside the directory being served.
    let (root, target) = match (app.web.canonicalize(), target.canonicalize()) {
        (Ok(r), Ok(t)) => (r, t),
        _ => {
            return send(
                StatusCode::NOT_FOUND,
                b"not found".to_vec(),
                "text/plain",
                &headers,
                None,
            )
        }
    };
    if !target.starts_with(&root) || !target.is_file() {
        return send(
            StatusCode::NOT_FOUND,
            b"not found".to_vec(),
            "text/plain",
            &headers,
            None,
        );
    }
    let ctype = match target.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    match std::fs::read(&target) {
        Ok(body) => send(StatusCode::OK, body, ctype, &headers, None),
        Err(_) => send(
            StatusCode::NOT_FOUND,
            b"not found".to_vec(),
            "text/plain",
            &headers,
            None,
        ),
    }
}

pub async fn not_found(headers: HeaderMap) -> impl IntoResponse {
    json_response(
        StatusCode::NOT_FOUND,
        json!({"error": "not found"}),
        &headers,
    )
}
