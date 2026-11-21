use std::time::Duration;

use tokio_postgres::config::{Config, SslMode as PgSslMode};

use crate::models::connection::{ConnectionConfig, SafeMode, SslMode};

/// Shown in `pg_stat_activity.application_name`.
pub const APPLICATION_NAME: &str = "AngkorDB";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const KEEPALIVE_IDLE: Duration = Duration::from_secs(60);

/// Build a driver config from saved settings. The password comes from the Keychain, never disk.
pub fn pg_config(conn: &ConnectionConfig, password: Option<&str>) -> Config {
    pg_config_via(conn, password, None)
}

/// [`pg_config`], dialling a local port that an SSH tunnel listens on (ANG-43). The host name is
/// kept, so TLS and `verify-full` still check the database's own name; `hostaddr` is where to
/// actually connect.
pub fn pg_config_via(
    conn: &ConnectionConfig,
    password: Option<&str>,
    tunnel_port: Option<u16>,
) -> Config {
    let mut cfg = Config::new();
    cfg.host(&conn.host)
        .port(tunnel_port.unwrap_or(conn.port))
        .user(&conn.user)
        .dbname(&conn.database)
        .application_name(APPLICATION_NAME)
        .connect_timeout(CONNECT_TIMEOUT)
        .keepalives(true)
        .keepalives_idle(KEEPALIVE_IDLE)
        .ssl_mode(pg_ssl_mode(conn.ssl_mode));
    if tunnel_port.is_some() {
        cfg.hostaddr(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    }
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
/// Read-only mode makes the server refuse writes (SQLSTATE 25006), not just the UI; the statement
/// timeout makes it cancel anything that runs too long (SQLSTATE 57014).
pub fn init_sql(conn: &ConnectionConfig) -> Option<String> {
    let mut statements = Vec::new();
    if conn.safe_mode == SafeMode::ReadOnly {
        statements.push("SET default_transaction_read_only = on".to_owned());
    }
    if let Some(ms) = conn.statement_timeout_ms.filter(|ms| *ms > 0) {
        // A number, never text from outside: nothing to escape.
        statements.push(format!("SET statement_timeout = {ms}"));
    }
    (!statements.is_empty()).then(|| statements.join("; "))
}
