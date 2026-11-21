use serde::Serialize;
use tauri::State;

use crate::state::AppState;

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

/// The page says how many tabs have staged edits. While there are any, quitting and closing the
/// window ask the page first, and the window shows the macOS "edited" dot.
#[tauri::command]
#[specta::specta]
pub fn set_unsaved_changes(state: State<'_, AppState>, count: u32) {
    state.set_unsaved_changes(count);
}

/// Quit the app. Called by the page once the person has decided about their unsaved edits.
#[tauri::command]
#[specta::specta]
pub fn quit_app(state: State<'_, AppState>) {
    state.quit();
}
