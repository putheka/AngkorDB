//! Importing a CSV or JSON file into a table: what to read, where to put it, and how it went
//! (ANG-46).

use serde::{Deserialize, Serialize};

use crate::error::AppErrorPayload;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportFormat {
    Csv {
        /// One ASCII character: `,` `;` tab `|`.
        delimiter: String,
        /// One ASCII character: `"` or `'`.
        quote: String,
        /// The first row has the column names.
        header: bool,
        /// What `NULL` is written as in the file. Blank: an empty field.
        null_text: String,
    },
    /// An array of objects, or one object per line (told apart by the first character).
    Json,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    pub path: String,
    pub format: ImportFormat,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// The columns of the file: the header, or `column_1`, … without one; for JSON the keys.
    pub columns: Vec<String>,
    /// The first rows, one cell per column; `None` for `NULL`.
    pub rows: Vec<Vec<Option<String>>>,
    /// A type for each column that fits what the first thousand rows hold (for a new table).
    pub suggested_types: Vec<String>,
    pub file_bytes: f64,
    /// The file has more rows than the preview shows.
    pub more_rows: bool,
}

/// One column of the file going to one column of the table.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMap {
    /// The column's name in the file (see [`ImportPreview::columns`]).
    pub source: String,
    /// The column of the table it is written to.
    pub column: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewColumn {
    pub source: String,
    pub name: String,
    /// As SQL: `bigint`, `numeric(10,2)`, `timestamp with time zone`, `jsonb`, …
    pub type_name: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportTarget {
    /// A table that exists. File columns that are not mapped are left out; table columns that
    /// are not mapped get their defaults.
    Existing {
        schema: String,
        table: String,
        mapping: Vec<ColumnMap>,
        /// Empty the table first (in the same transaction, so a failed import keeps its rows).
        truncate: bool,
    },
    /// Make the table from the file first.
    New {
        schema: String,
        table: String,
        columns: Vec<NewColumn>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OnError {
    /// The first row that can't be written stops the import and nothing is kept.
    Abort,
    /// Rows that can't be written are left out and listed; the rest is imported.
    Skip,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub path: String,
    pub format: ImportFormat,
    pub target: ImportTarget,
    pub on_error: OnError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportState {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// A row that could not be imported, and why.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowError {
    /// `line 12` (CSV, one object per line) or `item 12` (an array of objects).
    pub at: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatus {
    pub state: ImportState,
    /// Rows read from the file so far.
    pub rows_read: f64,
    /// Rows written (kept only if the import completes).
    pub rows_written: f64,
    /// Rows left out because they could not be written (`OnError::Skip`).
    pub rows_skipped: f64,
    pub bytes_read: f64,
    pub bytes_total: f64,
    /// The first rows that failed, with the line and the reason.
    pub errors: Vec<RowError>,
    /// There were more failed rows than `errors` holds.
    pub more_errors: bool,
    /// What stopped the import as a whole, if it did not finish.
    pub error: Option<AppErrorPayload>,
    /// The table written to (`schema.table`).
    pub table: Option<String>,
}
