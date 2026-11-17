//! PostgreSQL layer (tokio-postgres + deadpool-postgres).
//!
//! Planned modules:
//! - `session`    — pool + dedicated client per query tab + `CancelToken`s (ANG-9)
//! - `transport`  — `Direct | SshTunnel` connection transport (ANG-8, ANG-43)
//! - `introspect` — schemas, tables, columns via `pg_catalog` (ANG-15)
//! - `rows`       — paged/sorted/filtered `fetch_rows` (ANG-16)
//! - `changes`    — pending-changes → transactional apply (ANG-23)
