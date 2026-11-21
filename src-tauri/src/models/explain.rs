//! EXPLAIN / EXPLAIN ANALYZE (ANG-35).

use serde::Serialize;

use crate::error::AppErrorPayload;
use crate::models::query::StatementKind;

/// What `EXPLAIN` gave back.
#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExplainOutcome {
    /// The plan as the server wrote it: `EXPLAIN (FORMAT JSON …)`'s single value.
    Plan { json: String },
    Error {
        error: AppErrorPayload,
        /// Where the server pointed, as an offset into the submitted text (UTF-16 units).
        offset: Option<u32>,
    },
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRun {
    pub outcome: ExplainOutcome,
    pub duration_ms: u32,
    /// `EXPLAIN ANALYZE`: the statement really ran.
    pub analyzed: bool,
    /// What the explained statement does to the database.
    pub statement_kind: StatementKind,
    /// `UPDATE`, `SELECT`, …
    pub command: String,
    /// The statement ran inside a transaction (or savepoint) that was rolled back afterwards, so
    /// whatever it changed is undone. Sequences and other non-transactional effects are not.
    pub rolled_back: bool,
}
