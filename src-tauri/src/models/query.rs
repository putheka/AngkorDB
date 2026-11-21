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
    /// What the server said while running it: `RAISE NOTICE` / `WARNING`, "table does not exist,
    /// skipping", … In the order they arrived.
    pub notices: Vec<Notice>,
}

/// A message from the server that is not an error (ANG-32).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// `NOTICE`, `WARNING`, `INFO`, `LOG`, `DEBUG`.
    pub severity: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// SQLSTATE, e.g. `00000`.
    pub code: String,
}

/// Longest text kept per notice field (bytes); a function can raise notices of any size.
const MAX_NOTICE_TEXT: usize = 4096;
/// Most notices kept for one tab between two runs; the rest are dropped.
pub const MAX_NOTICES: usize = 200;

fn clip(text: &str) -> String {
    if text.len() <= MAX_NOTICE_TEXT {
        return text.to_owned();
    }
    let mut end = MAX_NOTICE_TEXT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

impl Notice {
    /// Stands in for the notices that did not fit.
    pub fn overflow() -> Self {
        Self {
            severity: "NOTICE".into(),
            message: format!("More than {MAX_NOTICES} messages: the rest were not kept."),
            detail: None,
            hint: None,
            code: "00000".into(),
        }
    }
}

impl From<&tokio_postgres::error::DbError> for Notice {
    fn from(e: &tokio_postgres::error::DbError) -> Self {
        Self {
            severity: e.severity().to_owned(),
            message: clip(e.message()),
            detail: e.detail().map(clip),
            hint: e.hint().map(clip),
            code: e.code().code().to_owned(),
        }
    }
}

/// The result of running a script: one entry per statement that was run. After a statement
/// fails, the ones behind it are not run, so the last entry is the error.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryRun {
    pub statements: Vec<StatementResult>,
    pub duration_ms: u32,
}

/// What a statement does, for the safe modes (ANG-25).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum StatementKind {
    /// Reads, or only changes the session.
    Read,
    /// Changes data.
    Write,
    /// Changes the schema or permissions.
    Schema,
}

/// One statement of a script and what it does.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementClass {
    pub range: TextRange,
    pub kind: StatementKind,
    /// The first word in capitals, or two for `SELECT INTO` and `COPY FROM`.
    pub command: String,
    /// It could make a read-only session writable again.
    pub unlocks_writes: bool,
}
