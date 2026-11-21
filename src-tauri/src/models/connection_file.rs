//! Connections in a file to move between Macs (ANG-48). No secret is ever in it: not the
//! password, not the SSH password or key passphrase, not the passphrase of a TLS client key.

use serde::{Deserialize, Serialize};

use crate::models::connection::{
    ColorTag, ConnectionConfig, SafeMode, SshConfig, SslFiles, SslMode,
};

pub const FILE_KIND: &str = "angkordb-connections";
pub const FILE_VERSION: u32 = 1;

/// A connection as it is written in the file and shown before it is imported.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharedConnection {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl_mode: SslMode,
    pub color: ColorTag,
    pub group: Option<String>,
    pub safe_mode: SafeMode,
    #[serde(default)]
    pub statement_timeout_ms: Option<u32>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    #[serde(default)]
    pub ssl_files: Option<SslFiles>,
    /// The connection had a password saved: the importer is asked for one.
    #[serde(default)]
    pub needs_password: bool,
    #[serde(default)]
    pub needs_ssh_secret: bool,
    #[serde(default)]
    pub needs_ssl_key_secret: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFile {
    pub kind: String,
    pub version: u32,
    pub connections: Vec<SharedConnection>,
}

impl SharedConnection {
    /// What is written for a saved connection: everything but its id and its secrets, and a
    /// note of which secrets it had.
    pub fn of(config: &ConnectionConfig) -> Self {
        Self {
            name: config.name.clone(),
            host: config.host.clone(),
            port: config.port,
            user: config.user.clone(),
            database: config.database.clone(),
            ssl_mode: config.ssl_mode,
            color: config.color,
            group: config.group.clone(),
            safe_mode: config.safe_mode,
            statement_timeout_ms: config.statement_timeout_ms,
            needs_password: config.has_password,
            needs_ssh_secret: config.ssh.as_ref().is_some_and(|s| s.has_secret),
            needs_ssl_key_secret: config.ssl_files.as_ref().is_some_and(|f| f.has_key_secret),
            ssh: config.ssh.clone().map(|s| SshConfig {
                has_secret: false,
                ..s
            }),
            ssl_files: config.ssl_files.clone().map(|f| SslFiles {
                has_key_secret: false,
                ..f
            }),
        }
    }

    /// A new connection (no id yet, no secrets saved).
    pub fn into_config(self) -> ConnectionConfig {
        ConnectionConfig {
            id: String::new(),
            name: self.name,
            host: self.host,
            port: self.port,
            user: self.user,
            database: self.database,
            ssl_mode: self.ssl_mode,
            color: self.color,
            group: self.group,
            safe_mode: self.safe_mode,
            statement_timeout_ms: self.statement_timeout_ms,
            has_password: false,
            ssh: self.ssh.map(|s| SshConfig {
                has_secret: false,
                ..s
            }),
            ssl_files: self.ssl_files.map(|f| SslFiles {
                has_key_secret: false,
                ..f
            }),
        }
    }
}

/// One connection of the file to import, with the secrets the person typed for it.
#[derive(Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    /// Its place in the file (0-based).
    pub index: u32,
    pub password: Option<String>,
    pub ssh_secret: Option<String>,
    pub ssl_key_secret: Option<String>,
}

// Never print a password, even in debug logs.
impl std::fmt::Debug for ImportEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportEntry")
            .field("index", &self.index)
            .finish_non_exhaustive()
    }
}
