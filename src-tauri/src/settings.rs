//! The settings window (ANG-53): a window of its own that shows the same page as the main one,
//! routed to the settings screen by `#settings`. It reads and writes the same stored settings as
//! the main window, which hears about each change and applies it at once.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Label of the window, and the name of its capability entry.
pub const SETTINGS_LABEL: &str = "settings";

/// Show the settings window, opening it first if it isn't open.
pub fn open<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("index.html#settings".into()),
    )
    .title("Settings")
    .inner_size(820.0, 600.0)
    .min_inner_size(680.0, 440.0)
    .resizable(true)
    .maximizable(false)
    .build();
    if let Err(e) = built {
        eprintln!("could not open the settings window: {e}");
    }
}

/// Close the settings window if it is open (the main window is going away).
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.destroy();
    }
}
