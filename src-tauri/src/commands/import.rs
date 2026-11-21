//! Import a CSV or JSON file into a table: preview, start, watch, cancel (ANG-46).

use std::sync::Arc;

use tauri::State;

use crate::db::import::{self, ImportJob};
use crate::error::{AppError, AppResult};
use crate::models::connection::SafeMode;
use crate::models::import::{ImportPreview, ImportRequest, ImportStatus, PreviewRequest};
use crate::state::AppState;

/// The start of a file: its columns, the first 50 rows and a type for each column. Reads the
/// file only; needs no connection.
#[tauri::command]
#[specta::specta]
pub async fn preview_import(request: PreviewRequest) -> AppResult<ImportPreview> {
    tokio::task::spawn_blocking(move || import::preview(&request))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Start writing the file into the table in the background, in one transaction. Refused on a
/// read-only connection. Returns the id to ask about it with.
#[tauri::command]
#[specta::specta]
pub async fn start_import(
    state: State<'_, AppState>,
    connection_id: String,
    request: ImportRequest,
) -> AppResult<String> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(ImportJob::new());
    state.imports().add(id.clone(), Arc::clone(&job));
    let task_id = id.clone();
    tokio::spawn(async move {
        let result = import::run(&session, &job, &task_id, &request).await;
        job.finish(result);
    });
    Ok(id)
}

/// How far an import is, the rows that could not be written, and how it ended.
#[tauri::command]
#[specta::specta]
pub async fn import_status(state: State<'_, AppState>, id: String) -> AppResult<ImportStatus> {
    state
        .imports()
        .get(&id)
        .map(|job| job.snapshot())
        .ok_or_else(|| AppError::NotFound(format!("import {id}")))
}

/// Stop an import after the batch it is on. Nothing it wrote is kept.
#[tauri::command]
#[specta::specta]
pub async fn cancel_import(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(state.imports().get(&id).map(|job| job.cancel()).is_some())
}
