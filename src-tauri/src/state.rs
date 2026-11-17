/// Global state shared by all commands (`tauri::State<AppState>`).
///
/// ANG-9 adds the connection registry here:
/// `sessions: RwLock<HashMap<ConnectionId, Session>>` (pool + per-tab clients + cancel tokens).
#[derive(Debug, Default)]
pub struct AppState {}
