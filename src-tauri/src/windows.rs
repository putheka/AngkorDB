//! Several windows, each with the connections it has open.
//!
//! Every window shows the same page and has its own connections (the strip on its left), tabs and
//! edits. This module knows which window has which connections ([`WindowRegistry`], filled by the pages), who gets
//! asked when the app is quit, and who gets a Dock click. The plans are plain functions so they
//! can be tested without a window; [`open`] and the other `AppHandle` functions do the work.
//!
//! A connection is open in one window at a time: its session on the backend is one per
//! connection, so a second window on it would close the first one's. Asking for a connection
//! that another window has brings that window forward instead.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use crate::menu::MenuUpdate;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// The window made by the app's configuration; it comes back at launch with the last connection.
pub const MAIN_LABEL: &str = "main";

/// Labels of the windows made by [`open`] start with this.
const EXTRA_PREFIX: &str = "window-";

/// Event name for the page of a window: ⌘Q asks about its unsaved edits.
pub const QUIT_REQUESTED: &str = "quit-requested";
/// Event name for the page of a window: its close button was pressed while it has unsaved edits.
pub const CLOSE_REQUESTED: &str = "window-close-requested";

/// Whether this window shows a workspace (the settings window does not).
pub fn is_workspace(label: &str) -> bool {
    label == MAIN_LABEL || label.starts_with(EXTRA_PREFIX)
}

/// What the page of a window says about it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    /// The connections open (or being opened) in the window.
    pub connections: BTreeSet<String>,
    /// How many of its tabs have staged edits.
    pub unsaved: u32,
}

#[derive(Default)]
struct Inner {
    windows: HashMap<String, WindowInfo>,
    last_focused: Option<String>,
    /// What each page last said about the menu items. The menu shows the one of the window in
    /// use; the others wait for their turn.
    menus: HashMap<String, Vec<MenuUpdate>>,
    /// For naming the next window.
    made: u32,
}

/// What each window has open and how many unsaved edits it has.
#[derive(Default)]
pub struct WindowRegistry {
    inner: Mutex<Inner>,
}

/// What happens when the connection is claimed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// The window has it now.
    Granted,
    /// Another window has it: bring that one forward.
    HeldBy(String),
}

impl WindowRegistry {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        // A poisoned lock only means another thread panicked; the data is still sound.
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut inner)
    }

    pub fn set_unsaved(&self, label: &str, count: u32) {
        self.with(|i| i.windows.entry(label.to_owned()).or_default().unsaved = count);
    }

    pub fn unsaved(&self, label: &str) -> u32 {
        self.with(|i| i.windows.get(label).map_or(0, |w| w.unsaved))
    }

    /// Unsaved tabs in all windows.
    pub fn total_unsaved(&self) -> u32 {
        self.with(|i| i.windows.values().map(|w| w.unsaved).sum())
    }

    /// Let `label` have `connection`, unless another window has it.
    pub fn claim(&self, label: &str, connection: &str) -> Claim {
        self.with(|i| {
            if let Some((other, _)) = i
                .windows
                .iter()
                .find(|(l, w)| l.as_str() != label && w.connections.contains(connection))
            {
                return Claim::HeldBy(other.clone());
            }
            i.windows
                .entry(label.to_owned())
                .or_default()
                .connections
                .insert(connection.to_owned());
            Claim::Granted
        })
    }

    /// The window no longer has this connection open.
    pub fn release(&self, label: &str, connection: &str) {
        self.with(|i| {
            if let Some(w) = i.windows.get_mut(label) {
                w.connections.remove(connection);
            }
        });
    }

    /// The window that has this connection.
    pub fn holder(&self, connection: &str) -> Option<String> {
        self.with(|i| {
            i.windows
                .iter()
                .find(|(_, w)| w.connections.contains(connection))
                .map(|(l, _)| l.clone())
        })
    }

    /// The window is gone. Returns the connections it had, which nobody uses now.
    pub fn forget(&self, label: &str) -> Vec<String> {
        self.with(|i| {
            if i.last_focused.as_deref() == Some(label) {
                i.last_focused = None;
            }
            i.menus.remove(label);
            i.windows
                .remove(label)
                .map(|w| w.connections.into_iter().collect())
                .unwrap_or_default()
        })
    }

    pub fn note_focus(&self, label: &str) {
        self.with(|i| {
            i.windows.entry(label.to_owned()).or_default();
            i.last_focused = Some(label.to_owned());
        });
    }

    /// A page says how the menu should look. Returns whether this window is the one in use (then
    /// the menu changes now); otherwise it is kept for when the window is.
    pub fn remember_menu(&self, label: &str, updates: Vec<MenuUpdate>) -> bool {
        self.with(|i| {
            i.menus.insert(label.to_owned(), updates);
            i.last_focused.as_deref().is_none_or(|l| l == label)
        })
    }

    /// What the page of this window last said about the menu.
    pub fn menu_of(&self, label: &str) -> Option<Vec<MenuUpdate>> {
        self.with(|i| i.menus.get(label).cloned())
    }

    /// The workspace window the person used last (menu commands go there).
    pub fn last_focused(&self) -> Option<String> {
        self.with(|i| i.last_focused.clone())
    }

    /// Every window, by label, with what it has.
    pub fn snapshot(&self) -> Vec<(String, WindowInfo)> {
        self.with(|i| {
            let mut all: Vec<_> = i
                .windows
                .iter()
                .map(|(l, w)| (l.clone(), w.clone()))
                .collect();
            all.sort_by_key(|a| order(&a.0));
            all
        })
    }

    /// A label for a new window that no window in `taken` has.
    pub fn new_label(&self, taken: &[String]) -> String {
        self.with(|i| {
            loop {
                i.made += 1;
                let label = format!("{EXTRA_PREFIX}{}", i.made + 1);
                if !taken.contains(&label) && !i.windows.contains_key(&label) {
                    return label;
                }
            }
        })
    }
}

/// "main" first, then the others in the order they were made.
fn order(label: &str) -> (u32, u32) {
    if label == MAIN_LABEL {
        return (0, 0);
    }
    let n = label
        .strip_prefix(EXTRA_PREFIX)
        .and_then(|n| n.parse().ok())
        .unwrap_or(u32::MAX);
    (1, n)
}

/// What a click on a connection in the Dock menu does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockOpen {
    /// It is open already: show that window.
    Focus(String),
    /// This window adds it to its connections.
    Use(String),
    /// There is no window: make one.
    New,
}

/// Where a connection chosen in the Dock menu opens: in the window it is open in, else in the
/// window used last (it joins that window's connections; nothing is closed for it).
pub fn plan_dock_open(
    windows: &[(String, WindowInfo)],
    last_focused: Option<&str>,
    connection: &str,
) -> DockOpen {
    let workspace = || windows.iter().filter(|(l, _)| is_workspace(l));
    if let Some((label, _)) = workspace().find(|(_, w)| w.connections.contains(connection)) {
        return DockOpen::Focus(label.clone());
    }
    if let Some(label) = last_focused.filter(|l| workspace().any(|(w, _)| w == l)) {
        return DockOpen::Use(label.to_owned());
    }
    match workspace().next() {
        Some((label, _)) => DockOpen::Use(label.clone()),
        None => DockOpen::New,
    }
}

/// What to do about a request to quit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitStep {
    /// Nothing is in the way.
    Exit,
    /// Ask this window: about its unsaved edits, or whether to quit at all.
    Ask(String),
}

/// The next step of quitting. Windows with unsaved edits are asked one after the other (the
/// last used first); `confirm` is "Confirm on quit": with nothing unsaved the last used window
/// asks the plain question.
pub fn plan_quit(
    windows: &[(String, WindowInfo)],
    last_focused: Option<&str>,
    confirm: bool,
) -> QuitStep {
    let dirty = |label: &str| windows.iter().any(|(l, w)| l == label && w.unsaved > 0);
    if let Some(label) = last_focused.filter(|l| dirty(l)) {
        return QuitStep::Ask(label.to_owned());
    }
    if let Some((label, _)) = windows
        .iter()
        .find(|(l, w)| is_workspace(l) && w.unsaved > 0)
    {
        return QuitStep::Ask(label.clone());
    }
    if confirm {
        let ask = last_focused
            .filter(|l| is_workspace(l))
            .map(str::to_owned)
            .or_else(|| {
                windows
                    .iter()
                    .find(|(l, _)| is_workspace(l))
                    .map(|(l, _)| l.clone())
            });
        if let Some(label) = ask {
            return QuitStep::Ask(label);
        }
    }
    QuitStep::Exit
}

/// What the close button of a window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseStep {
    /// The window closes.
    Close,
    /// The window asks about its edits first.
    Ask,
    /// It is the last window: closing it quits, which has its own questions.
    Quit,
}

pub fn plan_close(workspace_windows: usize, unsaved_here: u32) -> CloseStep {
    if workspace_windows <= 1 {
        CloseStep::Quit
    } else if unsaved_here > 0 {
        CloseStep::Ask
    } else {
        CloseStep::Close
    }
}

// ---- Doing it ----

/// The labels of the workspace windows that are open.
pub fn workspace_labels<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|l| is_workspace(l))
        .collect();
    labels.sort_by_key(|l| order(l));
    labels
}

/// The workspace window that menu commands and the Dock go to: the one used last, else "main".
pub fn target<R: Runtime>(app: &AppHandle<R>, registry: &WindowRegistry) -> Option<String> {
    let open = workspace_labels(app);
    registry
        .last_focused()
        .filter(|l| open.contains(l))
        .or_else(|| open.into_iter().next())
}

/// Send an event to one window.
pub fn emit_to<R: Runtime, S: serde::Serialize + Clone>(
    app: &AppHandle<R>,
    label: &str,
    event: &str,
    payload: S,
) {
    // Only fails if the window is gone, in which case there is nothing to tell.
    let _ = app.emit_to(label, event, payload);
}

/// Bring a window forward.
pub fn focus<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// What every workspace window has: the sidebar of macOS apps lets the desktop show through
/// (ANG-51). The page paints everything else opaque.
pub fn style<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    if let Err(e) = window_vibrancy::apply_vibrancy(
        window,
        window_vibrancy::NSVisualEffectMaterial::Sidebar,
        None,
        None,
    ) {
        eprintln!("no window vibrancy: {e}");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// How far a new window sits from the one it was opened from.
const CASCADE: f64 = 28.0;

/// What a new window shows at start (the page reads it from the address).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Start {
    /// The welcome screen.
    Welcome,
    /// The form for a new connection.
    NewConnection,
    /// Open this connection.
    Connection(String),
}

impl Start {
    fn address(&self) -> String {
        match self {
            Start::Welcome => "index.html".to_owned(),
            Start::NewConnection => "index.html#new".to_owned(),
            Start::Connection(id) => format!("index.html#open={id}"),
        }
    }
}

/// Open a window. For a connection that another window has open, that window comes forward
/// instead. Call on the main thread.
pub fn open<R: Runtime>(app: &AppHandle<R>, registry: &WindowRegistry, start: Start) {
    if let Start::Connection(id) = &start
        && let Some(holder) = registry.holder(id)
        && app.get_webview_window(&holder).is_some()
    {
        focus(app, &holder);
        return;
    }
    let taken: Vec<String> = app.webview_windows().into_keys().collect();
    let label = registry.new_label(&taken);
    let mut builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App(start.address().into()))
            .title("AngkorDB")
            .inner_size(1280.0, 800.0)
            .min_inner_size(1000.0, 640.0)
            .transparent(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // Next to the window it was opened from, the same size.
    if let Some(from) = target(app, registry).and_then(|l| app.get_webview_window(&l))
        && !from.is_maximized().unwrap_or(false)
        && !from.is_fullscreen().unwrap_or(false)
        && let (Ok(size), Ok(position), Ok(scale)) = (
            from.inner_size(),
            from.outer_position(),
            from.scale_factor(),
        )
    {
        builder = builder
            .inner_size(size.width as f64 / scale, size.height as f64 / scale)
            .position(
                position.x as f64 / scale + CASCADE,
                position.y as f64 / scale + CASCADE,
            );
    }
    match builder.build() {
        Ok(window) => style(&window),
        Err(e) => eprintln!("could not open a window: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(label: &str, connections: &[&str], unsaved: u32) -> (String, WindowInfo) {
        (
            label.to_owned(),
            WindowInfo {
                connections: connections.iter().map(|c| (*c).to_owned()).collect(),
                unsaved,
            },
        )
    }

    #[test]
    fn only_the_workspace_windows_count() {
        assert!(is_workspace("main"));
        assert!(is_workspace("window-2"));
        assert!(!is_workspace("settings"));
    }

    #[test]
    fn a_connection_is_open_in_one_window_at_a_time() {
        let registry = WindowRegistry::default();
        assert_eq!(registry.claim("main", "a"), Claim::Granted);
        // A window may have several, and claim one again.
        assert_eq!(registry.claim("main", "a"), Claim::Granted);
        assert_eq!(registry.claim("main", "b"), Claim::Granted);
        assert_eq!(
            registry.claim("window-2", "a"),
            Claim::HeldBy("main".into())
        );
        assert_eq!(registry.claim("window-2", "c"), Claim::Granted);
        assert_eq!(registry.holder("b").as_deref(), Some("main"));

        registry.release("main", "a");
        registry.release("main", "nope");
        assert_eq!(registry.claim("window-2", "a"), Claim::Granted);
        assert_eq!(registry.holder("b").as_deref(), Some("main"));
    }

    #[test]
    fn a_closed_window_gives_back_its_connections() {
        let registry = WindowRegistry::default();
        registry.claim("window-2", "a");
        registry.claim("window-2", "b");
        registry.set_unsaved("window-2", 2);
        registry.note_focus("window-2");
        assert_eq!(registry.forget("window-2"), ["a", "b"]);
        assert_eq!(registry.total_unsaved(), 0);
        assert_eq!(registry.last_focused(), None);
        assert_eq!(registry.claim("main", "a"), Claim::Granted);
        assert!(registry.forget("gone").is_empty());
    }

    #[test]
    fn unsaved_edits_add_up_over_windows() {
        let registry = WindowRegistry::default();
        registry.set_unsaved("main", 1);
        registry.set_unsaved("window-2", 3);
        assert_eq!(registry.total_unsaved(), 4);
        assert_eq!(registry.unsaved("window-2"), 3);
        registry.set_unsaved("main", 0);
        assert_eq!(registry.total_unsaved(), 3);
        assert_eq!(registry.unsaved("nope"), 0);
    }

    #[test]
    fn the_menu_follows_the_window_in_use() {
        let update = |id: &str| {
            vec![MenuUpdate {
                id: id.to_owned(),
                accelerator: None,
                enabled: true,
            }]
        };
        let registry = WindowRegistry::default();
        // Nobody is in use yet: the first word counts.
        assert!(registry.remember_menu("main", update("a")));
        registry.note_focus("main");
        assert!(registry.remember_menu("main", update("b")));
        // Another window speaks while main is in use: kept, not shown.
        assert!(!registry.remember_menu("window-2", update("c")));
        registry.note_focus("window-2");
        assert_eq!(registry.menu_of("window-2").unwrap()[0].id, "c");
        assert_eq!(registry.menu_of("main").unwrap()[0].id, "b");
        registry.forget("window-2");
        assert!(registry.menu_of("window-2").is_none());
    }

    #[test]
    fn new_labels_skip_the_ones_in_use() {
        let registry = WindowRegistry::default();
        assert_eq!(registry.new_label(&[]), "window-2");
        assert_eq!(registry.new_label(&["window-3".into()]), "window-4");
        registry.set_unsaved("window-5", 0);
        assert_eq!(registry.new_label(&[]), "window-6");
    }

    #[test]
    fn the_snapshot_lists_main_first_and_the_rest_in_order() {
        let registry = WindowRegistry::default();
        for label in ["window-10", "window-2", "main", "settings"] {
            registry.set_unsaved(label, 0);
        }
        let labels: Vec<_> = registry.snapshot().into_iter().map(|(l, _)| l).collect();
        assert_eq!(labels, ["main", "window-2", "window-10", "settings"]);
    }

    #[test]
    fn the_dock_adds_a_connection_to_the_window_in_use() {
        let two = [win("main", &["a"], 0), win("window-2", &["b"], 0)];
        // Open somewhere: that window comes forward.
        assert_eq!(
            plan_dock_open(&two, Some("main"), "b"),
            DockOpen::Focus("window-2".into())
        );
        // Not open: it joins the window used last, whatever that has open.
        assert_eq!(
            plan_dock_open(&two, Some("window-2"), "c"),
            DockOpen::Use("window-2".into())
        );
        assert_eq!(
            plan_dock_open(&two, None, "c"),
            DockOpen::Use("main".into())
        );

        // The settings window is nobody's workspace.
        let settings = [win("settings", &[], 0)];
        assert_eq!(
            plan_dock_open(&settings, Some("settings"), "c"),
            DockOpen::New
        );
        assert_eq!(plan_dock_open(&[], None, "c"), DockOpen::New);
    }

    #[test]
    fn quitting_asks_the_windows_with_unsaved_edits_one_by_one() {
        let clean = [win("main", &["a"], 0), win("window-2", &[], 0)];
        assert_eq!(plan_quit(&clean, Some("main"), false), QuitStep::Exit);
        assert_eq!(
            plan_quit(&clean, Some("window-2"), true),
            QuitStep::Ask("window-2".into())
        );
        assert_eq!(plan_quit(&clean, None, true), QuitStep::Ask("main".into()));

        let dirty = [win("main", &["a"], 2), win("window-2", &["b"], 1)];
        assert_eq!(
            plan_quit(&dirty, Some("window-2"), false),
            QuitStep::Ask("window-2".into())
        );
        assert_eq!(
            plan_quit(&dirty, Some("settings"), false),
            QuitStep::Ask("main".into())
        );

        let one_left = [win("main", &["a"], 0), win("window-2", &["b"], 1)];
        assert_eq!(
            plan_quit(&one_left, Some("main"), true),
            QuitStep::Ask("window-2".into())
        );
        assert_eq!(plan_quit(&[], None, true), QuitStep::Exit);
    }

    #[test]
    fn closing_a_window_asks_only_when_it_has_edits_and_is_not_the_last() {
        assert_eq!(plan_close(2, 0), CloseStep::Close);
        assert_eq!(plan_close(2, 3), CloseStep::Ask);
        assert_eq!(plan_close(1, 0), CloseStep::Quit);
        assert_eq!(plan_close(1, 3), CloseStep::Quit);
    }

    #[test]
    fn a_new_window_starts_where_it_is_told() {
        assert_eq!(Start::Welcome.address(), "index.html");
        assert_eq!(Start::NewConnection.address(), "index.html#new");
        assert_eq!(
            Start::Connection("abc".into()).address(),
            "index.html#open=abc"
        );
    }
}
