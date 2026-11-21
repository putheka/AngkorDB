//! Local persistence (ANG-8 D10).
//!
//! - `connections` — saved connections as JSON in the app data dir (never contains passwords)
//! - `secrets`     — passwords in the macOS Keychain, keyed by connection id
//! - `history`     — query history and saved queries in SQLite (ANG-33)
//! - `workspace`   — tabs, query text and table views per connection, and what to do at launch (ANG-50)
//! - `manager`     — `ConnectionManager`: validation + keeps the two in sync

pub mod connections;
pub mod history;
pub mod manager;
pub mod secrets;
pub mod workspace;

pub use manager::ConnectionManager;
