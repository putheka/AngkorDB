use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::db::session::Session;
use crate::error::{AppError, AppResult};
use crate::storage::ConnectionManager;

/// Global state shared by all commands (`tauri::State<AppState>`).
pub struct AppState {
    connections: ConnectionManager,
    /// Open database sessions, keyed by connection id.
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl AppState {
    pub fn new(connections: ConnectionManager) -> Self {
        Self {
            connections,
            sessions: RwLock::new(HashMap::new()),
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
            .ok_or_else(|| AppError::ConnectionNotFound(connection_id.to_owned()))
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
