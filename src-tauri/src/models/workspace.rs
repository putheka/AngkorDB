//! What to do when the app starts (ANG-50).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupState {
    /// Open the connection that was open last time, with its tabs; `false` shows the welcome
    /// screen.
    pub restore_on_launch: bool,
    /// The connection that was open when the app was last used. `None` after a disconnect.
    pub last_connection_id: Option<String>,
}
