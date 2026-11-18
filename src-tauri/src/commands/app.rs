use serde::Serialize;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// Smoke-test command: proves the React ⇄ Rust bridge works.
///
/// Reads compile-time constants rather than an `AppHandle`, so the command is not tied to
/// one Tauri runtime (tests call it through the mock runtime).
#[tauri::command]
#[specta::specta]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}
