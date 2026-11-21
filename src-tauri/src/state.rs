use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::RwLock;

use crate::db::session::Session;
use crate::db::ssh::{self, HostKeyProblem};
use crate::error::{AppError, AppResult};
use crate::storage::ConnectionManager;
use crate::storage::history::HistoryStore;

/// What the app can do to its own window, for commands that must not take a `Window` or
/// `AppHandle` themselves (see CLAUDE.md). Installed at startup; tests run without it.
pub struct WindowHooks {
    /// Show or hide the "unsaved changes" dot of the window.
    pub set_edited: Box<dyn Fn(bool) + Send + Sync>,
    /// Leave the app, without asking again.
    pub quit: Box<dyn Fn() + Send + Sync>,
}

/// Global state shared by all commands (`tauri::State<AppState>`).
pub struct AppState {
    connections: ConnectionManager,
    /// Open database sessions, keyed by connection id.
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    /// How many tabs have staged edits, as the page last said (ANG-29). Quitting asks first
    /// while this is above zero.
    unsaved: AtomicU32,
    hooks: Mutex<Option<WindowHooks>>,
    history: HistoryStore,
    /// Where SSH host keys are recorded (`~/.ssh/known_hosts`).
    known_hosts: PathBuf,
    /// Host keys an SSH tunnel stopped at, by fingerprint, until the person trusts one or not.
    pending_host_keys: Mutex<HashMap<String, HostKeyProblem>>,
    exports: crate::db::export::Exports,
}

impl AppState {
    pub fn new(connections: ConnectionManager) -> Self {
        Self {
            connections,
            sessions: RwLock::new(HashMap::new()),
            unsaved: AtomicU32::new(0),
            hooks: Mutex::new(None),
            // Without a file (tests): history that lasts as long as the app does.
            history: HistoryStore::in_memory().expect("an in-memory SQLite database"),
            known_hosts: ssh::default_known_hosts(),
            pending_host_keys: Mutex::new(HashMap::new()),
            exports: crate::db::export::Exports::default(),
        }
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

    pub fn history(&self) -> &HistoryStore {
        &self.history
    }

    pub fn set_window_hooks(&self, hooks: WindowHooks) {
        if let Ok(mut slot) = self.hooks.lock() {
            *slot = Some(hooks);
        }
    }

    /// The page reports how many tabs have unsaved edits. The window's edited dot follows.
    pub fn set_unsaved_changes(&self, count: u32) {
        self.unsaved.store(count, Ordering::SeqCst);
        if let Ok(hooks) = self.hooks.lock()
            && let Some(hooks) = hooks.as_ref()
        {
            (hooks.set_edited)(count > 0);
        }
    }

    pub fn unsaved_changes(&self) -> u32 {
        self.unsaved.load(Ordering::SeqCst)
    }

    /// Quit now. The page calls this after the person chose what to do with their edits.
    pub fn quit(&self) {
        if let Ok(hooks) = self.hooks.lock()
            && let Some(hooks) = hooks.as_ref()
        {
            (hooks.quit)();
        }
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
