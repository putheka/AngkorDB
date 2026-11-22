//! The menu of the Dock icon (right-click, or hold): recent connections and "New Connection…".
//!
//! Tauri has no API for it. macOS asks the application's delegate for the menu
//! (`applicationDockMenu:`), and the delegate is tao's class, which does not implement it, so the
//! method is added to that class at runtime. The menu is built each time it is asked for, from
//! what [`DockHandlers::entries`] says then.

use std::sync::OnceLock;

/// A connection to offer in the Dock menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockEntry {
    pub id: String,
    pub title: String,
}

/// What was chosen in the Dock menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockChoice {
    /// Open the connection with this id.
    Open(String),
    /// Show the form for a new connection.
    New,
}

/// What the Dock menu asks of the app. Both run on the main thread.
pub struct DockHandlers {
    pub entries: Box<dyn Fn() -> Vec<DockEntry> + Send + Sync>,
    pub chosen: Box<dyn Fn(DockChoice) + Send + Sync>,
}

/// One line of the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    /// A title that can't be chosen.
    Header(String),
    Entry(DockEntry),
    Separator,
    New,
}

/// The lines of the menu for these connections: a header and the connections when there are any,
/// then "New Connection…".
pub fn rows(entries: Vec<DockEntry>) -> Vec<Row> {
    let mut rows = Vec::new();
    if !entries.is_empty() {
        rows.push(Row::Header("Recent Connections".to_owned()));
        rows.extend(entries.into_iter().map(Row::Entry));
        rows.push(Row::Separator);
    }
    rows.push(Row::New);
    rows
}

/// The title shown for a connection: its name, without line breaks, and not wider than a menu
/// should be.
pub(crate) fn menu_title(name: &str) -> String {
    const MAX: usize = 40;
    let one_line: String = name
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if one_line.chars().count() <= MAX {
        return one_line;
    }
    let mut short: String = one_line.chars().take(MAX - 1).collect();
    short.push('…');
    short
}

static HANDLERS: OnceLock<DockHandlers> = OnceLock::new();

/// Give the Dock icon its menu. Call once, on the main thread, after the app has started.
/// Returns whether the menu was installed (it is not on other platforms, or if called again).
#[cfg(target_os = "macos")]
pub fn install_dock_menu(handlers: DockHandlers) -> bool {
    if HANDLERS.set(handlers).is_err() {
        return false;
    }
    mac::install()
}

#[cfg(not(target_os = "macos"))]
pub fn install_dock_menu(_handlers: DockHandlers) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::ffi::class_addMethod;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{MainThreadMarker, MainThreadOnly, msg_send, sel};
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
    use objc2_foundation::{NSString, ns_string};

    use super::{DockChoice, DockEntry, HANDLERS, Row, menu_title, rows};

    type DockMenuFn = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject;
    type ActionFn = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

    pub fn install() -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
            return false;
        };
        let object: &AnyObject = delegate.as_ref();
        let class = object.class();
        // A class that already has a Dock menu is somebody else's: leave it.
        if class.instance_method(sel!(applicationDockMenu:)).is_some() {
            return false;
        }
        add(
            class,
            sel!(applicationDockMenu:),
            dock_menu as DockMenuFn,
            c"@@:@",
        );
        add(class, sel!(angkorDockOpen:), open as ActionFn, c"v@:@");
        add(
            class,
            sel!(angkorDockNew:),
            new_connection as ActionFn,
            c"v@:@",
        );
        class.instance_method(sel!(applicationDockMenu:)).is_some()
    }

    fn add<F: Copy>(class: &AnyClass, name: Sel, function: F, types: &core::ffi::CStr) {
        assert_eq!(size_of::<F>(), size_of::<unsafe extern "C-unwind" fn()>());
        // SAFETY: `function` is a plain `extern "C-unwind"` function whose arguments are the
        // receiver, the selector and what `types` says, as `class_addMethod` expects; an IMP is
        // the same size as any function pointer (asserted above).
        unsafe {
            let imp: unsafe extern "C-unwind" fn() = core::mem::transmute_copy(&function);
            class_addMethod(
                std::ptr::from_ref(class).cast_mut().cast(),
                name,
                imp,
                types.as_ptr(),
            );
        }
    }

    extern "C-unwind" fn dock_menu(
        this: *mut AnyObject,
        _command: Sel,
        _sender: *mut AnyObject,
    ) -> *mut AnyObject {
        let (Some(mtm), Some(handlers)) = (MainThreadMarker::new(), HANDLERS.get()) else {
            return std::ptr::null_mut();
        };
        // SAFETY: `this` is the application delegate that AppKit is asking, alive for this call.
        let target: &AnyObject = unsafe { &*this };
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        for row in rows((handlers.entries)()) {
            match row {
                Row::Separator => menu.addItem(&NSMenuItem::separatorItem(mtm)),
                Row::Header(title) => {
                    let item = item(mtm, &title, None);
                    item.setEnabled(false);
                    menu.addItem(&item);
                }
                Row::Entry(DockEntry { id, title }) => {
                    let item = item(mtm, &menu_title(&title), Some(sel!(angkorDockOpen:)));
                    // SAFETY: the target is the delegate, which implements the action and lives as
                    // long as the app; the represented object is a string the action reads back.
                    unsafe {
                        item.setTarget(Some(target));
                        item.setRepresentedObject(Some(&NSString::from_str(&id)));
                    }
                    menu.addItem(&item);
                }
                Row::New => {
                    let item = item(mtm, "New Connection…", Some(sel!(angkorDockNew:)));
                    // SAFETY: as above.
                    unsafe { item.setTarget(Some(target)) };
                    menu.addItem(&item);
                }
            }
        }
        Retained::autorelease_return(menu).cast()
    }

    fn item(mtm: MainThreadMarker, title: &str, action: Option<Sel>) -> Retained<NSMenuItem> {
        // SAFETY: a title, an action that the target implements (or none) and no key equivalent.
        unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                action,
                ns_string!(""),
            )
        }
    }

    extern "C-unwind" fn open(_this: *mut AnyObject, _command: Sel, sender: *mut AnyObject) {
        if sender.is_null() {
            return;
        }
        // SAFETY: `sender` is the menu item that was chosen, alive for this call.
        let represented: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*sender, representedObject] };
        let id = represented
            .and_then(|object| object.downcast::<NSString>().ok())
            .map(|id| id.to_string());
        if let (Some(id), Some(handlers)) = (id, HANDLERS.get()) {
            (handlers.chosen)(DockChoice::Open(id));
        }
    }

    extern "C-unwind" fn new_connection(
        _this: *mut AnyObject,
        _command: Sel,
        _sender: *mut AnyObject,
    ) {
        if let Some(handlers) = HANDLERS.get() {
            (handlers.chosen)(DockChoice::New);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str) -> DockEntry {
        DockEntry {
            id: id.to_owned(),
            title: title.to_owned(),
        }
    }

    #[test]
    fn with_no_connections_the_menu_only_offers_a_new_one() {
        assert_eq!(rows(vec![]), [Row::New]);
    }

    #[test]
    fn connections_come_under_a_header_before_the_new_connection() {
        assert_eq!(
            rows(vec![entry("1", "prod"), entry("2", "dev")]),
            [
                Row::Header("Recent Connections".into()),
                Row::Entry(entry("1", "prod")),
                Row::Entry(entry("2", "dev")),
                Row::Separator,
                Row::New,
            ]
        );
    }

    #[test]
    fn titles_are_one_line_and_not_too_wide() {
        assert_eq!(menu_title("  prod\nreplica\t1 "), "prod replica 1");
        let long = "x".repeat(100);
        let short = menu_title(&long);
        assert_eq!(short.chars().count(), 40);
        assert!(short.ends_with('…'));
        assert_eq!(menu_title("ünïcode"), "ünïcode");
    }
}
