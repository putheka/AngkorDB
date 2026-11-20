//! Running SQL typed into a query tab (ANG-20).

use serde::Serialize;

use crate::error::AppErrorPayload;
use crate::models::rows::ResultColumn;

/// A stretch of the submitted text. Offsets count UTF-16 code units, which is what the
/// editor in the UI counts, so they can be used as editor positions without conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatementOutcome {
    /// The statement returned rows (possibly none): a `SELECT`, `RETURNING`, `SHOW`, …
    Rows {
        columns: Vec<ResultColumn>,
        /// Every cell as text, `None` for SQL `NULL`. Booleans are `true` / `false`.
        rows: Vec<Vec<Option<String>>>,
        /// More rows existed than the cap; the rest were not read.
        truncated: bool,
    },
    /// `INSERT`, `UPDATE`, DDL, … `command` is its first word in capitals.
    Command { command: String, affected: u32 },
    Error {
        error: AppErrorPayload,
        /// Where the server pointed, as an offset into the submitted text. `None` when it
        /// named no position.
        offset: Option<u32>,
    },
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// The statement within the submitted text.
    pub range: TextRange,
    pub duration_ms: u32,
    pub outcome: StatementOutcome,
}

/// The result of running a script: one entry per statement that was run. After a statement
/// fails, the ones behind it are not run, so the last entry is the error.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryRun {
    pub statements: Vec<StatementResult>,
    pub duration_ms: u32,
}
