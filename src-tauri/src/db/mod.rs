//! PostgreSQL layer (tokio-postgres + deadpool-postgres). Design: ANG-8.
//!
//! - `config`  — saved connection settings → `tokio_postgres::Config`
//! - `tls`     — rustls connector using macOS system root certificates
//! - `session` — one open connection: metadata pool + dedicated client per query tab
//!
//! Planned: `introspect` (ANG-15), `rows` (ANG-16), `query` (ANG-20), `changes` (ANG-23).

pub mod config;
pub mod session;
pub mod tls;
