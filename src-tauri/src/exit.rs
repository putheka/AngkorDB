//! Closing the window and quitting (⌘Q) while tabs have unsaved edits (ANG-29), or always when
//! "Confirm on quit" is on (ANG-53).
//!
//! The page tells Rust how many tabs have staged edits (`set_unsaved_changes`) and whether to
//! confirm every quit (`set_confirm_on_quit`). When the person quits or closes the main window in
//! either case, the exit is held back and the page gets [`QUIT_REQUESTED`]; it asks what to do and
//! then calls `quit_app`, which leaves for real. The settings window closes without asking.

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

/// The window whose closing is held back.
const MAIN_LABEL: &str = "main";

/// Event name the page listens for.
pub const QUIT_REQUESTED: &str = "quit-requested";

/// Called for every run event of the app.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let state = app.state::<AppState>();
    let ask = state.unsaved_changes() > 0 || state.confirm_quit();
    match event {
        // The main window is gone: the settings window has nothing to belong to.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } if label == MAIN_LABEL => crate::settings::close(app),
        _ if !ask => {}
        // ⌘Q, or the last window closing. An exit asked for with a code (`app.exit(0)`, which is
        // how the page's answer arrives) goes through.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => {
            api.prevent_exit();
            let _ = app.emit(QUIT_REQUESTED, ());
        }
        // The red close button of the main window.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == MAIN_LABEL => {
            api.prevent_close();
            let _ = app.emit(QUIT_REQUESTED, ());
        }
        _ => {}
    }
}
