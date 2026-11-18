use std::time::Duration;

use tokio_postgres::config::{Config, SslMode as PgSslMode};

use crate::models::connection::{ConnectionConfig, SafeMode, SslMode};

/// Shown in `pg_stat_activity.application_name`.
pub const APPLICATION_NAME: &str = "AngkorDB";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const KEEPALIVE_IDLE: Duration = Duration::from_secs(60);

/// Build a driver config from saved settings. The password comes from the Keychain, never disk.
pub fn pg_config(conn: &ConnectionConfig, password: Option<&str>) -> Config {
    let mut cfg = Config::new();
    cfg.host(&conn.host)
        .port(conn.port)
        .user(&conn.user)
        .dbname(&conn.database)
        .application_name(APPLICATION_NAME)
        .connect_timeout(CONNECT_TIMEOUT)
        .keepalives(true)
        .keepalives_idle(KEEPALIVE_IDLE)
        .ssl_mode(pg_ssl_mode(conn.ssl_mode));
    if let Some(password) = password {
        cfg.password(password);
    }
    cfg
}

/// tokio-postgres only knows disable/prefer/require; certificate checks are done by the
/// TLS connector (`tls.rs`). Exact `verify-ca` / non-verifying `require` semantics: ANG-44.
fn pg_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => PgSslMode::Require,
    }
}

/// SQL run on every new connection of a session (pooled and per-tab alike).
/// Read-only mode makes the server refuse writes (SQLSTATE 25006), not just the UI.
pub fn init_sql(conn: &ConnectionConfig) -> Option<&'static str> {
    match conn.safe_mode {
        SafeMode::ReadOnly => Some("SET default_transaction_read_only = on"),
        SafeMode::Off | SafeMode::Confirm | SafeMode::TouchId => None,
    }
}
