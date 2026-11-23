use serde::Serialize;
use tauri::State;

use crate::menu::MenuUpdate;
use crate::state::AppState;
use crate::windows::Start;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    /// From `tauri.conf.json`.
    pub version: String,
    /// The git commit the program was built from (`-dirty` when it had uncommitted changes).
    pub build: String,
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
        version: env!("ANGKORDB_VERSION").to_owned(),
        build: env!("ANGKORDB_BUILD").to_owned(),
    }
}

/// The page of a window says how many of its tabs have staged edits. While any window has some,
/// quitting asks first, closing that window asks, and the window shows the macOS "edited" dot.
#[tauri::command]
#[specta::specta]
pub fn set_unsaved_changes(state: State<'_, AppState>, label: String, count: u32) {
    state.set_unsaved_changes(&label, count);
}

/// Go on quitting. Called by the page of a window once the person has decided about its unsaved
/// edits; other windows with edits are asked next, then the app exits.
#[tauri::command]
#[specta::specta]
pub fn quit_app(state: State<'_, AppState>, label: String) {
    state.quit(&label);
}

/// Close a window. Called by its page once the person has decided about its unsaved edits.
#[tauri::command]
#[specta::specta]
pub fn close_window(state: State<'_, AppState>, label: String) {
    state.close_window(&label);
}

/// Open another window (⇧⌘N): on the welcome screen, on the form for a new connection, or on
/// this connection. A connection that another window has open brings that window forward.
#[tauri::command]
#[specta::specta]
pub fn open_window(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    new_connection: bool,
) {
    let start = match connection_id {
        Some(id) => Start::Connection(id),
        None if new_connection => Start::NewConnection,
        None => Start::Welcome,
    };
    state.open_window(start);
}

/// A window is about to open a connection. `false` when another window has it open (that window
/// is brought forward): a connection is open in one window at a time.
#[tauri::command]
#[specta::specta]
pub fn claim_connection(state: State<'_, AppState>, label: String, connection_id: String) -> bool {
    state.claim_connection(&label, &connection_id)
}

/// The window has no connection any more (it disconnected, or the connect failed).
#[tauri::command]
#[specta::specta]
pub fn release_connection(state: State<'_, AppState>, label: String) {
    state.release_connection(&label);
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
pub fn update_menu(state: State<'_, AppState>, label: String, updates: Vec<MenuUpdate>) {
    state.update_menu(&label, updates);
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_build_names_a_commit() {
        let build = env!("ANGKORDB_BUILD");
        let commit = build.strip_suffix("-dirty").unwrap_or(build);
        assert!(
            commit == "unknown"
                || (commit.len() >= 7 && commit.chars().all(|c| c.is_ascii_hexdigit())),
            "{build}"
        );
    }
}
