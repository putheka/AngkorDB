//! Query history and saved queries (ANG-33).

use serde::{Deserialize, Serialize};

/// A statement that was run, newest first in listings.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: u32,
    pub connection_id: String,
    pub sql: String,
    /// Unix time in milliseconds.
    pub ran_at: f64,
    pub duration_ms: u32,
    /// The statement succeeded.
    pub ok: bool,
}

/// A query the person kept, with a name and an optional folder.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: u32,
    /// `None`: usable on every connection.
    pub connection_id: Option<String>,
    pub name: String,
    /// `""` for none.
    pub folder: String,
    pub sql: String,
    pub created_at: f64,
}

/// What the form sends to save (a new query without an `id`, or changes to one with).
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryInput {
    pub id: Option<u32>,
    pub connection_id: Option<String>,
    pub name: String,
    pub folder: String,
    pub sql: String,
}
