//! Saved connections: CRUD, testing, URL import, and opening/closing a database session.

use tauri::State;

use crate::db::{session, url};
use crate::error::AppResult;
use crate::models::connection::{
    ConnectionConfig, ConnectionInfo, ParsedConnectionUrl, PasswordChange,
};
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    state.connections().list()
}

/// Create (empty `config.id`) or update a connection. Returns the saved connection.
#[tauri::command]
#[specta::specta]
pub async fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: PasswordChange,
) -> AppResult<ConnectionConfig> {
    state.connections().save(config, password).await
}

/// Delete a connection and its saved password; closes it first if it is open.
#[tauri::command]
#[specta::specta]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.remove_session(&id).await;
    state.connections().delete(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn duplicate_connection(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ConnectionConfig> {
    state.connections().duplicate(&id).await
}

/// Try to connect with the form values, without saving. Fails after 6 seconds at the latest.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: PasswordChange,
) -> AppResult<ConnectionInfo> {
    let (config, password) = state
        .connections()
        .resolve_for_test(config, password)
        .await?;
    session::test_connection(&config, password.as_deref()).await
}

/// Fill the connection form from a `postgres://` URL.
#[tauri::command]
#[specta::specta]
pub async fn parse_connection_url(url: String) -> AppResult<ParsedConnectionUrl> {
    url::parse_connection_url(&url)
}

/// Open a saved connection (replaces an already open session of the same connection).
#[tauri::command]
#[specta::specta]
pub async fn connect_connection(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ConnectionInfo> {
    let config = state.connections().get(&id)?;
    let password = state.connections().password(&id).await?;
    let session = session::Session::open(config, password.as_deref()).await?;
    let info = session.info().clone();
    state.insert_session(session).await;
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.remove_session(&id).await;
    Ok(())
}
