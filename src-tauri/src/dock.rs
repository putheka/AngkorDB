//! The Dock icon's menu: the connections opened last, and "New Connection…".
//!
//! macOS asks for the menu each time it is shown, so it is built from what is saved then. The
//! page does what a choice means: [`OPEN_CONNECTION`] opens a connection, and "New Connection…"
//! is the menu bar's command of the same name.

use angkordb_macos_window::{DockChoice, DockEntry, DockHandlers, install_dock_menu};
use tauri::{AppHandle, Manager, Runtime};

use crate::menu::MENU_COMMAND;
use crate::state::AppState;
use crate::windows::{self, DockOpen, Start, plan_dock_open};

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

/// Give the Dock icon its menu. Call from the main thread once the app is running.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let for_entries = app.clone();
    let for_choice = app.clone();
    let installed = install_dock_menu(DockHandlers {
        entries: Box::new(move || entries(&for_entries)),
        chosen: Box::new(move |choice| choose(&for_choice, choice)),
    });
    if !installed {
        eprintln!("the Dock menu is not available");
    }
}

/// What a choice in the Dock menu does. A connection opens in a window that has nothing open, or
/// in a new one: it never takes over a window that is in use.
fn choose<R: Runtime>(app: &AppHandle<R>, choice: DockChoice) {
    let state = app.state::<AppState>();
    let registry = state.windows();
    match choice {
        DockChoice::Open(id) => match plan_dock_open(
            &registry.snapshot(),
            registry.last_focused().as_deref(),
            &id,
        ) {
            DockOpen::Focus(label) => windows::focus(app, &label),
            DockOpen::Use(label) => {
                windows::focus(app, &label);
                windows::emit_to(app, &label, OPEN_CONNECTION, id);
            }
            DockOpen::New => windows::open(app, registry, Start::Connection(id)),
        },
        DockChoice::New => {
            // The form is in the window in use; "File ▸ New Connection…" does the same.
            if let Some(label) = windows::target(app, registry) {
                windows::focus(app, &label);
                windows::emit_to(app, &label, MENU_COMMAND, NEW_CONNECTION.to_owned());
            }
        }
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
