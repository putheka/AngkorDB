use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::connection::{ConnectionConfig, PasswordChange};
use crate::storage::connections::ConnectionStore;
use crate::storage::secrets::SecretStore;

/// Saved connections (JSON file) + their passwords (Keychain), kept in sync.
pub struct ConnectionManager {
    store: ConnectionStore,
    secrets: Arc<dyn SecretStore>,
    /// Serializes read-modify-write cycles, which span awaits on Keychain calls.
    write_lock: Mutex<()>,
}

impl ConnectionManager {
    pub fn new(dir: &Path, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store: ConnectionStore::new(dir),
            secrets,
            write_lock: Mutex::new(()),
        }
    }

    pub fn list(&self) -> AppResult<Vec<ConnectionConfig>> {
        self.store.read()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        find(&self.store.read()?, id)
            .cloned()
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_owned()))
    }

    /// The saved password of a connection. Never touches the Keychain when none was saved.
    pub async fn password(&self, id: &str) -> AppResult<Option<String>> {
        if !self.get(id)?.has_password {
            return Ok(None);
        }
        self.secret_get(id).await
    }

    /// Create (empty `id`) or update a connection.
    pub async fn save(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
    ) -> AppResult<ConnectionConfig> {
        let _guard = self.write_lock.lock().await;
        let mut config = normalize(config)?;
        let mut items = self.store.read()?;

        let is_new = config.id.is_empty();
        let previous = if is_new {
            None
        } else {
            Some(
                find(&items, &config.id)
                    .cloned()
                    .ok_or_else(|| AppError::ConnectionNotFound(config.id.clone()))?,
            )
        };
        if is_new {
            config.id = Uuid::new_v4().to_string();
        }

        config.has_password = match password {
            PasswordChange::Keep => previous.as_ref().is_some_and(|p| p.has_password),
            PasswordChange::Set { value } => {
                if value.is_empty() {
                    return Err(AppError::Validation(
                        "The password is empty. Leave it unchanged or remove the saved one".into(),
                    ));
                }
                self.secret_set(&config.id, &value).await?;
                true
            }
            PasswordChange::Clear => {
                self.secret_delete(&config.id).await?;
                false
            }
        };

        match items.iter_mut().find(|c| c.id == config.id) {
            Some(slot) => *slot = config.clone(),
            None => items.push(config.clone()),
        }
        if let Err(e) = self.store.write(&items) {
            if is_new && config.has_password {
                // Don't leave a password behind for a connection that was never saved.
                let _ = self.secret_delete(&config.id).await;
            }
            return Err(e);
        }
        Ok(config)
    }

    /// Delete a connection and its saved password. The password goes first: if the Keychain
    /// refuses, the connection stays so the user can retry.
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let _guard = self.write_lock.lock().await;
        let mut items = self.store.read()?;
        let config = find(&items, id).ok_or_else(|| AppError::ConnectionNotFound(id.to_owned()))?;

        if config.has_password {
            self.secret_delete(id).await?;
        }
        items.retain(|c| c.id != id);
        self.store.write(&items)
    }

    /// Copy a connection, including its saved password, as "<name> copy".
    pub async fn duplicate(&self, id: &str) -> AppResult<ConnectionConfig> {
        let _guard = self.write_lock.lock().await;
        let mut items = self.store.read()?;
        let original = find(&items, id)
            .cloned()
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_owned()))?;

        let mut copy = original.clone();
        copy.id = Uuid::new_v4().to_string();
        copy.name = unique_copy_name(&items, &original.name);

        if original.has_password {
            match self.secret_get(&original.id).await? {
                Some(secret) => self.secret_set(&copy.id, &secret).await?,
                None => copy.has_password = false, // it vanished from the Keychain
            }
        }

        items.push(copy.clone());
        if let Err(e) = self.store.write(&items) {
            if copy.has_password {
                let _ = self.secret_delete(&copy.id).await;
            }
            return Err(e);
        }
        Ok(copy)
    }

    /// Resolve form values into what a connection test needs, without saving anything:
    /// `Keep` uses the password saved for `config.id`, if there is one.
    pub async fn resolve_for_test(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
    ) -> AppResult<(ConnectionConfig, Option<String>)> {
        let config = normalize(config)?;
        let password = match password {
            PasswordChange::Set { value } => Some(value),
            PasswordChange::Clear => None,
            PasswordChange::Keep if config.id.is_empty() => None,
            PasswordChange::Keep => match self.password(&config.id).await {
                Ok(password) => password,
                Err(AppError::ConnectionNotFound(_)) => None, // an unsaved copy of the form
                Err(e) => return Err(e),
            },
        };
        Ok((config, password))
    }

    async fn secret_get(&self, id: &str) -> AppResult<Option<String>> {
        let (secrets, id) = (Arc::clone(&self.secrets), id.to_owned());
        run_blocking(move || secrets.get(&id)).await
    }

    async fn secret_set(&self, id: &str, secret: &str) -> AppResult<()> {
        let (secrets, id, secret) = (Arc::clone(&self.secrets), id.to_owned(), secret.to_owned());
        run_blocking(move || secrets.set(&id, &secret)).await
    }

    async fn secret_delete(&self, id: &str) -> AppResult<()> {
        let (secrets, id) = (Arc::clone(&self.secrets), id.to_owned());
        run_blocking(move || secrets.delete(&id)).await
    }
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

fn find<'a>(items: &'a [ConnectionConfig], id: &str) -> Option<&'a ConnectionConfig> {
    items.iter().find(|c| c.id == id)
}

/// Trim fields, check required ones and fill in a default name.
fn normalize(mut config: ConnectionConfig) -> AppResult<ConnectionConfig> {
    config.host = config.host.trim().to_owned();
    config.user = config.user.trim().to_owned();
    config.database = config.database.trim().to_owned();
    config.name = config.name.trim().to_owned();
    config.group = config
        .group
        .map(|g| g.trim().to_owned())
        .filter(|g| !g.is_empty());

    if config.host.is_empty() {
        return Err(AppError::Validation("Host is required".into()));
    }
    if config.port == 0 {
        return Err(AppError::Validation(
            "Port must be between 1 and 65535".into(),
        ));
    }
    if config.user.is_empty() {
        return Err(AppError::Validation("User is required".into()));
    }
    if config.database.is_empty() {
        return Err(AppError::Validation("Database is required".into()));
    }
    if config.name.is_empty() {
        config.name = format!("{} @ {}", config.database, config.host);
    }
    Ok(config)
}

fn unique_copy_name(items: &[ConnectionConfig], name: &str) -> String {
    let taken = |candidate: &str| items.iter().any(|c| c.name == candidate);
    let first = format!("{name} copy");
    if !taken(&first) {
        return first;
    }
    (2..)
        .map(|n| format!("{name} copy {n}"))
        .find(|candidate| !taken(candidate))
        .expect("an unused name exists")
}
