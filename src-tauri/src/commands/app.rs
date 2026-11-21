use serde::Serialize;
use tauri::State;

use crate::menu::MenuUpdate;
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

/// Show the settings window (⌘,), opening it if it isn't open.
#[tauri::command]
#[specta::specta]
pub fn open_settings(state: State<'_, AppState>) {
    state.open_settings();
}

/// The page reports the "Confirm on quit" setting: with it on, quitting asks even when nothing
/// is unsaved.
#[tauri::command]
#[specta::specta]
pub fn set_confirm_on_quit(state: State<'_, AppState>, confirm: bool) {
    state.set_confirm_quit(confirm);
}

/// The page says which menu items have keys now and which can be chosen (ANG-55). Called when the
/// person changes a shortcut and when a screen opens or closes.
#[tauri::command]
#[specta::specta]
pub fn update_menu(state: State<'_, AppState>, updates: Vec<MenuUpdate>) {
    state.update_menu(updates);
}
