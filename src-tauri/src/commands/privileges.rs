//! Who may do what to a schema, table or sequence (ANG-42).

use tauri::State;

use crate::db::privileges;
use crate::error::{AppError, AppResult};
use crate::models::alter::StructurePreview;
use crate::models::connection::SafeMode;
use crate::models::privileges::{
    DefaultPrivilege, PrivilegeChange, PrivilegeMatrix, PrivilegeTarget,
};
use crate::state::AppState;

/// Who holds which privileges on a schema, table or sequence.
#[tauri::command]
#[specta::specta]
pub async fn object_privileges(
    state: State<'_, AppState>,
    connection_id: String,
    target: PrivilegeTarget,
) -> AppResult<PrivilegeMatrix> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    privileges::matrix(&client, &target).await
}

/// What new objects start out with, per role and schema (`ALTER DEFAULT PRIVILEGES`).
#[tauri::command]
#[specta::specta]
pub async fn default_privileges(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<DefaultPrivilege>> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    privileges::defaults(&client).await
}

/// The `GRANT` and `REVOKE` statements the changes would run. Nothing is executed.
#[tauri::command]
#[specta::specta]
pub async fn preview_privilege_changes(
    state: State<'_, AppState>,
    connection_id: String,
    changes: Vec<PrivilegeChange>,
) -> AppResult<StructurePreview> {
    state.session(&connection_id).await?;
    privileges::preview(&changes)
}

/// Run the changes in one transaction. Refused on a read-only connection.
#[tauri::command]
#[specta::specta]
pub async fn apply_privilege_changes(
    state: State<'_, AppState>,
    connection_id: String,
    changes: Vec<PrivilegeChange>,
) -> AppResult<u32> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let client = session.meta().await?;
    privileges::apply(&client, &changes).await
}
