//! PostgreSQL layer (tokio-postgres + deadpool-postgres). Design: ANG-8.
//!
//! - `config`  — saved connection settings → `tokio_postgres::Config`
//! - `tls`     — rustls connector using macOS system root certificates
//! - `url`     — parse `postgres://` URLs into connection form fields
//! - `introspect` — databases, schemas, objects, columns and row identity from `pg_catalog`
//! - `rows`   — page, sort, filter and count the rows of a table
//! - `script` — split SQL text into statements
//! - `query`  — run a script on a tab's own connection
//! - `session` — one open connection: metadata pool + dedicated client per query tab
//!
//! Planned: `changes` (ANG-23).

pub mod config;
pub mod introspect;
pub mod query;
pub mod rows;
pub mod script;
pub mod session;
pub mod tls;
pub mod url;
