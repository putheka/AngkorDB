//! Saved connections: CRUD, testing, URL import, and opening/closing a database session.

use tauri::State;

use crate::db::session::Extras;
use crate::db::ssh::{self, SshSetup};
use crate::db::{session, url};
use crate::error::{AppError, AppResult};
use crate::models::connection::{
    ConnectionConfig, ConnectionHealth, ConnectionInfo, ParsedConnectionUrl, PasswordChange,
    SshAuth, SshTestResult,
};
use crate::state::AppState;

/// If the SSH tunnel stopped at a host key that can be trusted, remember it for `trust_ssh_host`.
fn note_host_key(state: &AppState, error: AppError) -> AppError {
    if let Some(problem) = error.host_key() {
        state.remember_host_key(problem.clone());
    }
    error
}

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
    ssh_secret: Option<PasswordChange>,
    ssl_key_secret: Option<PasswordChange>,
) -> AppResult<ConnectionConfig> {
    state
        .connections()
        .save_with_secrets(
            config,
            password,
            ssh_secret.unwrap_or(PasswordChange::Keep),
            ssl_key_secret.unwrap_or(PasswordChange::Keep),
        )
        .await
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
    ssh_secret: Option<PasswordChange>,
    ssl_key_secret: Option<PasswordChange>,
) -> AppResult<ConnectionInfo> {
    let (config, secrets) = state
        .connections()
        .resolve_for_test_all(
            config,
            password,
            ssh_secret.unwrap_or(PasswordChange::Keep),
            ssl_key_secret.unwrap_or(PasswordChange::Keep),
        )
        .await?;
    let extras = Extras {
        ssh: Some(SshSetup {
            known_hosts: state.known_hosts().to_path_buf(),
            ..SshSetup::new(secrets.ssh)
        }),
        ssl_key_passphrase: secrets.ssl_key,
    };
    session::test_connection_with(&config, secrets.password.as_deref(), extras)
        .await
        .map_err(|e| note_host_key(&state, e))
}

/// Try the SSH leg of the form alone: log in to the SSH server (checking its host key) and ask it
/// to open the database's host and port. Nothing is saved.
#[tauri::command]
#[specta::specta]
pub async fn test_ssh(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    ssh_secret: Option<PasswordChange>,
) -> AppResult<SshTestResult> {
    let (config, _, ssh_secret) = state
        .connections()
        .resolve_for_test_with_ssh(
            config,
            PasswordChange::Keep,
            ssh_secret.unwrap_or(PasswordChange::Keep),
        )
        .await?;
    let Some(settings) = config.ssh.as_ref() else {
        return Err(AppError::Validation(
            "This connection does not use an SSH tunnel.".into(),
        ));
    };
    if settings.auth == SshAuth::Password && ssh_secret.is_none() {
        return Err(AppError::Validation("Enter the SSH password.".into()));
    }
    let setup = SshSetup {
        known_hosts: state.known_hosts().to_path_buf(),
        ..SshSetup::new(ssh_secret)
    };
    let report = ssh::test(settings, &setup, &config.host, config.port)
        .await
        .map_err(|e| note_host_key(&state, e))?;
    Ok(SshTestResult {
        fingerprint: report.fingerprint,
        key_type: report.key_type,
        reaches_database: report.reaches_database,
        database_problem: report.database_problem,
    })
}

/// Trust the SSH host key that the last attempt stopped at (identified by its fingerprint):
/// it is added to known_hosts, as `ssh` does when you answer "yes". Then try again.
#[tauri::command]
#[specta::specta]
pub async fn trust_ssh_host(state: State<'_, AppState>, fingerprint: String) -> AppResult<()> {
    let problem = state.take_host_key(&fingerprint).ok_or_else(|| {
        AppError::Validation(
            "That host key is not waiting to be trusted. Try connecting again.".into(),
        )
    })?;
    ssh::trust(&problem, state.known_hosts())
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
    let extras = Extras {
        ssh: Some(SshSetup {
            known_hosts: state.known_hosts().to_path_buf(),
            ..SshSetup::new(state.connections().ssh_secret(&id).await?)
        }),
        ssl_key_passphrase: state.connections().ssl_key_secret(&id).await?,
    };
    let session = session::Session::open_with(config, password.as_deref(), extras)
        .await
        .map_err(|e| note_host_key(&state, e))?;
    let info = session.info().clone();
    state.insert_session(session).await;
    Ok(info)
}

/// How the open connection is doing. Asking also checks it, if it has been idle a while, and
/// replaces it when it was lost (the laptop slept, the network changed): so a connection that
/// is polled this way is already back when the next query is run.
#[tauri::command]
#[specta::specta]
pub async fn connection_health(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ConnectionHealth> {
    let session = state.session(&connection_id).await?;
    // The check and the new connection take as long as they take; not forever.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), session.meta()).await;
    let health = session.health();
    Ok(ConnectionHealth {
        reconnecting: health.reconnecting,
        reconnects: health.reconnects,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.remove_session(&id).await;
    Ok(())
}
