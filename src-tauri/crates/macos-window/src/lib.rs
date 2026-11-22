//! macOS window details that Tauri does not expose (ANG-29).

use tauri::{Runtime, WebviewWindow};

/// Show or hide the dot in the window's close button that macOS uses for "this document has
/// unsaved changes". Does nothing on other platforms.
#[cfg(target_os = "macos")]
pub fn set_document_edited<R: Runtime>(window: &WebviewWindow<R>, edited: bool) {
    use objc2_app_kit::NSWindow;

    // The closure runs on the main thread, where AppKit objects may be used. If the window is
    // already gone there is nothing to mark.
    let _ = window.with_webview(move |webview| {
        let ns_window = webview.ns_window();
        if ns_window.is_null() {
            return;
        }
        // SAFETY: Tauri gives the `NSWindow` of this webview's window. It is alive for the
        // duration of this call (the closure runs on the window's own main thread) and is only
        // borrowed here.
        let window: &NSWindow = unsafe { &*ns_window.cast::<NSWindow>() };
        window.setDocumentEdited(edited);
    });
}

#[cfg(not(target_os = "macos"))]
pub fn set_document_edited<R: Runtime>(_window: &WebviewWindow<R>, _edited: bool) {}

mod dock;
pub use dock::{DockChoice, DockEntry, DockHandlers, Row, install_dock_menu, rows};
