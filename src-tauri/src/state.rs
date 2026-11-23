use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::RwLock;

use crate::db::session::Session;
use crate::db::ssh::{self, HostKeyProblem};
use crate::error::{AppError, AppResult};
use crate::menu::MenuUpdate;
use crate::storage::ConnectionManager;
use crate::storage::history::HistoryStore;
use crate::storage::workspace::WorkspaceStore;
use crate::windows::{Claim, QuitStep, Start, WindowRegistry, plan_quit};

/// Show or hide the "unsaved changes" dot of the window with this label.
pub type EditedHook = Box<dyn Fn(&str, bool) + Send + Sync>;

/// What the app can do to its own windows, for commands that must not take a `Window` or
/// `AppHandle` themselves (see CLAUDE.md). Installed at startup; tests run without it.
pub struct WindowHooks {
    /// Show or hide the "unsaved changes" dot of a window.
    pub set_edited: EditedHook,
    /// Leave the app, without asking again.
    pub quit: Box<dyn Fn() + Send + Sync>,
    /// Bring a window forward and have its page ask about quitting.
    pub ask_quit: Box<dyn Fn(&str) + Send + Sync>,
    /// Close a window, without asking again.
    pub close_window: Box<dyn Fn(&str) + Send + Sync>,
    /// Open a window (or bring forward the one that has the connection asked for).
    pub open_window: Box<dyn Fn(Start) + Send + Sync>,
    /// Bring a window forward.
    pub focus_window: Box<dyn Fn(&str) + Send + Sync>,
    /// Show the settings window (opening it if needed).
    pub open_settings: Box<dyn Fn() + Send + Sync>,
    /// Give menu items their keys and enable or grey them (the page says which).
    pub update_menu: Box<dyn Fn(Vec<MenuUpdate>) + Send + Sync>,
}

/// Global state shared by all commands (`tauri::State<AppState>`).
pub struct AppState {
    connections: ConnectionManager,
    /// Open database sessions, keyed by connection id.
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    /// What each window has open and how many tabs have staged edits, as the pages last said
    /// (ANG-29). Quitting asks first while any window has some.
    windows: WindowRegistry,
    /// "Confirm on quit" is on (ANG-53): quitting asks even with nothing unsaved.
    confirm_quit: AtomicBool,
    hooks: Mutex<Option<WindowHooks>>,
    history: HistoryStore,
    workspaces: WorkspaceStore,
    /// Where SSH host keys are recorded (`~/.ssh/known_hosts`).
    known_hosts: PathBuf,
    /// Host keys an SSH tunnel stopped at, by fingerprint, until the person trusts one or not.
    pending_host_keys: Mutex<HashMap<String, HostKeyProblem>>,
    exports: crate::db::export::Exports,
    imports: crate::db::import::Imports,
    tool_jobs: crate::db::backup::ToolJobs,
}

impl AppState {
    pub fn new(connections: ConnectionManager) -> Self {
        Self {
            connections,
            sessions: RwLock::new(HashMap::new()),
            windows: WindowRegistry::default(),
            confirm_quit: AtomicBool::new(false),
            hooks: Mutex::new(None),
            // Without a file (tests): history that lasts as long as the app does.
            history: HistoryStore::in_memory().expect("an in-memory SQLite database"),
            // Without a folder (tests): workspaces that last as long as the app does.
            workspaces: WorkspaceStore::in_memory(),
            known_hosts: ssh::default_known_hosts(),
            pending_host_keys: Mutex::new(HashMap::new()),
            exports: crate::db::export::Exports::default(),
            imports: crate::db::import::Imports::default(),
            tool_jobs: crate::db::backup::ToolJobs::default(),
        }
    }

    /// The backups and restores of this run, running and done.
    pub fn tool_jobs(&self) -> &crate::db::backup::ToolJobs {
        &self.tool_jobs
    }

    /// The imports of this run, running and done.
    pub fn imports(&self) -> &crate::db::import::Imports {
        &self.imports
    }

    /// The exports of this run, running and done.
    pub fn exports(&self) -> &crate::db::export::Exports {
        &self.exports
    }

    /// Record SSH host keys in this file instead of `~/.ssh/known_hosts` (tests).
    pub fn with_known_hosts(mut self, path: PathBuf) -> Self {
        self.known_hosts = path;
        self
    }

    pub fn known_hosts(&self) -> &Path {
        &self.known_hosts
    }

    /// Keep a host key the person is asked about, so that "trust" can record exactly it.
    pub fn remember_host_key(&self, problem: HostKeyProblem) {
        if problem.changed {
            return; // never offered
        }
        if let Ok(mut pending) = self.pending_host_keys.lock() {
            if pending.len() >= 16 {
                pending.clear();
            }
            pending.insert(problem.fingerprint.clone(), problem);
        }
    }

    /// The host key with this fingerprint, once, for trusting it.
    pub fn take_host_key(&self, fingerprint: &str) -> Option<HostKeyProblem> {
        self.pending_host_keys
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(fingerprint))
    }

    /// Keep query history and saved queries in this store (a file) instead of in memory.
    pub fn with_history(mut self, history: HistoryStore) -> Self {
        self.history = history;
        self
    }

    /// Keep workspaces in this store (files) instead of in memory.
    pub fn with_workspaces(mut self, workspaces: WorkspaceStore) -> Self {
        self.workspaces = workspaces;
        self
    }

    pub fn workspaces(&self) -> &WorkspaceStore {
        &self.workspaces
    }

    pub fn history(&self) -> &HistoryStore {
        &self.history
    }

    pub fn set_window_hooks(&self, hooks: WindowHooks) {
        if let Ok(mut slot) = self.hooks.lock() {
            *slot = Some(hooks);
        }
    }

    fn hooks<T>(&self, f: impl FnOnce(&WindowHooks) -> T) -> Option<T> {
        let hooks = self.hooks.lock().ok()?;
        hooks.as_ref().map(f)
    }

    pub fn windows(&self) -> &WindowRegistry {
        &self.windows
    }

    /// The page of a window reports how many of its tabs have unsaved edits. The window's edited
    /// dot follows.
    pub fn set_unsaved_changes(&self, label: &str, count: u32) {
        self.windows.set_unsaved(label, count);
        self.hooks(|h| (h.set_edited)(label, count > 0));
    }

    /// The page reports the "Confirm on quit" setting.
    pub fn set_confirm_quit(&self, confirm: bool) {
        self.confirm_quit.store(confirm, Ordering::SeqCst);
    }

    pub fn confirm_quit(&self) -> bool {
        self.confirm_quit.load(Ordering::SeqCst)
    }

    /// Pass the word of a window's page on the menu items on to the menu, if that window is the
    /// one in use. Without a window (tests) nothing happens.
    pub fn update_menu(&self, label: &str, updates: Vec<MenuUpdate>) {
        if self.windows.remember_menu(label, updates.clone()) {
            self.hooks(|h| (h.update_menu)(updates));
        }
    }

    /// A window came into use: the menu shows what its page last said.
    pub fn show_menu_of(&self, label: &str) {
        if let Some(updates) = self.windows.menu_of(label) {
            self.hooks(|h| (h.update_menu)(updates));
        }
    }

    /// Show the settings window. Without a window (tests) nothing happens.
    pub fn open_settings(&self) {
        if let Ok(hooks) = self.hooks.lock()
            && let Some(hooks) = hooks.as_ref()
        {
            (hooks.open_settings)();
        }
    }

    /// Unsaved tabs in all windows.
    pub fn unsaved_changes(&self) -> u32 {
        self.windows.total_unsaved()
    }

    /// The page of a window answered what to do with its unsaved edits (or the plain question
    /// of "Confirm on quit"): go on quitting. The next window with edits is asked; when none is
    /// left the app exits.
    pub fn quit(&self, label: &str) {
        self.windows.set_unsaved(label, 0);
        let step = plan_quit(
            &self.windows.snapshot(),
            self.windows.last_focused().as_deref(),
            false,
        );
        self.hooks(|h| match &step {
            QuitStep::Exit => (h.quit)(),
            QuitStep::Ask(next) => (h.ask_quit)(next),
        });
    }

    /// Close a window whose page has settled its unsaved edits.
    pub fn close_window(&self, label: &str) {
        self.windows.set_unsaved(label, 0);
        self.hooks(|h| (h.close_window)(label));
    }

    /// The window wants to open this connection. `false` when another window has it: that one
    /// is brought forward, and this one must not connect.
    pub fn claim_connection(&self, label: &str, connection_id: &str) -> bool {
        match self.windows.claim(label, connection_id) {
            Claim::Granted => true,
            Claim::HeldBy(other) => {
                self.hooks(|h| (h.focus_window)(&other));
                false
            }
        }
    }

    pub fn release_connection(&self, label: &str, connection_id: &str) {
        self.windows.release(label, connection_id);
    }

    /// Open a window. Without hooks (tests) nothing happens.
    pub fn open_window(&self, start: Start) {
        self.hooks(|h| (h.open_window)(start));
    }

    /// Saved connections and their passwords.
    pub fn connections(&self) -> &ConnectionManager {
        &self.connections
    }

    pub async fn session(&self, connection_id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| AppError::NotConnected(connection_id.to_owned()))
    }

    /// Register an opened session, closing any previous one for the same connection.
    pub async fn insert_session(&self, session: Session) -> Arc<Session> {
        let session = Arc::new(session);
        let previous = self
            .sessions
            .write()
            .await
            .insert(session.config().id.clone(), Arc::clone(&session));
        if let Some(previous) = previous {
            previous.close().await;
        }
        session
    }

    /// Close and forget a session. Returns `false` if it wasn't open.
    pub async fn remove_session(&self, connection_id: &str) -> bool {
        let removed = self.sessions.write().await.remove(connection_id);
        match removed {
            Some(session) => {
                session.close().await;
                true
            }
            None => false,
        }
    }
}
