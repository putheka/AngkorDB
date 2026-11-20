//! The SQL editor tab: run scripts, stop them, and find the statement under the cursor.

use tauri::State;

use crate::db::{query, script};
use crate::error::AppResult;
use crate::models::query::{QueryRun, TextRange};
use crate::state::AppState;

/// Run the statements of `sql` one after another on the query tab's own connection. A
/// statement that fails ends the run and is reported as the last result.
#[tauri::command]
#[specta::specta]
pub async fn run_query(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
    sql: String,
) -> AppResult<QueryRun> {
    let session = state.session(&connection_id).await?;
    query::run_script(&session, &tab_id, &sql).await
}

/// Ask the server to stop what the tab is running. `false` if the tab has no connection yet.
#[tauri::command]
#[specta::specta]
pub async fn cancel_query(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
) -> AppResult<bool> {
    let session = state.session(&connection_id).await?;
    session.cancel_tab(&tab_id).await
}

/// Close the tab's connection. Nothing to do if the connection is already gone.
#[tauri::command]
#[specta::specta]
pub async fn close_query_tab(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
) -> AppResult<()> {
    if let Ok(session) = state.session(&connection_id).await {
        session.close_tab(&tab_id).await;
    }
    Ok(())
}

/// The statement of `sql` that `cursor` (a UTF-16 offset) is in, or `None` if the text holds
/// none. Used for "run the current statement"; no connection needed.
#[tauri::command]
#[specta::specta]
pub fn statement_at(sql: String, cursor: u32) -> Option<TextRange> {
    let statements = script::split(&sql);
    script::statement_at(&statements, cursor).map(|s| TextRange {
        start: s.utf16_start,
        end: s.utf16_end,
    })
}
