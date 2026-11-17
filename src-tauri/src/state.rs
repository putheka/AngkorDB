use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::db::session::Session;
use crate::error::{AppError, AppResult};

/// Global state shared by all commands (`tauri::State<AppState>`), keyed by connection id.
#[derive(Default)]
pub struct AppState {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl AppState {
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
