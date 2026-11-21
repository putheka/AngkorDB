//! The process list: who is connected, who blocks whom, stop a query or a connection (ANG-41).

use tauri::State;

use crate::db::activity;
use crate::error::{AppError, AppResult};
use crate::models::activity::{Backend, Signal};
use crate::models::connection::SafeMode;
use crate::state::AppState;

/// Every client connection of the server. Reading only, so it works on a read-only connection.
#[tauri::command]
#[specta::specta]
pub async fn list_activity(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<Backend>> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    activity::list(&client).await
}

/// Stop the query a backend runs (`pg_cancel_backend`). `false`: it was gone already.
#[tauri::command]
#[specta::specta]
pub async fn cancel_backend(
    state: State<'_, AppState>,
    connection_id: String,
    pid: u32,
) -> AppResult<bool> {
    send(&state, &connection_id, pid, Signal::Cancel).await
}

/// Close a backend's connection (`pg_terminate_backend`); its open transaction is rolled back.
/// `false`: it was gone already.
#[tauri::command]
#[specta::specta]
pub async fn terminate_backend(
    state: State<'_, AppState>,
    connection_id: String,
    pid: u32,
) -> AppResult<bool> {
    send(&state, &connection_id, pid, Signal::Terminate).await
}

/// Both change what other people are running, so a read-only connection refuses them.
async fn send(
    state: &State<'_, AppState>,
    connection_id: &str,
    pid: u32,
    signal: Signal,
) -> AppResult<bool> {
    let session = state.session(connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let client = session.meta().await?;
    activity::signal(&client, pid, signal).await
}
