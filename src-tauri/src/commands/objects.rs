//! Create, rename, truncate and drop a table or view (ANG-38).

use tauri::State;

use crate::db::{definitions, objects};
use crate::error::{AppError, AppResult};
use crate::models::alter::StructurePreview;
use crate::models::connection::SafeMode;
use crate::models::definitions::{ObjectDefinition, SequenceInfo};
use crate::models::objects::ObjectOperation;
use crate::models::schema::ObjectKind;
use crate::state::AppState;

/// The SQL the operation would run. Nothing is executed. A mistake (an empty name, a type that
/// is not one) is an error that says what is wrong.
#[tauri::command]
#[specta::specta]
pub async fn preview_object_operation(
    state: State<'_, AppState>,
    connection_id: String,
    operation: ObjectOperation,
) -> AppResult<StructurePreview> {
    state.session(&connection_id).await?;
    objects::preview(&operation)
}

/// Run the operation in one transaction (with a lock timeout). Refused on a read-only
/// connection. Returns how many statements ran.
#[tauri::command]
#[specta::specta]
pub async fn apply_object_operation(
    state: State<'_, AppState>,
    connection_id: String,
    operation: ObjectOperation,
) -> AppResult<u32> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let client = session.meta().await?;
    objects::apply(&client, &operation, objects::LOCK_TIMEOUT).await
}

/// The SQL that defines a function, view, materialized view, sequence or enum type, to read or
/// to edit in a query tab (running it changes the definition). `oid` tells overloads apart.
#[tauri::command]
#[specta::specta]
pub async fn object_definition(
    state: State<'_, AppState>,
    connection_id: String,
    kind: ObjectKind,
    schema: String,
    name: String,
    oid: u32,
) -> AppResult<ObjectDefinition> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    definitions::definition(&client, kind, &schema, &name, oid).await
}

/// The settings and current value of a sequence.
#[tauri::command]
#[specta::specta]
pub async fn sequence_info(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    name: String,
) -> AppResult<SequenceInfo> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    definitions::sequence_info(&client, &schema, &name).await
}
