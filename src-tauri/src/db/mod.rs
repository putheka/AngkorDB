//! PostgreSQL layer (tokio-postgres + deadpool-postgres). Design: ANG-8.
//!
//! - `config`  — saved connection settings → `tokio_postgres::Config`
//! - `tls`     — rustls connector using macOS system root certificates
//! - `url`     — parse `postgres://` URLs into connection form fields
//! - `introspect` — databases, schemas, objects, columns and row identity from `pg_catalog`
//! - `session` — one open connection: metadata pool + dedicated client per query tab
//!
//! Planned: `rows` (ANG-16), `query` (ANG-20), `changes` (ANG-23).

pub mod config;
pub mod introspect;
pub mod session;
pub mod tls;
pub mod url;
