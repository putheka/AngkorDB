//! The Dock icon's menu: the connections opened last, and "New Connection…".
//!
//! macOS asks for the menu each time it is shown, so it is built from what is saved then. The
//! page does what a choice means: [`OPEN_CONNECTION`] opens a connection, and "New Connection…"
//! is the menu bar's command of the same name.

use angkordb_macos_window::{DockChoice, DockEntry, DockHandlers, install_dock_menu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::menu::MENU_COMMAND;
use crate::state::AppState;

/// Event name the page listens for: the id of the connection to open.
pub const OPEN_CONNECTION: &str = "dock-open-connection";

/// The registry command that shows the form for a new connection.
const NEW_CONNECTION: &str = "app.newConnection";

/// The recent connections that still exist, latest first, as (id, name) pairs.
pub fn recent_entries(recent: &[String], known: &[(String, String)]) -> Vec<(String, String)> {
    recent
        .iter()
        .filter_map(|id| known.iter().find(|(known_id, _)| known_id == id).cloned())
        .collect()
}

fn entries<R: Runtime>(app: &AppHandle<R>) -> Vec<DockEntry> {
    let state = app.state::<AppState>();
    // A menu that can't be filled is a menu with "New Connection…" only.
    let known: Vec<(String, String)> = state
        .connections()
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();
    recent_entries(&state.workspaces().recent_connections(), &known)
        .into_iter()
        .map(|(id, title)| DockEntry { id, title })
        .collect()
}

/// Bring the main window forward: a Dock click may come while it is hidden or minimized.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Give the Dock icon its menu. Call from the main thread once the app is running.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let for_entries = app.clone();
    let for_choice = app.clone();
    let installed = install_dock_menu(DockHandlers {
        entries: Box::new(move || entries(&for_entries)),
        chosen: Box::new(move |choice| {
            show_main(&for_choice);
            // Only fails if no window is listening, in which case there is nothing to run.
            let _ = match choice {
                DockChoice::Open(id) => for_choice.emit(OPEN_CONNECTION, id),
                DockChoice::New => for_choice.emit(MENU_COMMAND, NEW_CONNECTION.to_owned()),
            };
        }),
    });
    if !installed {
        eprintln!("the Dock menu is not available");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> Vec<(String, String)> {
        vec![("a".into(), "prod".into()), ("b".into(), "dev".into())]
    }

    #[test]
    fn recent_connections_keep_their_order_and_drop_deleted_ones() {
        let recent = ["b".to_owned(), "gone".to_owned(), "a".to_owned()];
        assert_eq!(
            recent_entries(&recent, &known()),
            [("b".into(), "dev".into()), ("a".into(), "prod".into())]
        );
        assert!(recent_entries(&[], &known()).is_empty());
    }
}
