//! Backing a database up with `pg_dump` and restoring it with `pg_restore` (ANG-47).

use serde::{Deserialize, Serialize};

use crate::error::AppErrorPayload;

/// A set of PostgreSQL client programs found on this Mac.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PgTools {
    /// The folder with `pg_dump`, `pg_restore` and `psql`.
    pub dir: String,
    /// `17.10`
    pub version: String,
    pub major: u32,
    /// Where it was found: `Homebrew`, `Postgres.app`, `PATH`, `Chosen folder`, …
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BackupFormat {
    /// `pg_restore` can pick tables and restore in parallel. Compressed.
    Custom,
    /// A SQL script, for `psql`.
    Plain,
    /// A folder with one file per table, restorable in parallel.
    Directory,
    Tar,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupRequest {
    /// The folder with the PostgreSQL programs; `None`: the newest one found that is not older
    /// than the server.
    pub tools_dir: Option<String>,
    /// The database to back up; `None`: the one connected to.
    pub database: Option<String>,
    /// The file to write (for the directory format, the folder, which must not exist yet).
    pub path: String,
    pub format: BackupFormat,
    pub schema_only: bool,
    pub data_only: bool,
    /// Only these tables (`pg_dump -t`): names or patterns like `public.orders*`.
    pub include_tables: Vec<String>,
    /// Leave these tables out (`pg_dump -T`).
    pub exclude_tables: Vec<String>,
    /// 0 (none) to 9, for the custom and directory formats; `None`: the program's default.
    pub compression: Option<u32>,
    /// Leave out who owns what (`--no-owner`).
    pub no_owner: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestoreTarget {
    /// A database that exists.
    Existing { database: String },
    /// Make this database first.
    New { database: String },
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub tools_dir: Option<String>,
    /// A backup file or folder.
    pub path: String,
    pub target: RestoreTarget,
    /// Drop what is in the backup before making it again (`--clean --if-exists`).
    pub clean: bool,
    /// Don't set who owns what (`--no-owner`).
    pub no_owner: bool,
    /// Programs restoring at once (`-j`), for the custom and directory formats. 1..=16.
    pub jobs: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolState {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub state: ToolState,
    /// What the program printed, the last lines.
    pub log: Vec<String>,
    /// How many lines it printed in all.
    pub lines: f64,
    /// For a backup: how big the file (or folder) is so far.
    pub bytes: f64,
    /// The command, without anything secret, as it would be typed.
    pub command: String,
    /// What it made: the file, or the database.
    pub output: Option<String>,
    pub error: Option<AppErrorPayload>,
}
