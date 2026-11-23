//! Closing windows and quitting (⌘Q) while tabs have unsaved edits (ANG-29), or always when
//! "Confirm on quit" is on (ANG-53). Also what a closed window leaves behind.
//!
//! Each page tells Rust how many of its tabs have staged edits (`set_unsaved_changes`) and
//! whether to confirm every quit (`set_confirm_on_quit`).
//!
//! - ⌘Q, or the last window closing: the exit is held back while any window has edits or
//!   "Confirm on quit" is on, and a window's page gets [`QUIT_REQUESTED`]; it asks what to do
//!   and calls `quit_app`, which asks the next window with edits, and leaves when none is left.
//! - The close button of a window that is not the last: closes it, unless it has edits; then its
//!   page gets [`CLOSE_REQUESTED`], asks, and calls `close_window`.
//! - A window that is gone gives back its connection: its session is closed.
//!
//! The settings window closes without asking.

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::state::AppState;
use crate::windows::{
    CLOSE_REQUESTED, CloseStep, QUIT_REQUESTED, QuitStep, emit_to, focus, is_workspace, plan_close,
    plan_quit, workspace_labels,
};

/// Called for every run event of the app.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let state = app.state::<AppState>();
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Focused(true),
            ..
        } if is_workspace(label) => {
            state.windows().note_focus(label);
            // The menu bar is one for all windows: it shows what this window's page asked for.
            state.show_menu_of(label);
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } if is_workspace(label) => window_gone(app, label),
        // ⌘Q, or the last window closing. An exit asked for with a code (`app.exit(0)`, which is
        // how the page's answer arrives) goes through.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => {
            let windows = state.windows();
            let step = plan_quit(
                &windows.snapshot(),
                windows.last_focused().as_deref(),
                state.confirm_quit(),
            );
            if let QuitStep::Ask(label) = step {
                api.prevent_exit();
                focus(app, &label);
                emit_to(app, &label, QUIT_REQUESTED, ());
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if is_workspace(label) => {
            let windows = state.windows();
            match plan_close(workspace_labels(app).len(), windows.unsaved(label)) {
                CloseStep::Close => {}
                CloseStep::Ask => {
                    api.prevent_close();
                    emit_to(app, label, CLOSE_REQUESTED, ());
                }
                // The last window: closing it is quitting, with the same questions.
                CloseStep::Quit => {
                    let step = plan_quit(
                        &windows.snapshot(),
                        windows.last_focused().as_deref(),
                        state.confirm_quit(),
                    );
                    if let QuitStep::Ask(ask) = step {
                        api.prevent_close();
                        emit_to(app, &ask, QUIT_REQUESTED, ());
                    }
                }
            }
        }
        _ => {}
    }
}

/// A workspace window is gone: its connection is not in use any more, and without workspace
/// windows the settings window has nothing to belong to.
fn window_gone(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    if let Some(connection) = state.windows().forget(label) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Closing the server side can't fail in a way anyone can act on.
            let _ = app.state::<AppState>().remove_session(&connection).await;
        });
    }
    if workspace_labels(app).iter().all(|l| l == label) {
        crate::settings::close(app);
    }
}
