//! Roles: list, create, alter, drop (ANG-42).

use tauri::State;

use crate::db::roles;
use crate::error::{AppError, AppResult};
use crate::models::alter::StructurePreview;
use crate::models::connection::SafeMode;
use crate::models::roles::{Role, RoleOperation};
use crate::state::AppState;

/// Every role of the server.
#[tauri::command]
#[specta::specta]
pub async fn list_roles(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<Role>> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    roles::list(&client).await
}

/// The SQL the change would run. A password is shown as dots. Nothing is executed.
#[tauri::command]
#[specta::specta]
pub async fn preview_role_operation(
    state: State<'_, AppState>,
    connection_id: String,
    operation: RoleOperation,
) -> AppResult<StructurePreview> {
    state.session(&connection_id).await?;
    roles::preview(&operation)
}

/// Run the change in one transaction. Refused on a read-only connection. Returns how many
/// statements ran.
#[tauri::command]
#[specta::specta]
pub async fn apply_role_operation(
    state: State<'_, AppState>,
    connection_id: String,
    operation: RoleOperation,
) -> AppResult<u32> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let client = session.meta().await?;
    roles::apply(&client, &operation).await
}
