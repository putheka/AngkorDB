//! AngkorDB — native macOS PostgreSQL client.
//!
//! Module map:
//! - `commands` — `#[tauri::command]` handlers called from the React UI
//! - `db`       — Postgres layer: pools, per-tab clients, introspection, row fetching
//! - `models`   — serializable types shared with the frontend
//! - `state`    — global `AppState` managed by Tauri
//! - `error`    — `AppError`, serialized to `{ code, message, ... }` for the UI

pub mod auth;
pub mod commands;
pub mod db;
pub mod error;
pub mod exit;
pub mod menu;
pub mod models;
pub mod state;
pub mod storage;

use std::path::Path;

use specta_typescript::Typescript;
use state::{AppState, WindowHooks};
use storage::history::HistoryStore;
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
            commands::app::set_unsaved_changes,
            commands::app::quit_app,
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
            commands::schema::list_enum_values,
            commands::schema::list_incoming_foreign_keys,
            commands::schema::completion_schema,
            commands::schema::table_structure,
            commands::rows::fetch_rows,
            commands::rows::count_rows,
            commands::rows::count_matching,
            commands::alter::preview_structure_changes,
            commands::alter::apply_structure_changes,
            commands::changes::preview_changes,
            commands::changes::apply_changes,
            commands::query::run_query,
            commands::query::explain_query,
            commands::query::cancel_query,
            commands::query::close_query_tab,
            commands::query::statement_at,
            commands::history::list_history,
            commands::history::delete_history_entry,
            commands::history::clear_history,
            commands::history::list_saved_queries,
            commands::history::save_query,
            commands::history::delete_saved_query,
            commands::safety::classify_sql,
            commands::safety::authenticate_user,
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
            // History and saved queries: a file next to the connections. If it can't be opened
            // the app still works, with history that lasts until it quits.
            let history = std::fs::create_dir_all(&dir)
                .map_err(|e| error::AppError::Storage(e.to_string()))
                .and_then(|()| HistoryStore::open(&dir.join("history.sqlite")))
                .unwrap_or_else(|e| {
                    eprintln!("query history is not saved: {e}");
                    HistoryStore::in_memory().expect("an in-memory SQLite database")
                });
            app.manage(AppState::new(connections).with_history(history));

            // What commands may not do themselves: touch the window and quit (ANG-29).
            let window = app.handle().clone();
            let quitter = app.handle().clone();
            app.state::<AppState>().set_window_hooks(WindowHooks {
                set_edited: Box::new(move |edited| {
                    if let Some(main) = window.get_webview_window("main") {
                        angkordb_macos_window::set_document_edited(&main, edited);
                    }
                }),
                quit: Box::new(move || quitter.exit(0)),
            });
            Ok(())
        })
        .invoke_handler(specta.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| exit::on_run_event(app, &event));
}
