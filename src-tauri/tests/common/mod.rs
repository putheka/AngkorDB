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
        ssh: None,
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

// ---- Scratch databases ----------------------------------------------------------------------

use angkordb_lib::db::script;

pub const PREFIX: &str = "angkordb_ddl_";

/// A database that exists for one test and is dropped at the end.
pub struct Scratch {
    pub name: String,
}

impl Scratch {
    pub async fn create(admin: &Session, label: &str) -> Self {
        let pid = std::process::id();
        let name = format!("{PREFIX}{pid}_{label}");
        let client = admin.meta().await.unwrap();
        // Leftovers of an earlier run that was killed (not those of the tests running now).
        let old = client
            .query(
                "SELECT datname::text FROM pg_database
                  WHERE datname LIKE $1 AND datname NOT LIKE $2",
                &[&format!("{PREFIX}%"), &format!("{PREFIX}{pid}\\_%")],
            )
            .await
            .unwrap();
        for row in old {
            let stale: String = row.get(0);
            let _ = client
                .batch_execute(&format!("DROP DATABASE IF EXISTS \"{stale}\" WITH (FORCE)"))
                .await;
        }
        client
            .batch_execute(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
            .await
            .unwrap();
        client
            .batch_execute(&format!("CREATE DATABASE \"{name}\" TEMPLATE template0"))
            .await
            .unwrap();
        Self { name }
    }

    pub async fn open(&self) -> Session {
        let mut config = dev_config();
        config.database = self.name.clone();
        Session::open(config, Some(DEV_PASSWORD)).await.unwrap()
    }

    pub async fn drop_it(self, admin: &Session) {
        let client = admin.meta().await.unwrap();
        client
            .batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ))
            .await
            .unwrap();
    }
}

/// Run every statement of `sql`; the ones that fail with a code in `tolerate` are skipped.
/// Returns the first other failure as a message.
pub async fn run_all(session: &Session, sql: &str, tolerate: &[&str]) -> Result<(), String> {
    let client = session.meta().await.unwrap();
    for statement in script::split(sql) {
        let text = &sql[statement.start..statement.end];
        if let Err(e) = client.batch_execute(text).await {
            let code = e.code().map(|c| c.code().to_owned()).unwrap_or_default();
            if !tolerate.contains(&code.as_str()) {
                return Err(format!("{e}\n  in: {text}"));
            }
        }
    }
    Ok(())
}
