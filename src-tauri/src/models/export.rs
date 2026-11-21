//! Exporting rows to a file: what, in which format, and how far it got (ANG-45).

use serde::{Deserialize, Serialize};

use crate::error::AppErrorPayload;
use crate::models::rows::{Filter, SortSpec};

/// What to export.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportSource {
    /// One table or view, with the filters and sort of the grid it is exported from.
    Table(TableExport),
    /// The rows a query returns. It is run again for the export, in a read-only transaction.
    Query(QueryExport),
    /// Several tables, one file each, into a folder.
    Tables { tables: Vec<TableRef> },
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableExport {
    pub schema: String,
    pub table: String,
    pub filters: Vec<Filter>,
    /// A `WHERE` fragment typed by the person (it runs in a read-only transaction).
    pub raw_where: Option<String>,
    /// The order of the grid. Without one the rows come as the table has them.
    pub sort: Vec<SortSpec>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryExport {
    /// One statement that returns rows.
    pub sql: String,
    /// The table name in `INSERT` statements. `query_result` when blank.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportFormat {
    Csv(CsvOptions),
    Json {
        /// One object per line instead of one array.
        ndjson: bool,
    },
    /// `INSERT` statements.
    Sql {
        /// Rows per statement. Clamped to 1..=10000.
        batch_size: u32,
    },
    Markdown,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    /// One character: `,` `;` tab `|` …
    pub delimiter: String,
    /// One character, doubled inside a value: `"` or `'`.
    pub quote: String,
    pub header: bool,
    /// What `NULL` is written as. Blank: nothing (an empty text is then quoted, to tell them apart).
    pub null_text: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub source: ExportSource,
    pub format: ExportFormat,
    /// The file to write; for several tables, the folder to write the files in.
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ExportState {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    pub state: ExportState,
    /// Rows written so far (all files).
    pub rows: f64,
    /// Bytes written so far.
    pub bytes: f64,
    /// The planner's guess of how many rows there will be, when it has one (a table without
    /// filters). Only for the progress bar.
    pub estimated_rows: Option<f64>,
    /// The table or file being written.
    pub current: Option<String>,
    /// The files written (complete ones).
    pub files: Vec<String>,
    pub error: Option<AppErrorPayload>,
}
