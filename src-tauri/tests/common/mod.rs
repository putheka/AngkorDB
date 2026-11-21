//! Helpers shared by the integration tests that need the dev database (`npm run db:up`).
//!
//! When the database isn't reachable the tests print a note and pass, so `cargo test` works
//! offline. Set `ANGKORDB_REQUIRE_DB=1` (CI) to make an unreachable DB a failure.

// Each test file uses a different subset of these helpers.
#![allow(dead_code)]

use angkordb_lib::db::session::Session;
use angkordb_lib::models::connection::{ColorTag, ConnectionConfig, SafeMode, SslMode};

/// Dev-only credentials from `compose.yaml`.
pub const DEV_PASSWORD: &str = "angkor";

pub fn dev_config() -> ConnectionConfig {
    ConnectionConfig {
        id: "integration-test".into(),
        name: "Dev".into(),
        host: std::env::var("ANGKORDB_TEST_HOST").unwrap_or_else(|_| "localhost".into()),
        port: std::env::var("ANGKORDB_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(54329),
        user: "angkor".into(),
        database: "angkordb_dev".into(),
        ssl_mode: SslMode::Prefer,
        color: ColorTag::None,
        group: None,
        safe_mode: SafeMode::Off,
        statement_timeout_ms: None,
        has_password: false,
    }
}

pub fn db_required() -> bool {
    std::env::var("ANGKORDB_REQUIRE_DB").is_ok_and(|v| v == "1")
}

/// Open a session, or `None` (test skipped) when the dev DB isn't running.
pub async fn open_or_skip() -> Option<Session> {
    match Session::open(dev_config(), Some(DEV_PASSWORD)).await {
        Ok(session) => Some(session),
        Err(e) if e.is_connection_error() && !db_required() => {
            eprintln!("SKIPPED: dev database not reachable ({e}). Run `npm run db:up`.");
            None
        }
        Err(e) => panic!("could not open session: {e:?}"),
    }
}
