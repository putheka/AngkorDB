//! The SQL that defines a function, view, sequence or enum, and what a sequence is up to (ANG-39).

use serde::Serialize;

/// Text to read and edit: running it (in a query tab) changes the definition in the database.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDefinition {
    /// What to call the query tab.
    pub title: String,
    pub sql: String,
}

/// Numbers are text: a sequence can reach 9223372036854775807, which a JS number can't hold.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub data_type: String,
    pub start: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub cache: String,
    pub cycle: bool,
    /// The last value handed out; `None` while the sequence has not been used.
    pub last_value: Option<String>,
    /// `schema.table.column` if a column owns it (serial, identity).
    pub owned_by: Option<String>,
}
