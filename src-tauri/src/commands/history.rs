//! Query history and saved queries (ANG-33).

use tauri::State;

use crate::error::AppResult;
use crate::models::history::{HistoryEntry, SavedQuery, SavedQueryInput};
use crate::state::AppState;

/// Statements that were run, newest first. Every word of `query` must be in the statement.
/// `connection_id: None` looks across all connections.
#[tauri::command]
#[specta::specta]
pub fn list_history(
    state: State<'_, AppState>,
    query: String,
    connection_id: Option<String>,
    limit: u32,
    offset: u32,
) -> AppResult<Vec<HistoryEntry>> {
    state
        .history()
        .search(&query, connection_id.as_deref(), limit, offset)
}

#[tauri::command]
#[specta::specta]
pub fn delete_history_entry(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    state.history().delete(id)
}

/// Forget the history of one connection, or all of it.
#[tauri::command]
#[specta::specta]
pub fn clear_history(state: State<'_, AppState>, connection_id: Option<String>) -> AppResult<()> {
    state.history().clear(connection_id.as_deref())
}

/// Saved queries of a connection plus those for every connection; all of them for `None`.
#[tauri::command]
#[specta::specta]
pub fn list_saved_queries(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<Vec<SavedQuery>> {
    state.history().saved(connection_id.as_deref())
}

/// Save a query, or change one that was saved (the input has its `id`).
#[tauri::command]
#[specta::specta]
pub fn save_query(state: State<'_, AppState>, input: SavedQueryInput) -> AppResult<SavedQuery> {
    state.history().save(&input)
}

#[tauri::command]
#[specta::specta]
pub fn delete_saved_query(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    state.history().delete_saved(id)
}
