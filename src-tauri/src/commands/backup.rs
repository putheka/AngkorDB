//! Back a database up and restore it with `pg_dump` and `pg_restore` (ANG-47).

use std::sync::Arc;

use tauri::State;

use crate::db::backup::{self, Endpoint, ToolJob};
use crate::error::{AppError, AppResult};
use crate::models::backup::{BackupRequest, PgTools, RestoreRequest, ToolStatus};
use crate::models::connection::SafeMode;
use crate::state::AppState;

/// The PostgreSQL programs on this Mac (Homebrew, Postgres.app, …), newest first. `tools_dir`
/// is a folder the person chose; it is tried too.
#[tauri::command]
#[specta::specta]
pub async fn detect_pg_tools(tools_dir: Option<String>) -> AppResult<Vec<PgTools>> {
    Ok(backup::detect(tools_dir.as_deref()).await)
}

/// Back the database up in the background. Only reads, so a read-only connection may do it.
/// Returns the id to ask about it with.
#[tauri::command]
#[specta::specta]
pub async fn start_backup(
    state: State<'_, AppState>,
    connection_id: String,
    request: BackupRequest,
) -> AppResult<String> {
    let session = state.session(&connection_id).await?;
    let config = session.config().clone();
    let password = state.connections().password(&config.id).await?;
    let endpoint = Endpoint::of(
        &config,
        request.database.as_deref(),
        password,
        session.tunnel_port(),
    )?;
    let found = backup::detect(request.tools_dir.as_deref()).await;
    let tools = backup::pick(
        &found,
        backup::major_of(&session.info().server_version),
        request.tools_dir.as_deref(),
    )?
    .clone();

    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(ToolJob::new());
    state.tool_jobs().add(id.clone(), Arc::clone(&job));
    tokio::spawn(async move {
        let result = backup::run_backup(&job, &tools, &request, &endpoint).await;
        job.finish(result);
    });
    Ok(id)
}

/// Restore a backup in the background, into a database that exists or a new one. Refused on a
/// read-only connection. Returns the id to ask about it with.
#[tauri::command]
#[specta::specta]
pub async fn start_restore(
    state: State<'_, AppState>,
    connection_id: String,
    request: RestoreRequest,
) -> AppResult<String> {
    let session = state.session(&connection_id).await?;
    if session.config().safe_mode == SafeMode::ReadOnly {
        return Err(AppError::Validation(
            "This connection is read-only (safe mode).".into(),
        ));
    }
    let config = session.config().clone();
    let password = state.connections().password(&config.id).await?;
    let endpoint = Endpoint::of(&config, None, password, session.tunnel_port())?;
    let found = backup::detect(request.tools_dir.as_deref()).await;
    let tools = backup::pick(
        &found,
        backup::major_of(&session.info().server_version),
        request.tools_dir.as_deref(),
    )?
    .clone();
    let admin = session.meta().await?;

    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(ToolJob::new());
    state.tool_jobs().add(id.clone(), Arc::clone(&job));
    tokio::spawn(async move {
        let result = backup::run_restore(&job, &tools, &request, endpoint, &admin).await;
        job.finish(result);
    });
    Ok(id)
}

/// What the program printed so far, how big the backup is, and how it ended.
#[tauri::command]
#[specta::specta]
pub async fn tool_status(state: State<'_, AppState>, id: String) -> AppResult<ToolStatus> {
    state
        .tool_jobs()
        .get(&id)
        .map(|job| job.snapshot())
        .ok_or_else(|| AppError::NotFound(format!("job {id}")))
}

/// Stop the program. A backup that was not finished is removed; a database made for a restore
/// is dropped again.
#[tauri::command]
#[specta::specta]
pub async fn cancel_tool(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(state.tool_jobs().get(&id).map(|job| job.cancel()).is_some())
}
