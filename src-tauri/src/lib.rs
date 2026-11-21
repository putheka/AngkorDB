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
pub mod settings;
pub mod state;
pub mod storage;

use std::path::Path;

use specta_typescript::Typescript;
use state::{AppState, WindowHooks};
use storage::history::HistoryStore;
use storage::workspace::WorkspaceStore;
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
            commands::activity::list_activity,
            commands::activity::cancel_backend,
            commands::activity::terminate_backend,
            commands::app::app_info,
            commands::app::set_unsaved_changes,
            commands::app::quit_app,
            commands::app::open_settings,
            commands::app::set_confirm_on_quit,
            commands::connection_files::export_connections,
            commands::connection_files::read_connection_file,
            commands::connection_files::import_connections,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::duplicate_connection,
            commands::connections::test_connection,
            commands::connections::test_ssh,
            commands::connections::trust_ssh_host,
            commands::connections::resolve_ssh_alias,
            commands::connections::parse_connection_url,
            commands::connections::connect_connection,
            commands::connections::disconnect_connection,
            commands::connections::connection_health,
            commands::workspace::save_workspace,
            commands::workspace::load_workspace,
            commands::workspace::startup_state,
            commands::workspace::set_restore_on_launch,
            commands::workspace::set_last_connection,
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
            commands::objects::preview_object_operation,
            commands::objects::apply_object_operation,
            commands::objects::object_definition,
            commands::objects::database_options,
            commands::objects::database_connections,
            commands::objects::sequence_info,
            commands::roles::list_roles,
            commands::roles::preview_role_operation,
            commands::roles::apply_role_operation,
            commands::privileges::object_privileges,
            commands::privileges::default_privileges,
            commands::privileges::preview_privilege_changes,
            commands::privileges::apply_privilege_changes,
            commands::changes::preview_changes,
            commands::changes::apply_changes,
            commands::backup::detect_pg_tools,
            commands::backup::start_backup,
            commands::backup::start_restore,
            commands::backup::tool_status,
            commands::backup::cancel_tool,
            commands::import::preview_import,
            commands::import::start_import,
            commands::import::import_status,
            commands::import::cancel_import,
            commands::export::start_export,
            commands::export::export_status,
            commands::export::cancel_export,
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
        .plugin(tauri_plugin_dialog::init())
        // Size, position and maximized state of the window come back at the next launch (ANG-50).
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            // The workspace of each connection and what to do at launch (ANG-50): files in a
            // folder of their own; if it can't be made, they are kept until the app quits.
            let workspaces = WorkspaceStore::open(&dir.join("workspaces")).unwrap_or_else(|e| {
                eprintln!("workspaces are not saved: {}", e.message());
                WorkspaceStore::in_memory()
            });
            app.manage(
                AppState::new(connections)
                    .with_history(history)
                    .with_workspaces(workspaces),
            );

            // The sidebar of macOS apps lets the desktop show through (ANG-51). The page paints
            // everything else opaque; the sidebar goes translucent unless the person turned it off.
            #[cfg(target_os = "macos")]
            if let Some(main) = app.get_webview_window("main")
                && let Err(e) = window_vibrancy::apply_vibrancy(
                    &main,
                    window_vibrancy::NSVisualEffectMaterial::Sidebar,
                    None,
                    None,
                )
            {
                eprintln!("no window vibrancy: {e}");
            }

            // What commands may not do themselves: touch the window and quit (ANG-29).
            let window = app.handle().clone();
            let quitter = app.handle().clone();
            let opener = app.handle().clone();
            app.state::<AppState>().set_window_hooks(WindowHooks {
                set_edited: Box::new(move |edited| {
                    if let Some(main) = window.get_webview_window("main") {
                        angkordb_macos_window::set_document_edited(&main, edited);
                    }
                }),
                quit: Box::new(move || quitter.exit(0)),
                // Windows are made on the main thread.
                open_settings: Box::new(move || {
                    let app = opener.clone();
                    let _ = opener.run_on_main_thread(move || settings::open(&app));
                }),
            });
            Ok(())
        })
        .invoke_handler(specta.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| exit::on_run_event(app, &event));
}
