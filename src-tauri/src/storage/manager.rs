use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::connection::{ConnectionConfig, PasswordChange, SshAuth, SshConfig, SslFiles};
use crate::storage::connections::ConnectionStore;
use crate::storage::secrets::SecretStore;

/// The Keychain account of a connection's SSH password or key passphrase.
fn ssh_account(id: &str) -> String {
    format!("{id}:ssh")
}

/// The Keychain account of the passphrase of a connection's TLS client key.
fn ssl_key_account(id: &str) -> String {
    format!("{id}:sslkey")
}

/// Everything a connection needs besides its settings, as the form resolved it for a test.
#[derive(Default)]
pub struct TestSecrets {
    pub password: Option<String>,
    pub ssh: Option<String>,
    pub ssl_key: Option<String>,
}

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

    /// The saved SSH password or key passphrase of a connection.
    pub async fn ssh_secret(&self, id: &str) -> AppResult<Option<String>> {
        if !self.get(id)?.ssh.is_some_and(|s| s.has_secret) {
            return Ok(None);
        }
        self.secret_get(&ssh_account(id)).await
    }

    /// The saved passphrase of the TLS client key of a connection.
    pub async fn ssl_key_secret(&self, id: &str) -> AppResult<Option<String>> {
        if !self.get(id)?.ssl_files.is_some_and(|f| f.has_key_secret) {
            return Ok(None);
        }
        self.secret_get(&ssl_key_account(id)).await
    }

    /// Create (empty `id`) or update a connection. An SSH secret already saved is kept.
    pub async fn save(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
    ) -> AppResult<ConnectionConfig> {
        self.save_with_ssh(config, password, PasswordChange::Keep)
            .await
    }

    /// [`ConnectionManager::save`], and what to do with the SSH password or key passphrase.
    pub async fn save_with_ssh(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
        ssh_secret: PasswordChange,
    ) -> AppResult<ConnectionConfig> {
        self.save_with_secrets(config, password, ssh_secret, PasswordChange::Keep)
            .await
    }

    /// [`ConnectionManager::save`], and what to do with the SSH password or key passphrase and
    /// with the passphrase of the TLS client key.
    pub async fn save_with_secrets(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
        ssh_secret: PasswordChange,
        ssl_key_secret: PasswordChange,
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

        let had_ssh_secret = previous
            .as_ref()
            .and_then(|p| p.ssh.as_ref())
            .is_some_and(|s| s.has_secret);
        match config.ssh.as_mut() {
            None => {
                // No tunnel any more: its secret goes with it.
                if had_ssh_secret {
                    self.secret_delete(&ssh_account(&config.id)).await?;
                }
            }
            // Logging in with the ssh-agent needs no secret: one saved before is thrown away.
            Some(ssh) if ssh.auth == SshAuth::Agent => {
                if had_ssh_secret {
                    self.secret_delete(&ssh_account(&config.id)).await?;
                }
                ssh.has_secret = false;
            }
            Some(ssh) => {
                ssh.has_secret = match ssh_secret {
                    PasswordChange::Keep => had_ssh_secret,
                    PasswordChange::Set { value } => {
                        if value.is_empty() {
                            return Err(AppError::Validation(
                                "The SSH password is empty. Leave it unchanged or remove the saved one"
                                    .into(),
                            ));
                        }
                        self.secret_set(&ssh_account(&config.id), &value).await?;
                        true
                    }
                    PasswordChange::Clear => {
                        self.secret_delete(&ssh_account(&config.id)).await?;
                        false
                    }
                };
            }
        }

        let had_ssl_secret = previous
            .as_ref()
            .and_then(|p| p.ssl_files.as_ref())
            .is_some_and(|f| f.has_key_secret);
        match config.ssl_files.as_mut() {
            // No client key (or no files at all): a passphrase kept for it would be for nothing.
            None => {
                if had_ssl_secret {
                    self.secret_delete(&ssl_key_account(&config.id)).await?;
                }
            }
            Some(files) if files.client_key.is_none() => {
                if had_ssl_secret {
                    self.secret_delete(&ssl_key_account(&config.id)).await?;
                }
                files.has_key_secret = false;
            }
            Some(files) => {
                files.has_key_secret = match ssl_key_secret {
                    PasswordChange::Keep => had_ssl_secret,
                    PasswordChange::Set { value } => {
                        if value.is_empty() {
                            return Err(AppError::Validation(
                                "The key passphrase is empty. Leave it unchanged or remove the saved one"
                                    .into(),
                            ));
                        }
                        self.secret_set(&ssl_key_account(&config.id), &value)
                            .await?;
                        true
                    }
                    PasswordChange::Clear => {
                        self.secret_delete(&ssl_key_account(&config.id)).await?;
                        false
                    }
                };
            }
        }

        match items.iter_mut().find(|c| c.id == config.id) {
            Some(slot) => *slot = config.clone(),
            None => items.push(config.clone()),
        }
        if let Err(e) = self.store.write(&items) {
            if is_new {
                if config.ssl_files.as_ref().is_some_and(|f| f.has_key_secret) {
                    let _ = self.secret_delete(&ssl_key_account(&config.id)).await;
                }
                // Don't leave a password behind for a connection that was never saved.
                if config.has_password {
                    let _ = self.secret_delete(&config.id).await;
                }
                if config.ssh.as_ref().is_some_and(|s| s.has_secret) {
                    let _ = self.secret_delete(&ssh_account(&config.id)).await;
                }
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
        if config.ssh.as_ref().is_some_and(|s| s.has_secret) {
            self.secret_delete(&ssh_account(id)).await?;
        }
        if config.ssl_files.as_ref().is_some_and(|f| f.has_key_secret) {
            self.secret_delete(&ssl_key_account(id)).await?;
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

        if let Some(ssh) = copy.ssh.as_mut().filter(|s| s.has_secret) {
            match self.secret_get(&ssh_account(&original.id)).await? {
                Some(secret) => self.secret_set(&ssh_account(&copy.id), &secret).await?,
                None => ssh.has_secret = false,
            }
        }

        if let Some(files) = copy.ssl_files.as_mut().filter(|f| f.has_key_secret) {
            match self.secret_get(&ssl_key_account(&original.id)).await? {
                Some(secret) => {
                    self.secret_set(&ssl_key_account(&copy.id), &secret).await?;
                }
                None => files.has_key_secret = false,
            }
        }

        items.push(copy.clone());
        if let Err(e) = self.store.write(&items) {
            if copy.ssl_files.as_ref().is_some_and(|f| f.has_key_secret) {
                let _ = self.secret_delete(&ssl_key_account(&copy.id)).await;
            }
            if copy.has_password {
                let _ = self.secret_delete(&copy.id).await;
            }
            if copy.ssh.as_ref().is_some_and(|s| s.has_secret) {
                let _ = self.secret_delete(&ssh_account(&copy.id)).await;
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
        let (config, password, _) = self
            .resolve_for_test_with_ssh(config, password, PasswordChange::Keep)
            .await?;
        Ok((config, password))
    }

    /// [`ConnectionManager::resolve_for_test`], with the SSH password or passphrase as well.
    pub async fn resolve_for_test_with_ssh(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
        ssh_secret: PasswordChange,
    ) -> AppResult<(ConnectionConfig, Option<String>, Option<String>)> {
        let (config, secrets) = self
            .resolve_for_test_all(config, password, ssh_secret, PasswordChange::Keep)
            .await?;
        Ok((config, secrets.password, secrets.ssh))
    }

    /// [`ConnectionManager::resolve_for_test`], with every secret a connection can have.
    pub async fn resolve_for_test_all(
        &self,
        config: ConnectionConfig,
        password: PasswordChange,
        ssh_secret: PasswordChange,
        ssl_key_secret: PasswordChange,
    ) -> AppResult<(ConnectionConfig, TestSecrets)> {
        let config = normalize(config)?;
        let ssl_key = match ssl_key_secret {
            PasswordChange::Set { value } => Some(value),
            PasswordChange::Clear => None,
            PasswordChange::Keep if config.id.is_empty() => None,
            PasswordChange::Keep => match self.ssl_key_secret(&config.id).await {
                Ok(secret) => secret,
                Err(AppError::ConnectionNotFound(_)) => None,
                Err(e) => return Err(e),
            },
        };
        let ssh_secret = match ssh_secret {
            PasswordChange::Set { value } => Some(value),
            PasswordChange::Clear => None,
            PasswordChange::Keep if config.id.is_empty() => None,
            PasswordChange::Keep => match self.ssh_secret(&config.id).await {
                Ok(secret) => secret,
                Err(AppError::ConnectionNotFound(_)) => None,
                Err(e) => return Err(e),
            },
        };
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
        Ok((
            config,
            TestSecrets {
                password,
                ssh: ssh_secret,
                ssl_key,
            },
        ))
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
    if let Some(ssh) = config.ssh.take() {
        config.ssh = Some(normalize_ssh(ssh)?);
    }
    if let Some(files) = config.ssl_files.take() {
        config.ssl_files = normalize_ssl_files(files)?;
    }
    if config.name.is_empty() {
        config.name = format!("{} @ {}", config.database, config.host);
    }
    Ok(config)
}

/// Trim the paths and drop the ones left empty; no files at all is the same as none. A client
/// certificate and its key come together.
fn normalize_ssl_files(mut files: SslFiles) -> AppResult<Option<SslFiles>> {
    let clean = |path: Option<String>| path.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
    files.root_cert = clean(files.root_cert.take());
    files.client_cert = clean(files.client_cert.take());
    files.client_key = clean(files.client_key.take());
    if files.client_cert.is_some() != files.client_key.is_some() {
        return Err(AppError::Validation(
            "A client certificate and its key go together: give both, or neither".into(),
        ));
    }
    if files.root_cert.is_none() && files.client_cert.is_none() {
        return Ok(None);
    }
    Ok(Some(files))
}

fn normalize_ssh(mut ssh: SshConfig) -> AppResult<SshConfig> {
    ssh.host = ssh.host.trim().to_owned();
    ssh.user = ssh.user.trim().to_owned();
    if ssh.host.is_empty() {
        return Err(AppError::Validation("The SSH host is required".into()));
    }
    if ssh.port == 0 {
        return Err(AppError::Validation(
            "The SSH port must be between 1 and 65535".into(),
        ));
    }
    if ssh.user.is_empty() {
        return Err(AppError::Validation("The SSH user is required".into()));
    }
    if let SshAuth::PrivateKey { path } = &mut ssh.auth {
        *path = path.trim().to_owned();
        if path.is_empty() {
            return Err(AppError::Validation(
                "Give the path of the private key file".into(),
            ));
        }
    }
    // A key or password that is no longer used would be a secret kept for nothing.
    if ssh.auth == SshAuth::Agent {
        ssh.has_secret = false;
    }
    Ok(ssh)
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
