//! Write staged edits back (ANG-23).

use tauri::State;

use crate::db::changes;
use crate::error::{AppError, AppResult};
use crate::models::changes::{ApplyResult, TableChanges};
use crate::models::connection::SafeMode;
use crate::state::AppState;

/// The SQL that `apply_changes` would run, values written in. Nothing is executed.
#[tauri::command]
#[specta::specta]
pub async fn preview_changes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    changes: TableChanges,
) -> AppResult<String> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    changes::preview_changes(&client, &schema, &table, &changes).await
}

/// Apply every staged change in one transaction. All or nothing: if one statement fails, or
/// a row was changed or deleted by someone else, nothing is written and the error says which
/// change it was.
#[tauri::command]
#[specta::specta]
pub async fn apply_changes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    changes: TableChanges,
) -> AppResult<ApplyResult> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let client = session.meta().await?;
    changes::apply_changes(&client, &schema, &table, &changes).await
}
