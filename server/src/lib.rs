//! The TokenHUD server as a library.
//!
//! `main.rs` is configuration and a listener; everything it serves lives here.
//! Split out so `tests/` can stand the real router up in-process on an
//! ephemeral port. The checks in there test the real thing rather than a mock,
//! which is the property that made them worth carrying over from the Python
//! suite they came from.

pub mod board;
pub mod http;
pub mod share;
pub mod store;

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

pub fn router(app: Arc<board::App>) -> Router {
    // The dashboard site may live on a different origin (tokenhud.com) while
    // the API runs on localhost or app.tokenhud.com — so CORS exists, but only
    // on the routes a BROWSER legitimately calls: the reads, the stream and
    // its token, and the board-key-gated fleet actions. The agent-facing
    // routes (ingest, enroll, the enrollment poll) never see a browser, and a
    // cross-origin page has no business reaching them; scoping the layer is
    // what makes that true rather than merely intended.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            "x-tokenhud-key".parse().unwrap(),
        ])
        .expose_headers([axum::http::header::CONTENT_TYPE]);

    let browser = Router::new()
        .route("/healthz", get(http::healthz))
        .route("/api/v1/enroll/new", post(http::enroll_new))
        .route("/api/v1/machines/decide", post(http::machines_decide))
        .route("/api/v1/stream-token", post(http::stream_token))
        .route("/api/v1/stream", get(http::stream))
        .route("/api/v1/overview", get(http::overview))
        .route("/api/v1/endings", get(http::endings))
        .route("/api/v1/history", get(http::history))
        .route("/api/v1/portal-key", get(http::portal_key))
        .route("/api/v1/version", get(http::version))
        .route("/api/v1/machines/rename", post(http::rename_machine))
        .route("/api/v1/machines/remove", post(http::remove_machine))
        .route("/api/v1/install-token", post(http::install_token))
        .route("/api/v1/install-script", get(http::install_script))
        .route("/api/v1/upgrade-script", get(http::upgrade_script))
        .route("/api/v1/share", get(http::share_list).post(http::share_new))
        .route("/api/v1/share/revoke", post(http::share_revoke))
        // The one open read in the whole API. It carries the whitelist in
        // share.rs and nothing else, and the slug in the query string is the
        // only thing standing in front of it — which is what a link somebody
        // chose to publish is.
        .route("/api/v1/public/board", get(http::public_board))
        .layer(cors);

    Router::new()
        .route("/api/v1/ingest", post(http::ingest))
        .route("/api/v1/enroll", post(http::enroll))
        .route("/api/v1/enroll/await", get(http::enroll_await))
        .merge(browser)
        // No dashboard ships in here any more — the board lives in the
        // tokenhud.com portal, and this server is the self-host API. So
        // anything unrouted, `/` included, is a 404 in JSON: every caller is
        // a program, and a program should not have to parse a document to
        // learn it got the path wrong.
        .fallback(http::not_found)
        .with_state(app)
        .layer(axum::extract::DefaultBodyLimit::max(http::MAX_BODY))
}
