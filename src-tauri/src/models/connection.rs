use std::fmt;

use serde::{Deserialize, Serialize};

/// Saved connection settings. The password is NOT stored here — it lives in the macOS Keychain.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    /// Empty when creating a connection; the backend assigns an id.
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl_mode: SslMode,
    pub color: ColorTag,
    pub group: Option<String>,
    pub safe_mode: SafeMode,
    /// Stop any statement that runs longer than this many milliseconds (`statement_timeout`).
    /// `None` or `0`: no limit. Missing in files saved before ANG-31.
    #[serde(default)]
    pub statement_timeout_ms: Option<u32>,
    /// True when a password is saved in the Keychain. Maintained by the backend, ignored on input.
    /// Kept here so listing connections never has to touch the Keychain.
    pub has_password: bool,
    /// Reach the database through an SSH server (ANG-43). `None`: connect directly. Missing in
    /// files saved before ANG-43.
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Certificate files for TLS (ANG-44). `None`: the system's trusted roots, no client
    /// certificate. Missing in files saved before ANG-44.
    #[serde(default)]
    pub ssl_files: Option<SslFiles>,
}

/// Files for the TLS handshake. Only the paths are stored; the files are read when connecting.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SslFiles {
    /// The root certificate (CA) the server's certificate must be signed by, as PEM. When given,
    /// it is the only one trusted: the system's roots are not.
    pub root_cert: Option<String>,
    /// The certificate the server may ask the client for, as PEM.
    pub client_cert: Option<String>,
    /// Its private key, as PEM (PKCS#8, PKCS#1 or SEC1, plain or protected by a passphrase).
    pub client_key: Option<String>,
    /// True when the key's passphrase is saved in the Keychain. Maintained by the backend,
    /// ignored on input.
    #[serde(default)]
    pub has_key_secret: bool,
}

/// An SSH server to tunnel through. `host`/`port` of the connection are then as the SSH server
/// sees them (`localhost` is the SSH server itself).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// True when the SSH password, or the key's passphrase, is saved in the Keychain.
    /// Maintained by the backend, ignored on input.
    #[serde(default)]
    pub has_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshAuth {
    /// The SSH account's password (kept in the Keychain).
    Password,
    /// A private key file (its passphrase, if it has one, is kept in the Keychain).
    PrivateKey { path: String },
    /// Whatever keys the running ssh-agent (`SSH_AUTH_SOCK`) holds.
    Agent,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ColorTag {
    #[default]
    None,
    Green,
    Yellow,
    Red,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SafeMode {
    #[default]
    Off,
    Confirm,
    TouchId,
    ReadOnly,
}

/// What "Test SSH" found out.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    /// `SHA256:…` of the SSH server's host key, which is in known_hosts.
    pub fingerprint: String,
    pub key_type: String,
    /// The SSH server could open a connection to the database's host and port.
    pub reaches_database: bool,
    /// Why not, when it could not.
    pub database_problem: Option<String>,
}

/// What to do with the saved password when saving or testing a connection.
#[derive(Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PasswordChange {
    /// Leave the saved password as it is.
    Keep,
    /// Save this password in the Keychain.
    Set { value: String },
    /// Remove the saved password.
    Clear,
}

// Never print the password, even in debug logs.
impl fmt::Debug for PasswordChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Keep => f.write_str("Keep"),
            Self::Set { .. } => f.write_str("Set { value: <redacted> }"),
            Self::Clear => f.write_str("Clear"),
        }
    }
}

/// Result of a successful connect or connection test.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    /// e.g. `16.4`
    pub server_version: String,
    /// Time to connect and run the first query.
    pub latency_ms: u32,
}

/// Fields extracted from a `postgres://` URL, used to fill the connection form.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedConnectionUrl {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: String,
    pub ssl_mode: SslMode,
}

impl fmt::Debug for ParsedConnectionUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ParsedConnectionUrl")
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("database", &self.database)
            .field("ssl_mode", &self.ssl_mode)
            .finish()
    }
}
