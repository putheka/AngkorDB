//! Export rows to a file: start, watch, cancel (ANG-45).

use std::sync::Arc;

use tauri::State;

use crate::db::export::{self, ExportJob};
use crate::error::{AppError, AppResult};
use crate::models::export::{ExportRequest, ExportStatus};
use crate::state::AppState;

/// Start writing the rows to a file in the background. Returns the id to ask about it with.
/// Reading only, so it works on a read-only connection.
#[tauri::command]
#[specta::specta]
pub async fn start_export(
    state: State<'_, AppState>,
    connection_id: String,
    request: ExportRequest,
) -> AppResult<String> {
    let session = state.session(&connection_id).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(ExportJob::new());
    state.exports().add(id.clone(), Arc::clone(&job));
    let task_id = id.clone();
    tokio::spawn(async move {
        let result = export::run(&session, &job, &task_id, &request).await;
        job.finish(result);
    });
    Ok(id)
}

/// How far an export is: rows and bytes written, and how it ended.
#[tauri::command]
#[specta::specta]
pub async fn export_status(state: State<'_, AppState>, id: String) -> AppResult<ExportStatus> {
    state
        .exports()
        .get(&id)
        .map(|job| job.snapshot())
        .ok_or_else(|| AppError::NotFound(format!("export {id}")))
}

/// Stop an export after the batch it is on. The file is not kept.
#[tauri::command]
#[specta::specta]
pub async fn cancel_export(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(state.exports().get(&id).map(|job| job.cancel()).is_some())
}
