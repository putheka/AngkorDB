//! Closing the window and quitting (⌘Q) while tabs have unsaved edits (ANG-29).
//!
//! The page tells Rust how many tabs have staged edits (`set_unsaved_changes`). When the person
//! quits or closes the window with some, the exit is held back and the page gets
//! [`QUIT_REQUESTED`]; it asks what to do and then calls `quit_app`, which leaves for real.

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

/// Event name the page listens for.
pub const QUIT_REQUESTED: &str = "quit-requested";

/// Called for every run event of the app.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let unsaved = app.state::<AppState>().unsaved_changes() > 0;
    if !unsaved {
        return;
    }
    match event {
        // ⌘Q, or the last window closing. An exit asked for with a code (`app.exit(0)`, which is
        // how the page's answer arrives) goes through.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => {
            api.prevent_exit();
            let _ = app.emit(QUIT_REQUESTED, ());
        }
        // The red close button.
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            let _ = app.emit(QUIT_REQUESTED, ());
        }
        _ => {}
    }
}
