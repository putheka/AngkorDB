//! Who is connected and what they are doing (ANG-41).

use serde::{Deserialize, Serialize};

/// One client connection of the server, from `pg_stat_activity`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    pub pid: u32,
    pub database: Option<String>,
    pub user: Option<String>,
    pub application: String,
    /// The client's address; `None` for a connection over a Unix socket.
    pub client: Option<String>,
    /// `active`, `idle`, `idle in transaction`, … (`None` when the role may not see it).
    pub state: Option<String>,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
    /// How long it has been in this state: running the query while `active`, waiting otherwise.
    pub state_secs: Option<f64>,
    /// How long its transaction has been open.
    pub transaction_secs: Option<f64>,
    /// The query it runs, or ran last, cut to a few thousand characters.
    pub query: String,
    /// The pids it waits for.
    pub blocked_by: Vec<u32>,
    /// What it waits for when it is blocked: `ShareLock on public.orders`.
    pub lock_wait: Option<String>,
    /// The connection the app used to ask. It can't be stopped from here.
    pub is_self: bool,
}

/// What to do to a backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Signal {
    /// Stop the query it runs; the connection stays (`pg_cancel_backend`).
    Cancel,
    /// Close the connection, which rolls back its transaction (`pg_terminate_backend`).
    Terminate,
}
