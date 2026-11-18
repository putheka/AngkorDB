//! Browse the structure of the open database: databases, schemas, objects, columns.

use tauri::State;

use crate::db::introspect;
use crate::error::AppResult;
use crate::models::connection::ConnectionInfo;
use crate::models::schema::{DatabaseInfo, DbObject, SchemaInfo, TableDescription};
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<DatabaseInfo>> {
    let session = state.session(&connection_id).await?;
    introspect::list_databases(&*session.meta().await?).await
}

/// Switch the open connection to another database on the same server. Returns the new
/// session's info. If it fails, the current database stays open.
#[tauri::command]
#[specta::specta]
pub async fn switch_database(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<ConnectionInfo> {
    let current = state.session(&connection_id).await?;
    let next = current.switch_database(&database).await?;
    let info = next.info().clone();
    state.insert_session(next).await;
    Ok(info)
}

/// Schemas, `public` first. System schemas only with `include_system`.
#[tauri::command]
#[specta::specta]
pub async fn list_schemas(
    state: State<'_, AppState>,
    connection_id: String,
    include_system: bool,
) -> AppResult<Vec<SchemaInfo>> {
    let session = state.session(&connection_id).await?;
    introspect::list_schemas(&*session.meta().await?, include_system).await
}

/// Tables, views, materialized views, functions, sequences and enum types of one schema.
#[tauri::command]
#[specta::specta]
pub async fn list_objects(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
) -> AppResult<Vec<DbObject>> {
    let session = state.session(&connection_id).await?;
    introspect::list_objects(&*session.meta().await?, &schema).await
}

/// Columns, keys and how rows are identified for a table, view or materialized view.
#[tauri::command]
#[specta::specta]
pub async fn describe_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
) -> AppResult<TableDescription> {
    let session = state.session(&connection_id).await?;
    introspect::describe_table(&*session.meta().await?, &schema, &table).await
}
