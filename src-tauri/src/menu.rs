//! The macOS menu bar (ANG-55).
//!
//! Every item that is not a standard macOS one is named after a command of the page's shortcut
//! registry (`src/features/shortcuts/commands.ts`): choosing it sends the page [`MENU_COMMAND`]
//! with that id, and the page runs the command. The keys shown next to an item, and whether it is
//! enabled, are the page's to say (`update_menu`): the keys follow what the person set in
//! Settings, and an item is grey while there is nothing for it to do (no query tab open, ...).
//!
//! A menu key equivalent is handled before the page ever sees the key. So ⌘W would close the whole
//! window instead of the front tab, and ⌘, would be lost: those two keys are fixed in the menu.

use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Event name carrying the id of the command to run.
pub const MENU_COMMAND: &str = "menu-command";
/// Menu item id of "Close Tab", whose key (⌘W) is fixed.
pub const CLOSE_TAB: &str = "tabs.close";
/// Menu item id of "Settings…" (⌘,); the window is opened by Rust itself.
pub const SETTINGS: &str = "app.settings";

/// What the page says about one menu item: its keys and whether it can be chosen now.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuUpdate {
    /// The command's id, which is the menu item's id.
    pub id: String,
    /// In Tauri's spelling (`Shift+Cmd+E`); `None`: no key.
    pub accelerator: Option<String>,
    pub enabled: bool,
}

/// An item that the page enables and gives keys to: grey until it says so.
fn item<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, false, None::<&str>)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let sep = || PredefinedMenuItem::separator(app);

    // The two fixed keys.
    let settings = MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let close_tab = MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?;

    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &sep()?,
            &settings,
            &item(app, "app.checkUpdates", "Check for Updates…")?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "app.newConnection", "New Connection…")?,
            &item(app, "tabs.new", "New Query Tab")?,
            &item(app, "app.find", "Open Anything…")?,
            &sep()?,
            &item(app, "file.import", "Import…")?,
            &item(app, "file.export", "Export…")?,
            &item(app, "file.backup", "Back Up…")?,
            &item(app, "file.restore", "Restore…")?,
            &sep()?,
            &close_tab,
        ],
    )?;

    let copy_as = Submenu::with_items(
        app,
        "Copy As",
        true,
        &[
            &item(app, "grid.copy.csv", "CSV")?,
            &item(app, "grid.copy.json", "JSON")?,
            &item(app, "grid.copy.markdown", "Markdown Table")?,
            &item(app, "grid.copy.insert", "INSERT Statements")?,
            &item(app, "grid.copy.update", "UPDATE Statements")?,
        ],
    )?;
    // Text fields need the standard items for ⌘C, ⌘V, ⌘Z and friends to work.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep()?,
            &copy_as,
            &sep()?,
            &item(app, "edit.find", "Find…")?,
        ],
    )?;

    let theme = Submenu::with_items(
        app,
        "Theme",
        true,
        &[
            &item(app, "app.theme.system", "Match macOS")?,
            &item(app, "app.theme.light", "Light")?,
            &item(app, "app.theme.dark", "Dark")?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, "app.sidebar", "Toggle Sidebar")?,
            &item(app, "table.mode", "Switch Rows / Structure")?,
            &item(app, "table.detail", "Row Details")?,
            &sep()?,
            &theme,
            &sep()?,
            &item(app, "view.zoomIn", "Zoom In")?,
            &item(app, "view.zoomOut", "Zoom Out")?,
            &item(app, "view.zoomReset", "Actual Size")?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let query_menu = Submenu::with_items(
        app,
        "Query",
        true,
        &[
            &item(app, "editor.run", "Run Current")?,
            &item(app, "editor.runAll", "Run All")?,
            &item(app, "query.stop", "Cancel")?,
            &sep()?,
            &item(app, "query.explain", "Explain")?,
            &item(app, "query.analyze", "Explain Analyze")?,
            &sep()?,
            &item(app, "editor.format", "Format")?,
            &item(app, "query.save", "Save Query…")?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &item(app, "tabs.next", "Next Tab")?,
            &item(app, "tabs.previous", "Previous Tab")?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item(app, "app.shortcuts", "Keyboard Shortcuts")?],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &query_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Forward a chosen item to the page (or open the settings window, which is Rust's to open).
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == SETTINGS {
        crate::settings::open(app);
    } else if !id.is_empty() {
        // Only fails if no window is listening, in which case there is nothing to run.
        let _ = app.emit(MENU_COMMAND, id.to_owned());
    }
}

/// Every custom item of the menu (those named after commands), submenus included.
pub fn command_ids<R: Runtime>(menu: &Menu<R>) -> Vec<String> {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, out: &mut Vec<String>) {
        for kind in items {
            match kind {
                MenuItemKind::MenuItem(m) => out.push(m.id().0.clone()),
                MenuItemKind::Submenu(s) => {
                    if let Ok(inner) = s.items() {
                        walk(inner, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut ids = Vec::new();
    if let Ok(items) = menu.items() {
        walk(items, &mut ids);
    }
    ids
}

/// Apply what the page says to the items it names: their keys and whether they can be chosen.
/// Unknown ids and keys the menu can't spell are skipped. The two fixed items keep their key.
pub fn apply_updates<R: Runtime>(menu: &Menu<R>, updates: &[MenuUpdate]) {
    fn find<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> Option<MenuItem<R>> {
        for kind in items {
            match kind {
                MenuItemKind::MenuItem(m) if m.id().0 == id => return Some(m),
                MenuItemKind::Submenu(s) => {
                    if let Some(found) = s.items().ok().and_then(|inner| find(inner, id)) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        None
    }
    for update in updates {
        let Some(found) = menu.items().ok().and_then(|items| find(items, &update.id)) else {
            continue;
        };
        let fixed = update.id == CLOSE_TAB || update.id == SETTINGS;
        if !fixed {
            // A key the menu can't read is no key: better none than a stale one.
            let set = found.set_accelerator(update.accelerator.as_deref());
            if set.is_err() {
                let _ = found.set_accelerator(None::<&str>);
            }
            let _ = found.set_enabled(update.enabled);
        }
    }
}
