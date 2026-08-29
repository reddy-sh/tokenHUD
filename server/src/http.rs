//! The three jobs, and nothing else:
//!
//! ```text
//! POST /api/v1/ingest      an agent's snapshot            (key required)
//! GET  /api/v1/stream      server-sent events: pushed the instant a
//!                          reading lands, so the board stops guessing
//! GET  /api/v1/overview    latest reading for every host  (key optional)
//! GET  /api/v1/history     one host's recent snapshots
//! GET  /api/v1/endings     agents that stopped recently
//! GET  /api/v1/public/board a shared leaderboard             (slug is the key)
//! ```
//!
//! No dashboard is served from here any more — the board lives in the
//! tokenhud.com portal, and this server is the API a self-hosted board or
//! tooling talks to. Everything unrouted is a JSON 404.

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
    // Two credentials open this door: the board key (the original, shared
    // model) or a per-machine key minted at enrollment. A machine key also
    // binds identity — the row it writes is the machine's, whatever hostname
    // the payload claims.
    let machine: Option<(String, String)> = if app.authorized(key) {
        None
    } else {
        match key.and_then(|k| app.store.machine_by_key_hash(&crate::board::sha256_hex(k))) {
            Some(m) => Some(m),
            None => {
                return json_response(
                    StatusCode::UNAUTHORIZED,
                    json!({"error": "bad or missing X-TokenHUD-Key"}),
                    &headers,
                )
            }
        }
    };
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

    let mut snap: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": format!("bad json: {e}")}),
                &headers,
            )
        }
    };
    // A snapshot is an object or it is nothing — and index-assignment below
    // would panic on a bare array or string rather than refuse it.
    if !snap.is_object() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "snapshot must be a JSON object"}),
            &headers,
        );
    }
    // Machine-key auth overrides the body's claim to a name. The label was
    // fixed at enrollment (and disambiguated there against machines AND legacy
    // hosts), so a hostname collision or an imaginative payload cannot write
    // over another machine's row.
    if let Some((install_id, label)) = &machine {
        snap["host"] = json!(label);
        snap["installId"] = json!(install_id);
    }
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

// ── enrollment ──────────────────────────────────────────────────────────
//
// The shape is FleetDM's, with TokenHUD's consent model riding along: the
// board mints a one-shot link; a machine claims it and appears on the live
// board as *pending*, carrying its pairing code, its detected AI assistants,
// and its consent-manifest digest; a person approves it; the machine's next
// poll delivers a key that is that machine's alone. The board key never
// touches the new laptop, and revoking one machine never rotates the fleet.

/// Mint an enrollment link. Always requires the board key — this is the one
/// write that creates credentials, so it is never open, whatever
/// TOKENHUD_PROTECT_READS says.
pub async fn enroll_new(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return unauthorized(&headers);
    }
    let token = crate::board::new_secret();
    let code = crate::board::pairing_code(&token);
    let hash = crate::board::sha256_hex(&token);
    let a = app.clone();
    let minted = tokio::task::spawn_blocking(move || a.store.enroll_mint(&hash, &code)).await;
    match minted {
        Ok(Ok(expires)) => json_response(
            StatusCode::OK,
            json!({
                "token": token,
                "code": crate::board::pairing_code(&token),
                "expiresAt": expires,
                "ttlSeconds": crate::store::Store::ENROLL_TTL_SECS,
            }),
            &headers,
        ),
        Ok(Err(e)) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

/// A new machine claims a link. Open — the token in the body is the
/// credential, and a wrong token learns nothing but "unknown link".
pub async fn enroll(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if body.is_empty() || body.len() > 64 * 1024 {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error": "body missing or too large"}),
            &headers,
        );
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": format!("bad json: {e}")}),
                &headers,
            )
        }
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let (token, secret, install_id, host) = (s("token"), s("secret"), s("installId"), s("host"));
    let ok_id = (8..=64).contains(&install_id.len())
        && install_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !(20..=100).contains(&token.len())
        || !(16..=100).contains(&secret.len())
        || !ok_id
        || host.is_empty()
        || host.len() > 120
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "enrollment needs a token, a secret, an installId, and a host"}),
            &headers,
        );
    }
    let assistants = v.get("assistants").cloned().unwrap_or(Value::Null);
    let (platform, agent_version, digest) = (s("platform"), s("agentVersion"), s("manifestDigest"));
    let a = app.clone();
    let hash = crate::board::sha256_hex(&token);
    let secret_hash = crate::board::sha256_hex(&secret);
    let claimed = tokio::task::spawn_blocking(move || {
        a.store.enroll_claim(
            &hash,
            &secret_hash,
            &install_id,
            &host,
            &platform,
            &agent_version,
            &digest,
            &assistants,
        )
    })
    .await;
    match claimed {
        Ok(Ok(Ok(code))) => {
            // The pending card should appear on the board *now* — watching the
            // machine arrive is half the point of approving it live.
            app.bus.publish();
            json_response(
                StatusCode::OK,
                json!({"status": "pending", "code": code}),
                &headers,
            )
        }
        Ok(Ok(Err(why))) => json_response(StatusCode::GONE, json!({"error": why}), &headers),
        Ok(Err(e)) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

/// The claiming machine polls here until someone decides. Approval delivers
/// the machine's key exactly once; everything after that is "already
/// delivered", which a machine that lost the response treats as "re-enroll".
/// The poll needs the claim's secret as well as the token, so a link that
/// leaked after the claim identifies the enrollment but collects nothing.
pub async fn enroll_await(
    State(app): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match q.get("token") {
        Some(t) if (20..=100).contains(&t.len()) => t.clone(),
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "token is required"}),
                &headers,
            )
        }
    };
    let secret = match q.get("secret") {
        Some(s) if (16..=100).contains(&s.len()) => s.clone(),
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "secret is required"}),
                &headers,
            )
        }
    };
    let candidate = crate::board::new_secret();
    let candidate_hash = crate::board::sha256_hex(&candidate);
    let hash = crate::board::sha256_hex(&token);
    let secret_hash = crate::board::sha256_hex(&secret);
    let a = app.clone();
    let state = tokio::task::spawn_blocking(move || {
        a.store
            .enroll_state(&hash, &secret_hash, &candidate, &candidate_hash)
    })
    .await;
    match state {
        Ok(Some(v)) => json_response(StatusCode::OK, v, &headers),
        Ok(None) => json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "unknown or expired enrollment"}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

/// Approve, deny, or revoke one machine — the board key decides.
pub async fn machines_decide(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return unauthorized(&headers);
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": format!("bad json: {e}")}),
                &headers,
            )
        }
    };
    let install_id = v
        .get("installId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let action = v
        .get("action")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if install_id.is_empty() || !matches!(action.as_str(), "approve" | "deny" | "revoke") {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "installId and an action of approve, deny, or revoke are required"}),
            &headers,
        );
    }
    let a = app.clone();
    let act = action.clone();
    let decided =
        tokio::task::spawn_blocking(move || a.store.machine_decide(&install_id, &act)).await;
    match decided {
        Ok(Ok(true)) => {
            app.bus.publish();
            json_response(
                StatusCode::OK,
                json!({"ok": true, "action": action}),
                &headers,
            )
        }
        Ok(Ok(false)) => json_response(
            StatusCode::CONFLICT,
            json!({"error": "no machine in a state that allows that"}),
            &headers,
        ),
        Ok(Err(e)) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
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

// ── portal key (loopback only) ──────────────────────────────────────
//
// When the server is bound to 127.0.0.1, the only things that can reach
// it are programs on the same machine. A browser dashboard running on
// localhost is one of them, and it needs the admin key to mint enrollment
// tokens. Returning the key here saves the human from copying it out of
// .env — the portal fetches it once and stores it in localStorage.
//
// If TOKENHUD_BIND is anything other than 127.0.0.1, this endpoint
// refuses: a network-reachable server must not give its key away.

pub async fn portal_key(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    if !app.loopback_only {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({"error": "portal-key is only available when the server is bound to 127.0.0.1"}),
            &headers,
        );
    }
    if app.key.is_empty() {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "TOKENHUD_KEY is not set"}),
            &headers,
        );
    }
    json_response(StatusCode::OK, json!({"key": app.key}), &headers)
}

// ── machine rename ──────────────────────────────────────────────────

pub async fn rename_machine(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return unauthorized(&headers);
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "bad JSON"}),
                &headers,
            )
        }
    };
    let machine_id = v.get("machineId").and_then(|v| v.as_str()).unwrap_or("");
    let label = v.get("label").and_then(|v| v.as_str()).unwrap_or("");
    if machine_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "machineId is required"}),
            &headers,
        );
    }
    match app.store.rename_host(machine_id, label) {
        Ok(true) => {
            app.bus.publish();
            json_response(StatusCode::OK, json!({"ok": true}), &headers)
        }
        Ok(false) => json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "machine not found"}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

// ── remove machine ─────────────────────────────────────────────────

pub async fn remove_machine(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return unauthorized(&headers);
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "bad JSON"}),
                &headers,
            )
        }
    };
    let host = v.get("host").and_then(|v| v.as_str()).unwrap_or("");
    if host.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "host is required"}),
            &headers,
        );
    }
    match app.store.remove_host(host) {
        Ok(true) => {
            app.bus.publish();
            json_response(StatusCode::OK, json!({"ok": true}), &headers)
        }
        Ok(false) => json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "machine not found"}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

// ── server version ──────────────────────────────────────────────────

pub async fn version(headers: HeaderMap) -> impl IntoResponse {
    json_response(
        StatusCode::OK,
        json!({ "version": env!("CARGO_PKG_VERSION") }),
        &headers,
    )
}

// ── install token ───────────────────────────────────────────────────
//
// Mint a one-time token that authorises a single GET to /install-script.
// The portal trades the admin key (in a header) for this token, then
// puts the token in the URL the user copies — so the admin key never
// appears in a command or a shell history.

pub async fn install_token(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return unauthorized(&headers);
    }
    let token = app.mint_install_token();
    json_response(StatusCode::OK, json!({"token": token}), &headers)
}

// ── install script ──────────────────────────────────────────────────
//
// Returns a self-contained shell script that installs the agent on a
// target machine, configures it to point at this server, and starts it.
// Authenticated by either the admin key header OR a one-time install
// token in the query string — so the curl URL the user copies never
// contains the admin key.

pub async fn install_script(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(qs): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    let token_ok = qs.get("t").is_some_and(|t| app.take_install_token(t));
    if !token_ok && !app.authorized(key) {
        return unauthorized(&headers);
    }
    let server_url = qs.get("server").cloned().unwrap_or_default();
    if server_url.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "?server= query parameter is required"}),
            &headers,
        );
    }
    let script = format!(
        r#"#!/bin/sh
set -e
REPO="reddy-sh/tokenhud"
PREFIX="${{INSTALL_DIR:-$HOME/.local/bin}}"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)  TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  Linux-aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  Linux-x86_64)  TARGET=x86_64-unknown-linux-gnu ;;
  *) echo "  No build for $OS-$ARCH yet."; exit 1 ;;
esac

export TOKENHUD_KEY="{key}"
export TOKENHUD_SERVER="{server_url}"

# macOS: un-quarantine so the binary runs without Gatekeeper.
unsign() {{ xattr -d com.apple.quarantine "$1" 2>/dev/null || true; }}

# Safe --version: old agents don't have the flag and start a loop instead.
# Run in background, kill after 2s if still alive.
ver_of() {{
  "$1" --version >"$TMP/_ver" 2>/dev/null &
  local p=$!
  ( sleep 2; kill $p 2>/dev/null ) &
  local g=$!
  wait $p 2>/dev/null || true
  kill $g 2>/dev/null || true
  wait $g 2>/dev/null || true
  head -1 "$TMP/_ver" 2>/dev/null || true
  rm -f "$TMP/_ver"
}}

# ── check for existing agent ─────────────────────────────────────────
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
EXISTING=""
if [ -f "$PREFIX/tokenhud-agent" ]; then
  EXISTING=$(ver_of "$PREFIX/tokenhud-agent")
fi
RUNNING_PID=$(pgrep -xf ".*tokenhud-agent" 2>/dev/null | head -1 || true)

echo ""
echo "  TokenHUD"
echo "  ----------------------------"

if [ -n "$EXISTING" ]; then
  if [ -n "$RUNNING_PID" ]; then
    echo "  Installed: $EXISTING (pid $RUNNING_PID)"
  else
    echo "  Installed: $EXISTING"
  fi
  echo "  Checking for updates..."
fi

# ── download ─────────────────────────────────────────────────────────
mkdir -p "$PREFIX"
BASE="https://github.com/$REPO/releases/latest/download"
if command -v sha256sum >/dev/null 2>&1; then hash_of() {{ sha256sum "$1" | cut -d' ' -f1; }}
else hash_of() {{ shasum -a 256 "$1" | cut -d' ' -f1; }}
fi

echo "  Downloading..."
for b in tokenhud-agent tokenhud-server; do
  curl -fsSL "$BASE/$b-$TARGET"        -o "$TMP/$b"
  curl -fsSL "$BASE/$b-$TARGET.sha256" -o "$TMP/$b.sha256"
  WANT="$(cut -d' ' -f1 < "$TMP/$b.sha256")"
  [ -n "$WANT" ] && [ "$WANT" = "$(hash_of "$TMP/$b")" ] \
    || {{ echo "  ✗ checksum mismatch on $b"; exit 1; }}
done
chmod +x "$TMP/tokenhud-agent" "$TMP/tokenhud-server"
[ "$(uname -s)" = Darwin ] && {{ unsign "$TMP/tokenhud-agent"; unsign "$TMP/tokenhud-server"; }}

NEW_VER=$(ver_of "$TMP/tokenhud-agent")
[ -z "$NEW_VER" ] && NEW_VER="(latest)"

# ── already up to date? ──────────────────────────────────────────────
if [ -n "$EXISTING" ] && [ "$EXISTING" = "$NEW_VER" ]; then
  echo ""
  echo "  Already on latest: $NEW_VER"
  if [ -z "$RUNNING_PID" ]; then
    tokenhud-agent --accept >/dev/null 2>&1 || true
    nohup tokenhud-agent >/dev/null 2>&1 &
    echo "  Started agent (pid $!)"
  else
    echo "  Agent running (pid $RUNNING_PID)"
  fi
  echo ""
  exit 0
fi

# ── install / upgrade ────────────────────────────────────────────────
if [ -n "$RUNNING_PID" ]; then
  kill "$RUNNING_PID" 2>/dev/null && sleep 1 || true
fi
if [ -n "$EXISTING" ]; then
  for b in tokenhud-agent tokenhud-server; do [ -f "$PREFIX/$b" ] && cp "$PREFIX/$b" "$PREFIX/$b.bak"; done
fi
mv "$TMP/tokenhud-agent" "$TMP/tokenhud-server" "$PREFIX/"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "export PATH=\"$PREFIX:\$PATH\"" >> "$HOME/.profile"
     export PATH="$PREFIX:$PATH" ;;
esac

tokenhud-agent --accept >/dev/null 2>&1 || true
nohup tokenhud-agent >/dev/null 2>&1 &

echo ""
if [ -n "$EXISTING" ]; then
  rm -f "$PREFIX/tokenhud-agent.bak" "$PREFIX/tokenhud-server.bak"
  echo "  Upgraded: $EXISTING -> $NEW_VER"
else
  echo "  Installed $NEW_VER"
fi
echo "  Reporting to {server_url} (pid $!)"
echo ""
"#,
        key = app.key,
        server_url = server_url,
    );
    send(
        StatusCode::OK,
        script.into_bytes(),
        "text/plain",
        &headers,
        None,
    )
}

// ── upgrade script ──────────────────────────────────────────────────
//
// Returns a shell script that upgrades the agent (and server binary) on
// a machine that already has them. Downloads the latest release, backs
// up the current binaries, verifies the new ones, and falls back to the
// backup if anything goes wrong. Uses the same install-token auth as
// install-script.

pub async fn upgrade_script(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(qs): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    let token_ok = qs.get("t").is_some_and(|t| app.take_install_token(t));
    if !token_ok && !app.authorized(key) {
        return unauthorized(&headers);
    }
    let server_url = qs.get("server").cloned().unwrap_or_default();
    if server_url.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "?server= query parameter is required"}),
            &headers,
        );
    }
    let script = format!(
        r#"#!/bin/sh
set -e
REPO="reddy-sh/tokenhud"
PREFIX="${{INSTALL_DIR:-$HOME/.local/bin}}"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64)  TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  Linux-aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  Linux-x86_64)  TARGET=x86_64-unknown-linux-gnu ;;
  *) echo "  No build for $OS-$ARCH yet."; exit 1 ;;
esac
if [ ! -f "$PREFIX/tokenhud-agent" ]; then
  echo "  Agent not found at $PREFIX — run the install command instead."; exit 1
fi

export TOKENHUD_KEY="{key}"
export TOKENHUD_SERVER="{server_url}"

unsign() {{ xattr -d com.apple.quarantine "$1" 2>/dev/null || true; }}
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ver_of() {{
  "$1" --version >"$TMP/_ver" 2>/dev/null &
  local p=$!
  ( sleep 2; kill $p 2>/dev/null ) &
  local g=$!
  wait $p 2>/dev/null || true
  kill $g 2>/dev/null || true
  wait $g 2>/dev/null || true
  head -1 "$TMP/_ver" 2>/dev/null || true
  rm -f "$TMP/_ver"
}}

OLD_VER=$(ver_of "$PREFIX/tokenhud-agent")
[ -z "$OLD_VER" ] && OLD_VER="(unknown)"

echo ""
echo "  TokenHUD  Upgrade"
echo "  ----------------------------"
echo "  Current: $OLD_VER"
echo "  Downloading..."

BASE="https://github.com/$REPO/releases/latest/download"
if command -v sha256sum >/dev/null 2>&1; then hash_of() {{ sha256sum "$1" | cut -d' ' -f1; }}
else hash_of() {{ shasum -a 256 "$1" | cut -d' ' -f1; }}
fi
for b in tokenhud-agent tokenhud-server; do
  curl -fsSL "$BASE/$b-$TARGET"        -o "$TMP/$b"
  curl -fsSL "$BASE/$b-$TARGET.sha256" -o "$TMP/$b.sha256"
  WANT="$(cut -d' ' -f1 < "$TMP/$b.sha256")"
  [ -n "$WANT" ] && [ "$WANT" = "$(hash_of "$TMP/$b")" ] \
    || {{ echo "  ✗ checksum mismatch on $b"; exit 1; }}
done
chmod +x "$TMP/tokenhud-agent" "$TMP/tokenhud-server"
[ "$(uname -s)" = Darwin ] && {{ unsign "$TMP/tokenhud-agent"; unsign "$TMP/tokenhud-server"; }}

NEW_VER=$(ver_of "$TMP/tokenhud-agent")
[ -z "$NEW_VER" ] && NEW_VER="(latest)"
if [ "$OLD_VER" = "$NEW_VER" ]; then
  RUNNING_PID=$(pgrep -xf ".*tokenhud-agent" 2>/dev/null | head -1 || true)
  echo ""
  echo "  Already on latest: $NEW_VER"
  if [ -z "$RUNNING_PID" ]; then
    tokenhud-agent --accept >/dev/null 2>&1 || true
    nohup tokenhud-agent >/dev/null 2>&1 &
    echo "  Started agent (pid $!)"
  else
    echo "  Agent running (pid $RUNNING_PID)"
  fi
  echo ""
  exit 0
fi

# Back up, stop, swap
for b in tokenhud-agent tokenhud-server; do [ -f "$PREFIX/$b" ] && cp "$PREFIX/$b" "$PREFIX/$b.bak"; done
AGENT_PID=$(pgrep -xf ".*tokenhud-agent" 2>/dev/null | head -1 || true)
[ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null && sleep 1 || true
mv "$TMP/tokenhud-agent" "$TMP/tokenhud-server" "$PREFIX/"

# Verify installed binary; roll back on failure
INST_VER=$(ver_of "$PREFIX/tokenhud-agent")
if [ -z "$INST_VER" ]; then
  for b in tokenhud-agent tokenhud-server; do [ -f "$PREFIX/$b.bak" ] && mv "$PREFIX/$b.bak" "$PREFIX/$b"; done
  if [ -n "$AGENT_PID" ]; then
    nohup "$PREFIX/tokenhud-agent" >/dev/null 2>&1 &
  fi
  echo "  Rolled back to $OLD_VER."; exit 1
fi
rm -f "$PREFIX/tokenhud-agent.bak" "$PREFIX/tokenhud-server.bak"

tokenhud-agent --accept >/dev/null 2>&1 || true
nohup tokenhud-agent >/dev/null 2>&1 &

echo ""
echo "  Upgraded: $OLD_VER -> $NEW_VER"
echo "  Reporting to {server_url} (pid $!)"
echo ""
"#,
        key = app.key,
        server_url = server_url,
    );
    send(
        StatusCode::OK,
        script.into_bytes(),
        "text/plain",
        &headers,
        None,
    )
}

pub async fn overview(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    if !reads_allowed(&app, &headers) {
        return unauthorized(&headers);
    }
    // The machines list (pairing codes, fleet inventory) travels only to a
    // caller who proved they hold the board key — reads being open by default
    // does not open THAT.
    let admin = app.authorized(headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok()));
    let raw = app.board_json(admin);
    let gz = if raw.len() > 1400 && wants_gzip(&headers) {
        Some(app.board_gzip(admin))
    } else {
        None
    };
    send(StatusCode::OK, raw, "application/json", &headers, gz)
}

/// Trade the board key (sent as a header, where it belongs) for a one-time
/// 60-second stream token — the only credential allowed to ride the /stream
/// query string, because EventSource cannot set a header and the board key
/// in a URL would sit in every access log.
pub async fn stream_token(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    let key = headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok());
    if !app.authorized(key) {
        return unauthorized(&headers);
    }
    json_response(
        StatusCode::OK,
        json!({"token": app.mint_stream_token(), "ttlSeconds": 60}),
        &headers,
    )
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
    let host = q.get("host").filter(|h| !h.is_empty()).cloned();
    // SQLite work belongs on a blocking thread, same as ingest already does —
    // a slow disk must not stall the async runtime under it.
    let a = app.clone();
    let rows =
        tokio::task::spawn_blocking(move || a.store.endings(limit, hours, host.as_deref())).await;
    match rows {
        Ok(rows) => json_response(StatusCode::OK, json!({"endings": rows}), &headers),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
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
            // Clamped from BOTH sides: SQLite reads a negative LIMIT as
            // "unlimited", which turned ?limit=-1 into a request for a host's
            // entire reconstructed history in one response.
            Ok(n) => n.clamp(1, 1000),
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "limit must be an integer"}),
                    &headers,
                )
            }
        },
    };
    let a = app.clone();
    let h = host.clone();
    let snaps = tokio::task::spawn_blocking(move || a.store.history(&h, limit)).await;
    match snaps {
        Ok(snaps) => json_response(
            StatusCode::OK,
            json!({"host": host, "snapshots": snaps}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

// ── sharing ─────────────────────────────────────────────────────────────
//
// A share turns the leaderboard into a URL anyone can open. Three of these
// routes need the board key, because minting and revoking a public link is
// exactly the kind of thing a fleet's admin credential is for. The fourth
// needs nothing at all — that is the point of it — and answers with the
// whitelist in `share.rs` and nothing else.

/// What a share link should say the API lives at.
///
/// TOKENHUD_PUBLIC_URL when the operator set one, because a server behind a
/// proxy or a tunnel cannot work that out for itself. Otherwise the Host the
/// request actually arrived on, which is right in every plain case and is at
/// least an address that reached us once.
fn public_base(app: &App, headers: &HeaderMap) -> String {
    if !app.public_url.is_empty() {
        return app.public_url.clone();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1:8787");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(
            if host.starts_with("127.0.0.1") || host.starts_with("localhost") {
                "http"
            } else {
                "https"
            },
        );
    format!("{scheme}://{host}")
}

/// Every share this fleet has minted, and the address to build links against.
pub async fn share_list(State(app): State<Arc<App>>, headers: HeaderMap) -> impl IntoResponse {
    if !app.authorized(headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok())) {
        return unauthorized(&headers);
    }
    let base = public_base(&app, &headers);
    let a = app.clone();
    match tokio::task::spawn_blocking(move || a.store.share_list()).await {
        Ok(shares) => json_response(
            StatusCode::OK,
            json!({
                "shares": shares,
                "apiUrl": base,
                // The board is asked rather than left to guess: a link to a
                // loopback address works for the person who made it and for
                // nobody else, and the dialog says so out loud.
                "reachable": !app.loopback_only || !app.public_url.is_empty(),
            }),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

/// Mint a share, or change one that exists.
///
/// `{"title": "...", "identities": "alias" | "host"}` creates; adding
/// `"slug"` edits that share instead. Editing is deliberately not a way to
/// resurrect a revoked link — a revoked share is finished.
pub async fn share_new(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if !app.authorized(headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok())) {
        return unauthorized(&headers);
    }
    let v: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": format!("bad json: {e}")}),
                    &headers,
                )
            }
        }
    };

    let identities = v
        .get("identities")
        .and_then(|x| x.as_str())
        .unwrap_or(crate::share::ALIAS)
        .to_string();
    if !crate::share::identities_ok(&identities) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "identities must be alias or host"}),
            &headers,
        );
    }
    // A title is printed on a public page, so it is trimmed and bounded here
    // rather than trusted to be sane.
    let title: String = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect();
    let title = if title.is_empty() {
        "TokenHUD leaderboard".to_string()
    } else {
        title
    };
    let slug = v.get("slug").and_then(|x| x.as_str()).map(str::to_string);

    let a = app.clone();
    let (t, i) = (title.clone(), identities.clone());
    let done = tokio::task::spawn_blocking(move || match slug {
        Some(slug) => a
            .store
            .share_update(&slug, Some(&t), Some(&i))
            .map(|ok| (slug, ok)),
        None => {
            let slug = crate::share::new_slug();
            a.store.share_create(&slug, &t, &i).map(|_| (slug, true))
        }
    })
    .await;

    match done {
        Ok(Ok((slug, true))) => {
            let base = public_base(&app, &headers);
            json_response(
                StatusCode::OK,
                json!({
                    "slug": slug,
                    "title": title,
                    "identities": identities,
                    "apiUrl": base,
                    "reachable": !app.loopback_only || !app.public_url.is_empty(),
                }),
                &headers,
            )
        }
        Ok(Ok((_, false))) => json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "no live share with that slug"}),
            &headers,
        ),
        Ok(Err(e)) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

/// Take a share private again. The link stops answering immediately: the
/// board behind it is computed per request, so there is no rendered copy left
/// anywhere to keep serving.
pub async fn share_revoke(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if !app.authorized(headers.get("x-tokenhud-key").and_then(|v| v.to_str().ok())) {
        return unauthorized(&headers);
    }
    let v: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let slug = match v.get("slug").and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "slug is required"}),
                &headers,
            )
        }
    };
    let a = app.clone();
    match tokio::task::spawn_blocking(move || a.store.share_revoke(&slug)).await {
        Ok(Ok(ok)) => json_response(StatusCode::OK, json!({"ok": ok}), &headers),
        Ok(Err(e)) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

/// The shared board. No key, by design — the slug is the credential.
///
/// TOKENHUD_PROTECT_READS does not gate this one: closing the private API to
/// anonymous readers is a separate decision from publishing a link on purpose,
/// and a share that stopped working when reads were protected would be a
/// surprising way to find that out.
pub async fn public_board(
    State(app): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let slug = q.get("s").cloned().unwrap_or_default();
    // An unknown slug and a revoked one answer identically. A public endpoint
    // that distinguished them would be a way to test slugs for existence.
    let missing = || {
        json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "no such shared board"}),
            &headers,
        )
    };
    if slug.is_empty() || slug.len() > 64 {
        return missing();
    }

    let a = app.clone();
    let built = tokio::task::spawn_blocking(move || {
        let share = a.store.share_get(&slug)?;
        a.store.share_viewed(&slug);
        let hosts = a.hosts_with_status();
        Some(crate::share::board(&a.store, &share, &hosts))
    })
    .await;

    match built {
        Ok(Some(board)) => {
            let raw = serde_json::to_vec(&board).unwrap_or_default();
            send(StatusCode::OK, raw, "application/json", &headers, None)
        }
        Ok(None) => missing(),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            &headers,
        ),
    }
}

// ── push ────────────────────────────────────────────────────────────────

/// Server-sent events: one `reading` event per ingest.
///
/// The client gets the current state immediately on connect, so a reconnect
/// after a dropped link is a resync and not a gap. That is also why no delta
/// protocol is needed for correctness: every event carries the whole truth, and
/// a reader that missed one is not behind.
pub async fn stream(
    State(app): State<Arc<App>>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    // EventSource cannot set a request header, so the browser board redeems a
    // one-time stream token (minted for it by /api/v1/stream-token, key in a
    // header) as ?st=… — never the board key itself, which must not land in
    // access logs. A redeemed token also marks this reader as one that may see
    // the machines list.
    let admin = q
        .get("st")
        .map(|t| app.take_stream_token(t))
        .unwrap_or(false);
    if !reads_allowed(&app, &headers) && !admin {
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
                frame.extend_from_slice(&app.board_json(admin));
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

// ── everything else ─────────────────────────────────────────────────────

/// The fallback for every path that is not routed. JSON, not an HTML page:
/// every client of this server is a program, and a program that got the path
/// wrong should not have to parse a document to learn it.
pub async fn not_found(headers: HeaderMap) -> impl IntoResponse {
    json_response(
        StatusCode::NOT_FOUND,
        json!({"error": "not found"}),
        &headers,
    )
}
