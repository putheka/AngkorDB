//! Keeping the window's workspace across launches (ANG-50).

use tauri::State;

use crate::error::AppResult;
use crate::models::workspace::StartupState;
use crate::state::AppState;

/// Keep the workspace of a connection (tabs, query text, table views) as the page wrote it.
/// Called every couple of seconds while something changes, so it must be cheap and whole.
#[tauri::command]
#[specta::specta]
pub async fn save_workspace(
    state: State<'_, AppState>,
    connection_id: String,
    data: String,
) -> AppResult<()> {
    state.workspaces().save(&connection_id, &data)
}

/// The workspace last kept for a connection, if there is one.
#[tauri::command]
#[specta::specta]
pub async fn load_workspace(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<String>> {
    state.workspaces().load(&connection_id)
}

/// What to do at launch: whether to reopen, and which connection.
#[tauri::command]
#[specta::specta]
pub async fn startup_state(state: State<'_, AppState>) -> AppResult<StartupState> {
    Ok(state.workspaces().startup())
}

#[tauri::command]
#[specta::specta]
pub async fn set_restore_on_launch(state: State<'_, AppState>, restore: bool) -> AppResult<()> {
    state.workspaces().set_restore_on_launch(restore)
}

/// Note which connection is open (`None`: none is), for the next launch.
#[tauri::command]
#[specta::specta]
pub async fn set_last_connection(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<()> {
    state
        .workspaces()
        .set_last_connection(connection_id.as_deref())
}
