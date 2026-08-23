//! The TokenHUD server as a library.
//!
//! `main.rs` is configuration and a listener; everything it serves lives here.
//! Split out so `tests/` can stand the real router up in-process on an
//! ephemeral port. The checks in there test the real thing rather than a mock,
//! which is the property that made them worth carrying over from the Python
//! suite they came from.

pub mod board;
pub mod http;
pub mod store;

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

pub fn router(app: Arc<board::App>) -> Router {
    Router::new()
        .route("/healthz", get(http::healthz))
        .route("/api/v1/ingest", post(http::ingest))
        .route("/api/v1/stream", get(http::stream))
        .route("/api/v1/overview", get(http::overview))
        .route("/api/v1/endings", get(http::endings))
        .route("/api/v1/history", get(http::history))
        // Anything else under /api/ is a 404 in JSON, not an HTML page: a
        // client that asked for JSON should not have to parse a document to
        // learn it got the path wrong.
        .route("/api/{*rest}", get(http::not_found).post(http::not_found))
        .fallback(http::static_file)
        .with_state(app)
        .layer(axum::extract::DefaultBodyLimit::max(http::MAX_BODY))
}
