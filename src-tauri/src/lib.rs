//! AngkorDB — native macOS PostgreSQL client.
//!
//! Module map:
//! - `commands` — `#[tauri::command]` handlers called from the React UI
//! - `db`       — Postgres layer: pools, per-tab clients, introspection, row fetching
//! - `models`   — serializable types shared with the frontend
//! - `state`    — global `AppState` managed by Tauri
//! - `error`    — `AppError`, serialized to `{ code, message }` for the UI

pub mod commands;
pub mod db;
pub mod error;
pub mod models;
pub mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![commands::app::app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
