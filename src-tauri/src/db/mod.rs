//! PostgreSQL layer (tokio-postgres + deadpool-postgres). Design: ANG-8.
//!
//! - `config`  — saved connection settings → `tokio_postgres::Config`
//! - `tls`     — rustls connector using macOS system root certificates
//! - `url`     — parse `postgres://` URLs into connection form fields
//! - `definitions` — the SQL behind a function, view, sequence or enum
//! - `explain` — EXPLAIN / EXPLAIN ANALYZE of one statement, analyzed ones rolled back
//! - `introspect` — databases, schemas, objects, columns and row identity from `pg_catalog`
//! - `alter`  — change the structure of a table: plan the statements, run them
//! - `changes` — apply staged edits in one transaction, or show the SQL they would run
//! - `classify` — tell reads from writes, and find statements that unlock a read-only session
//! - `rows`   — page, sort, filter and count the rows of a table
//! - `script` — split SQL text into statements
//! - `objects` — create, rename, truncate and drop a table or view
//! - `query`  — run a script on a tab's own connection
//! - `structure` — columns, indexes, constraints, triggers and the DDL of one table
//! - `session` — one open connection: metadata pool + dedicated client per query tab

pub mod activity;
pub mod alter;
pub mod backup;
pub mod changes;
pub mod classify;
pub mod config;
pub mod definitions;
pub mod explain;
pub mod export;
pub mod export_format;
pub mod import;
pub mod import_sniff;
pub mod introspect;
pub mod objects;
pub mod privileges;
pub mod query;
pub mod roles;
pub mod rows;
pub mod script;
pub mod session;
pub mod ssh;
pub mod structure;
pub mod tls;
pub mod url;
