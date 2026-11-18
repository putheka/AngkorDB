//! Local persistence (ANG-8 D10).
//!
//! - `connections` — saved connections as JSON in the app data dir (never contains passwords)
//! - `secrets`     — passwords in the macOS Keychain, keyed by connection id
//! - `manager`     — `ConnectionManager`: validation + keeps the two in sync

pub mod connections;
pub mod manager;
pub mod secrets;

pub use manager::ConnectionManager;
