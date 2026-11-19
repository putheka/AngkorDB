//! The menu bar builds, and ⌘W belongs to "Close Tab" (not "Close Window").
//!
//! Only runs on macOS: Linux CI has no display for GTK menus.
//!
//! No test harness (see `[[test]]` in Cargo.toml): macOS only lets the main thread create
//! native menus, and the harness runs tests on other threads.

fn main() {
    #[cfg(target_os = "macos")]
    check_menu();
}

#[cfg(target_os = "macos")]
fn check_menu() {
    use angkordb_lib::menu;
    use tauri::menu::MenuItemKind;

    let app = tauri::test::mock_app();
    let menu = menu::build(app.handle()).expect("menu builds");

    let found = menu.items().unwrap().into_iter().any(|item| match item {
        MenuItemKind::Submenu(sub) => sub.get(menu::CLOSE_TAB).is_some(),
        _ => false,
    });
    assert!(found, "no Close Tab item in any submenu");

    // Nothing is listening in a bare mock app; forwarding must not panic.
    menu::on_event(app.handle(), menu::CLOSE_TAB);
    menu::on_event(app.handle(), "something-else");
}
