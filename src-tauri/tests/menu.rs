//! The menu bar builds; its items are named after commands of the page's registry, and what the
//! page says about them (keys, enabled) is applied. ⌘W belongs to "Close Tab", not "Close Window".
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
    use angkordb_lib::menu::{self, MenuUpdate};
    use tauri::menu::MenuItemKind;

    let app = tauri::test::mock_app();
    let menu = menu::build(app.handle()).expect("menu builds");

    let found = menu.items().unwrap().into_iter().any(|item| match item {
        MenuItemKind::Submenu(sub) => sub.get(menu::CLOSE_TAB).is_some(),
        _ => false,
    });
    assert!(found, "no Close Tab item in any submenu");

    // The menu's items are the page's list of menu commands (which a frontend test checks against
    // the registry itself).
    let registry = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/shortcuts/commands.ts"),
    )
    .expect("the registry file");
    let ids = menu::command_ids(&menu);
    assert!(ids.len() >= 30, "only {} items: {ids:?}", ids.len());
    // The page's list of menu commands is exactly the menu's.
    let list_start = registry
        .find("MENU_COMMAND_IDS: readonly string[] = [")
        .expect("MENU_COMMAND_IDS in the registry");
    let list = &registry[list_start..];
    let list = &list[..list.find("];").expect("end of the list")];
    let mut in_registry: Vec<String> = list
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect();
    in_registry.sort();
    let mut in_menu = ids.clone();
    in_menu.sort();
    assert_eq!(in_menu, in_registry, "the menu and MENU_COMMAND_IDS differ");

    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "an id is used twice: {ids:?}");

    // Items start grey, except the two whose keys are fixed.
    let enabled = |id: &str| -> bool {
        fn find(items: Vec<MenuItemKind<tauri::test::MockRuntime>>, id: &str) -> Option<bool> {
            for kind in items {
                match kind {
                    MenuItemKind::MenuItem(m) if m.id().0 == id => return m.is_enabled().ok(),
                    MenuItemKind::Submenu(s) => {
                        if let Some(found) = find(s.items().unwrap(), id) {
                            return Some(found);
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        find(menu.items().unwrap(), id).expect("item exists")
    };
    assert!(enabled(menu::CLOSE_TAB) && enabled(menu::SETTINGS));
    assert!(!enabled("editor.run"));

    // The page enables items and gives them keys; a key the menu can't read is dropped quietly,
    // and the fixed items ignore the page.
    menu::apply_updates(
        &menu,
        &[
            MenuUpdate {
                id: "editor.run".into(),
                accelerator: Some("Cmd+Enter".into()),
                enabled: true,
            },
            MenuUpdate {
                id: "tabs.new".into(),
                accelerator: Some("Cmd+T".into()),
                enabled: true,
            },
            MenuUpdate {
                id: "file.export".into(),
                accelerator: Some("Shift+Cmd+E".into()),
                enabled: true,
            },
            MenuUpdate {
                id: "view.zoomIn".into(),
                accelerator: Some("Cmd+Equal".into()),
                enabled: true,
            },
            MenuUpdate {
                id: "table.mode".into(),
                accelerator: Some("Alt+Cmd+BracketRight".into()),
                enabled: true,
            },
            MenuUpdate {
                id: "app.sidebar".into(),
                accelerator: Some("Cmd+Digit0".into()),
                enabled: true,
            },
            MenuUpdate {
                id: "query.stop".into(),
                accelerator: Some("not a key at all".into()),
                enabled: true,
            },
            MenuUpdate {
                id: menu::CLOSE_TAB.into(),
                accelerator: None,
                enabled: false,
            },
            MenuUpdate {
                id: "no.such.item".into(),
                accelerator: None,
                enabled: true,
            },
        ],
    );
    assert!(enabled("editor.run") && enabled("tabs.new") && enabled("query.stop"));
    assert!(enabled(menu::CLOSE_TAB), "Close Tab is fixed");
    menu::apply_updates(
        &menu,
        &[MenuUpdate {
            id: "editor.run".into(),
            accelerator: None,
            enabled: false,
        }],
    );
    assert!(!enabled("editor.run"));

    // The spellings the page uses for keys are ones the menu really reads (its own parser; the
    // mock runtime used above does not parse), and made-up ones are refused.
    use std::str::FromStr;
    for spelling in [
        "Cmd+T",
        "Shift+Cmd+E",
        "Alt+Cmd+BracketRight",
        "Cmd+Digit0",
        "Cmd+Equal",
        "Cmd+Minus",
        "Cmd+Enter",
        "Cmd+Period",
        "Cmd+Slash",
        "Shift+Cmd+Slash",
        "Shift+Cmd+Backspace",
        "Ctrl+Tab",
        "Ctrl+Shift+Tab",
        "Alt+Cmd+Digit0",
        "Shift+Cmd+BracketLeft",
        "Cmd+F5",
        "Cmd+Comma",
        "Cmd+ArrowDown",
        "Cmd+N",
        "Alt+Cmd+D",
        "Cmd+F",
        "Cmd+K",
        "Cmd+P",
        "Cmd+R",
        "Cmd+I",
        "Cmd+S",
    ] {
        assert!(
            muda::accelerator::Accelerator::from_str(spelling).is_ok(),
            "the menu can't read {spelling}"
        );
    }
    for bogus in ["not a key at all", "Cmd+Nope", "Cmd+", ""] {
        assert!(
            muda::accelerator::Accelerator::from_str(bogus).is_err(),
            "the menu reads {bogus:?}"
        );
    }

    // Nothing is listening in a bare mock app; forwarding must not panic.
    menu::on_event(app.handle(), "tabs.new");
    menu::on_event(app.handle(), "something-else");
}
