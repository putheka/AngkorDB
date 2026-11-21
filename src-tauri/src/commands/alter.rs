//! Change the structure of a table (ANG-37).

use tauri::State;

use crate::db::alter;
use crate::error::{AppError, AppResult};
use crate::models::alter::{StructureApplyResult, StructureChange, StructurePreview};
use crate::models::connection::SafeMode;
use crate::state::AppState;

/// The `ALTER TABLE` / `CREATE INDEX` / … statements the staged changes would run. Nothing is
/// executed. A mistake in a change (an empty name, SQL that is not one piece) is an error that
/// says which change it is.
#[tauri::command]
#[specta::specta]
pub async fn preview_structure_changes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    changes: Vec<StructureChange>,
) -> AppResult<StructurePreview> {
    state.session(&connection_id).await?;
    alter::preview(&schema, &table, &changes)
}

/// Run the staged changes: everything that can be in a transaction goes in one (all or nothing,
/// with a lock timeout), then each `CONCURRENTLY` statement on its own. If one of those fails,
/// the transaction's changes are already saved and the result says which statement failed.
#[tauri::command]
#[specta::specta]
pub async fn apply_structure_changes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    changes: Vec<StructureChange>,
) -> AppResult<StructureApplyResult> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let client = session.meta().await?;
    alter::apply(&client, &schema, &table, &changes, alter::LOCK_TIMEOUT_MS).await
}
