//! AngkorDB — native macOS PostgreSQL client.
//!
//! Module map:
//! - `commands` — `#[tauri::command]` handlers called from the React UI
//! - `db`       — Postgres layer: pools, per-tab clients, introspection, row fetching
//! - `models`   — serializable types shared with the frontend
//! - `state`    — global `AppState` managed by Tauri
//! - `error`    — `AppError`, serialized to `{ code, message, ... }` for the UI

pub mod commands;
pub mod db;
pub mod error;
pub mod menu;
pub mod models;
pub mod state;
pub mod storage;

use std::path::Path;

use specta_typescript::Typescript;
use state::AppState;
use storage::{ConnectionManager, secrets::default_secret_store};
use tauri::Manager;
use tauri_specta::{Builder, collect_commands};

/// Where the generated TypeScript bindings live, relative to `src-tauri/`.
pub const BINDINGS_PATH: &str = "../src/bindings.ts";

const BINDINGS_HEADER: &str =
    "// Regenerate with `npm run bindings` (also runs on every `npm run tauri dev`).";

/// Every command and shared type the UI can use. Add new commands here.
/// Generic over the runtime so tests can drive the same handlers through Tauri's mock runtime.
pub fn specta_builder<R: tauri::Runtime>() -> Builder<R> {
    Builder::<R>::new()
        // Our types have the same shape in both directions → one TS type each, no _Serialize split.
        .disable_serde_phases()
        .commands(collect_commands![
            commands::app::app_info,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::duplicate_connection,
            commands::connections::test_connection,
            commands::connections::parse_connection_url,
            commands::connections::connect_connection,
            commands::connections::disconnect_connection,
            commands::schema::list_databases,
            commands::schema::switch_database,
            commands::schema::list_schemas,
            commands::schema::list_objects,
            commands::schema::describe_table,
            commands::rows::fetch_rows,
            commands::rows::count_rows,
        ])
        .typ::<error::AppErrorPayload>()
        .typ::<models::connection::ConnectionConfig>()
}

/// Write `src/bindings.ts`. Runs on every debug start and from `npm run bindings`.
pub fn export_bindings(path: impl AsRef<Path>) -> Result<(), String> {
    specta_builder::<tauri::Wry>()
        .export(Typescript::default().header(BINDINGS_HEADER), path)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    export_bindings(BINDINGS_PATH).expect("failed to export TypeScript bindings");

    let specta = specta_builder::<tauri::Wry>();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            // Settings live in ~/Library/Application Support/com.angkordb.app/.
            let dir = app.path().app_data_dir()?;
            let connections = ConnectionManager::new(&dir, default_secret_store()?);
            app.manage(AppState::new(connections));
            Ok(())
        })
        .invoke_handler(specta.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
