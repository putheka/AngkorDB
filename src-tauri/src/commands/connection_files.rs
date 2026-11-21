//! Move connections between Macs in a file without secrets (ANG-48).

use std::fs;
use std::path::Path;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::connection::{ConnectionConfig, PasswordChange};
use crate::models::connection_file::{
    ConnectionFile, FILE_KIND, FILE_VERSION, ImportEntry, SharedConnection,
};
use crate::state::AppState;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn absolute(path: &str) -> AppResult<&Path> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(invalid("Choose where the file is."));
    }
    Ok(path)
}

/// Write the chosen connections to a file: their settings, never a password, an SSH secret or a
/// key passphrase. Returns how many were written.
#[tauri::command]
#[specta::specta]
pub async fn export_connections(
    state: State<'_, AppState>,
    ids: Vec<String>,
    path: String,
) -> AppResult<u32> {
    let path = absolute(&path)?;
    if ids.is_empty() {
        return Err(invalid("Choose at least one connection."));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(invalid(format!(
            "The folder of {} does not exist.",
            path.display()
        )));
    }
    let connections = state.connections().list()?;
    let mut shared = Vec::new();
    for id in &ids {
        let config = connections
            .iter()
            .find(|c| &c.id == id)
            .ok_or_else(|| AppError::ConnectionNotFound(id.clone()))?;
        shared.push(SharedConnection::of(config));
    }
    let count = u32::try_from(shared.len()).unwrap_or(u32::MAX);
    let file = ConnectionFile {
        kind: FILE_KIND.to_owned(),
        version: FILE_VERSION,
        connections: shared,
    };
    let json =
        serde_json::to_string_pretty(&file).map_err(|e| AppError::Internal(e.to_string()))?;
    // Written next to its name first, so a file that was there is not half-replaced.
    let part = path.with_extension("json.part");
    fs::write(&part, json)
        .and_then(|()| fs::rename(&part, path))
        .map_err(|e| {
            let _ = fs::remove_file(&part);
            invalid(format!("Can't write {}: {e}.", path.display()))
        })?;
    Ok(count)
}

fn read_file(path: &str) -> AppResult<Vec<SharedConnection>> {
    let path = absolute(path)?;
    let text = fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            invalid(format!("There is no file at {}.", path.display()))
        } else {
            invalid(format!("Can't read {}: {e}.", path.display()))
        }
    })?;
    let file: ConnectionFile = serde_json::from_str(&text)
        .map_err(|e| invalid(format!("This is not a file of AngkorDB connections ({e}).")))?;
    if file.kind != FILE_KIND {
        return Err(invalid("This is not a file of AngkorDB connections."));
    }
    if file.version > FILE_VERSION {
        return Err(invalid(
            "This file was made by a newer version of AngkorDB. Update the app to read it.",
        ));
    }
    Ok(file.connections)
}

/// What is in a connections file, to show before importing. Nothing is saved.
#[tauri::command]
#[specta::specta]
pub async fn read_connection_file(path: String) -> AppResult<Vec<SharedConnection>> {
    read_file(&path)
}

/// `name`, or `name (2)`, `name (3)`… when it is taken.
fn free_name(taken: &[ConnectionConfig], name: &str) -> String {
    let used = |candidate: &str| taken.iter().any(|c| c.name == candidate);
    if !used(name) {
        return name.to_owned();
    }
    (2..)
        .map(|n| format!("{name} ({n})"))
        .find(|candidate| !used(candidate))
        .expect("an unused name exists")
}

/// Save the given connections (the ones shown from a file) as new ones, with the secrets typed
/// for them (kept in the Keychain). A name that is taken gets a number. Returns the connections
/// that were saved. The file is not read again: what was shown is what is saved.
#[tauri::command]
#[specta::specta]
pub async fn import_connections(
    state: State<'_, AppState>,
    entries: Vec<ImportEntry>,
) -> AppResult<Vec<ConnectionConfig>> {
    if entries.is_empty() {
        return Err(invalid("Choose at least one connection to import."));
    }
    let set = |value: &Option<String>| match value.as_deref() {
        Some(v) if !v.is_empty() => PasswordChange::Set {
            value: v.to_owned(),
        },
        _ => PasswordChange::Keep,
    };
    let mut saved = Vec::new();
    for entry in entries {
        let mut config = entry.connection.clone().into_config();
        config.name = free_name(&state.connections().list()?, &config.name);
        let label = config.name.clone();
        let result = state
            .connections()
            .save_with_all(
                config,
                set(&entry.password),
                set(&entry.ssh_secret),
                set(&entry.ssl_key_secret),
                set(&entry.ssh_jump_secret),
            )
            .await
            .map_err(|e| {
                invalid(format!(
                    "\"{label}\": {}{}",
                    e.message(),
                    if saved.is_empty() {
                        String::new()
                    } else {
                        format!(" ({} connection(s) before it were imported.)", saved.len())
                    }
                ))
            })?;
        saved.push(result);
    }
    Ok(saved)
}
