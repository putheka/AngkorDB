use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};

/// Keychain "service" name of every secret we store; the "account" is the connection id.
pub const KEYCHAIN_SERVICE: &str = "com.angkordb.app";

/// Where passwords live. Blocking: callers run it on a blocking thread, because the
/// Keychain may show a permission prompt.
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> AppResult<Option<String>>;
    fn set(&self, id: &str, secret: &str) -> AppResult<()>;
    /// Deleting a secret that doesn't exist is not an error.
    fn delete(&self, id: &str) -> AppResult<()>;
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemorySecrets {
    secrets: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.secrets.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        Ok(self.lock().get(id).cloned())
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        self.lock().insert(id.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        self.lock().remove(id);
        Ok(())
    }
}

/// macOS login Keychain, as generic passwords.
#[cfg(target_os = "macos")]
pub struct KeychainSecrets {
    store: Arc<keyring_core::CredentialStore>,
    service: String,
}

#[cfg(target_os = "macos")]
impl KeychainSecrets {
    pub fn new() -> AppResult<Self> {
        Self::with_service(KEYCHAIN_SERVICE)
    }

    /// Use another service name, e.g. in tests so real credentials are never touched.
    pub fn with_service(service: &str) -> AppResult<Self> {
        let store = apple_native_keyring_store::keychain::Store::new().map_err(keychain_error)?;
        Ok(Self {
            store,
            service: service.to_owned(),
        })
    }

    fn entry(&self, id: &str) -> AppResult<keyring_core::Entry> {
        self.store
            .build(&self.service, id, None)
            .map_err(keychain_error)
    }
}

#[cfg(target_os = "macos")]
fn keychain_error(e: keyring_core::Error) -> AppError {
    AppError::Keychain(e.to_string())
}

#[cfg(target_os = "macos")]
impl SecretStore for KeychainSecrets {
    fn get(&self, id: &str) -> AppResult<Option<String>> {
        match self.entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(e)),
        }
    }

    fn set(&self, id: &str, secret: &str) -> AppResult<()> {
        self.entry(id)?.set_password(secret).map_err(keychain_error)
    }

    fn delete(&self, id: &str) -> AppResult<()> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(e)),
        }
    }
}

/// Stand-in on other platforms (CI builds on Linux). The app itself is macOS-only.
#[cfg(not(target_os = "macos"))]
pub struct UnavailableSecrets;

#[cfg(not(target_os = "macos"))]
impl SecretStore for UnavailableSecrets {
    fn get(&self, _: &str) -> AppResult<Option<String>> {
        Err(unavailable())
    }
    fn set(&self, _: &str, _: &str) -> AppResult<()> {
        Err(unavailable())
    }
    fn delete(&self, _: &str) -> AppResult<()> {
        Err(unavailable())
    }
}

#[cfg(not(target_os = "macos"))]
fn unavailable() -> AppError {
    AppError::Keychain("the macOS Keychain is only available on macOS".into())
}

/// The secret store the app uses.
pub fn default_secret_store() -> AppResult<Arc<dyn SecretStore>> {
    #[cfg(target_os = "macos")]
    {
        Ok(Arc::new(KeychainSecrets::new()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Arc::new(UnavailableSecrets))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let store = MemorySecrets::default();
        assert_eq!(store.get("a").unwrap(), None);
        store.set("a", "one").unwrap();
        store.set("a", "two").unwrap();
        assert_eq!(store.get("a").unwrap().as_deref(), Some("two"));
        store.delete("a").unwrap();
        store.delete("a").unwrap(); // deleting twice is fine
        assert_eq!(store.get("a").unwrap(), None);
    }

    /// Touches the real login Keychain (under a test-only service name), so it is opt-in:
    /// `cargo test keychain_round_trip -- --ignored`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "uses the real macOS Keychain"]
    fn keychain_round_trip() {
        let store = KeychainSecrets::with_service("com.angkordb.app.test").unwrap();
        let id = format!("test-{}", std::process::id());

        assert_eq!(store.get(&id).unwrap(), None);
        store.set(&id, "pässwörd with spaces & ünïcode 🔑").unwrap();
        assert_eq!(
            store.get(&id).unwrap().as_deref(),
            Some("pässwörd with spaces & ünïcode 🔑")
        );
        store.set(&id, "changed").unwrap();
        assert_eq!(store.get(&id).unwrap().as_deref(), Some("changed"));
        store.delete(&id).unwrap();
        assert_eq!(store.get(&id).unwrap(), None);
        store.delete(&id).unwrap(); // already gone
    }
}
