//! Saved connections: JSON file + secret store, no database needed.

use std::fs;
use std::sync::Arc;

use angkordb_lib::models::connection::{
    ColorTag, ConnectionConfig, PasswordChange, SafeMode, SslMode,
};
use angkordb_lib::storage::ConnectionManager;
use angkordb_lib::storage::connections::FILE_NAME;
use angkordb_lib::storage::secrets::{MemorySecrets, SecretStore};
use tempfile::TempDir;

struct Fixture {
    dir: TempDir,
    secrets: Arc<MemorySecrets>,
    manager: ConnectionManager,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let manager = ConnectionManager::new(dir.path(), secrets.clone());
    Fixture {
        dir,
        secrets,
        manager,
    }
}

/// A way to break a connection, and the field the error should name.
type Case = (fn(&mut ConnectionConfig), &'static str);

fn config(name: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name: name.into(),
        host: "localhost".into(),
        port: 5432,
        user: "alice".into(),
        database: "shop".into(),
        ssl_mode: SslMode::Prefer,
        color: ColorTag::None,
        group: None,
        safe_mode: SafeMode::Off,
        has_password: false,
    }
}

fn set(value: &str) -> PasswordChange {
    PasswordChange::Set {
        value: value.into(),
    }
}

#[tokio::test]
async fn creates_a_connection_with_an_id_and_lists_it() {
    let f = fixture();
    assert!(f.manager.list().unwrap().is_empty());

    let saved = f
        .manager
        .save(config("Local"), PasswordChange::Keep)
        .await
        .unwrap();
    assert!(!saved.id.is_empty());

    let listed = f.manager.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, saved.id);
    assert_eq!(listed[0].name, "Local");
}

#[tokio::test]
async fn the_password_goes_to_the_secret_store_and_never_to_disk() {
    let f = fixture();
    let saved = f
        .manager
        .save(config("Prod"), set("hunter2-very-secret"))
        .await
        .unwrap();

    assert!(saved.has_password);
    assert_eq!(
        f.secrets.get(&saved.id).unwrap().as_deref(),
        Some("hunter2-very-secret")
    );
    assert_eq!(
        f.manager.password(&saved.id).await.unwrap().as_deref(),
        Some("hunter2-very-secret")
    );

    let on_disk = fs::read_to_string(f.dir.path().join(FILE_NAME)).unwrap();
    assert!(
        !on_disk.contains("hunter2"),
        "password leaked into {on_disk}"
    );
    assert!(on_disk.contains("\"hasPassword\": true"));
}

#[tokio::test]
async fn keep_set_and_clear_change_the_saved_password() {
    let f = fixture();
    let saved = f.manager.save(config("A"), set("one")).await.unwrap();

    // Keep: editing other fields leaves the password alone.
    let mut edited = saved.clone();
    edited.host = "db.internal".into();
    let kept = f.manager.save(edited, PasswordChange::Keep).await.unwrap();
    assert!(kept.has_password);
    assert_eq!(kept.host, "db.internal");
    assert_eq!(f.secrets.get(&saved.id).unwrap().as_deref(), Some("one"));

    // Set: replace it.
    f.manager.save(kept.clone(), set("two")).await.unwrap();
    assert_eq!(f.secrets.get(&saved.id).unwrap().as_deref(), Some("two"));

    // Clear: remove it.
    let cleared = f.manager.save(kept, PasswordChange::Clear).await.unwrap();
    assert!(!cleared.has_password);
    assert_eq!(f.secrets.get(&saved.id).unwrap(), None);
    assert_eq!(f.manager.password(&saved.id).await.unwrap(), None);
}

#[tokio::test]
async fn an_empty_password_is_rejected() {
    let f = fixture();
    let err = f.manager.save(config("A"), set("")).await.unwrap_err();
    assert_eq!(err.code(), "VALIDATION");
    assert!(f.manager.list().unwrap().is_empty());
}

#[tokio::test]
async fn validates_and_normalizes_input() {
    let f = fixture();

    let cases: [Case; 4] = [
        (|c| c.host = "  ".into(), "Host"),
        (|c| c.port = 0, "Port"),
        (|c| c.user = String::new(), "User"),
        (|c| c.database = " ".into(), "Database"),
    ];
    for (mutate, expected) in cases {
        let mut bad = config("X");
        mutate(&mut bad);
        let err = f.manager.save(bad, PasswordChange::Keep).await.unwrap_err();
        assert_eq!(err.code(), "VALIDATION");
        assert!(err.message().contains(expected), "{}", err.message());
    }

    let mut messy = config("   ");
    messy.host = "  db.example.com ".into();
    messy.group = Some("   ".into());
    let saved = f.manager.save(messy, PasswordChange::Keep).await.unwrap();
    assert_eq!(saved.host, "db.example.com");
    assert_eq!(
        saved.name, "shop @ db.example.com",
        "blank name gets a default"
    );
    assert_eq!(saved.group, None, "blank group means no group");
}

#[tokio::test]
async fn updating_an_unknown_id_fails() {
    let f = fixture();
    let mut c = config("Ghost");
    c.id = "does-not-exist".into();
    let err = f.manager.save(c, PasswordChange::Keep).await.unwrap_err();
    assert_eq!(err.code(), "CONNECTION_NOT_FOUND");
}

#[tokio::test]
async fn delete_removes_the_connection_and_its_password() {
    let f = fixture();
    let keep = f.manager.save(config("Keep"), set("k")).await.unwrap();
    let gone = f.manager.save(config("Gone"), set("g")).await.unwrap();

    f.manager.delete(&gone.id).await.unwrap();

    let listed = f.manager.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, keep.id);
    assert_eq!(f.secrets.get(&gone.id).unwrap(), None);
    assert_eq!(f.secrets.get(&keep.id).unwrap().as_deref(), Some("k"));

    let err = f.manager.delete(&gone.id).await.unwrap_err();
    assert_eq!(err.code(), "CONNECTION_NOT_FOUND");
}

#[tokio::test]
async fn duplicate_copies_settings_and_password_with_a_unique_name() {
    let f = fixture();
    let mut original = config("Prod");
    original.color = ColorTag::Red;
    original.group = Some("Work".into());
    let original = f.manager.save(original, set("pw")).await.unwrap();

    let copy1 = f.manager.duplicate(&original.id).await.unwrap();
    let copy2 = f.manager.duplicate(&original.id).await.unwrap();

    assert_ne!(copy1.id, original.id);
    assert_eq!(copy1.name, "Prod copy");
    assert_eq!(copy2.name, "Prod copy 2");
    assert_eq!(copy1.color, ColorTag::Red);
    assert_eq!(copy1.group.as_deref(), Some("Work"));
    assert!(copy1.has_password);
    assert_eq!(f.secrets.get(&copy1.id).unwrap().as_deref(), Some("pw"));

    // The copies are independent: deleting one keeps the original's password.
    f.manager.delete(&copy1.id).await.unwrap();
    assert_eq!(f.secrets.get(&original.id).unwrap().as_deref(), Some("pw"));
    assert_eq!(f.manager.list().unwrap().len(), 2);
}

#[tokio::test]
async fn listing_does_not_touch_the_secret_store() {
    struct Forbidden;
    impl SecretStore for Forbidden {
        fn get(&self, _: &str) -> angkordb_lib::error::AppResult<Option<String>> {
            panic!("list/get must not read secrets");
        }
        fn set(&self, _: &str, _: &str) -> angkordb_lib::error::AppResult<()> {
            Ok(())
        }
        fn delete(&self, _: &str) -> angkordb_lib::error::AppResult<()> {
            Ok(())
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let manager = ConnectionManager::new(dir.path(), Arc::new(Forbidden));
    let saved = manager.save(config("A"), set("pw")).await.unwrap();
    manager.list().unwrap();
    manager.get(&saved.id).unwrap();
    // ...and a connection without a saved password never asks the Keychain either.
    let none = manager
        .save(config("B"), PasswordChange::Keep)
        .await
        .unwrap();
    assert_eq!(manager.password(&none.id).await.unwrap(), None);
}

#[tokio::test]
async fn data_survives_a_restart() {
    let f = fixture();
    let saved = f
        .manager
        .save(config("Persisted"), set("pw"))
        .await
        .unwrap();

    let reopened = ConnectionManager::new(f.dir.path(), f.secrets.clone());
    let listed = reopened.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Persisted");
    assert_eq!(
        reopened.password(&saved.id).await.unwrap().as_deref(),
        Some("pw")
    );
}

#[tokio::test]
async fn a_corrupt_file_is_reported_and_left_untouched() {
    let f = fixture();
    let path = f.dir.path().join(FILE_NAME);
    fs::write(&path, "{ this is not json").unwrap();

    let err = f.manager.list().unwrap_err();
    assert_eq!(err.code(), "STORAGE");
    assert!(err.message().contains("Fix or delete"), "{}", err.message());

    // Saving must not overwrite the file the user may want to repair.
    let err = f
        .manager
        .save(config("New"), PasswordChange::Keep)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "STORAGE");
    assert_eq!(fs::read_to_string(&path).unwrap(), "{ this is not json");
}

#[tokio::test]
async fn a_file_from_a_newer_version_is_not_overwritten() {
    let f = fixture();
    let path = f.dir.path().join(FILE_NAME);
    fs::write(&path, r#"{"version": 99, "connections": []}"#).unwrap();

    let err = f
        .manager
        .save(config("New"), PasswordChange::Keep)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "STORAGE");
    assert!(err.message().contains("newer version"));
}

#[tokio::test]
async fn test_resolution_uses_the_saved_password_only_when_asked() {
    let f = fixture();
    let saved = f.manager.save(config("A"), set("saved-pw")).await.unwrap();

    // Editing a saved connection and pressing Test with the password box empty → Keep.
    let (_, pw) = f
        .manager
        .resolve_for_test(saved.clone(), PasswordChange::Keep)
        .await
        .unwrap();
    assert_eq!(pw.as_deref(), Some("saved-pw"));

    // A password typed in the form wins; Clear means none.
    let (_, pw) = f
        .manager
        .resolve_for_test(saved.clone(), set("typed"))
        .await
        .unwrap();
    assert_eq!(pw.as_deref(), Some("typed"));
    let (_, pw) = f
        .manager
        .resolve_for_test(saved, PasswordChange::Clear)
        .await
        .unwrap();
    assert_eq!(pw, None);

    // A brand-new, unsaved connection has no saved password.
    let (_, pw) = f
        .manager
        .resolve_for_test(config("New"), PasswordChange::Keep)
        .await
        .unwrap();
    assert_eq!(pw, None);

    // Nothing was saved by testing.
    assert_eq!(f.manager.list().unwrap().len(), 1);
}

#[test]
fn password_change_debug_hides_the_value() {
    let shown = format!("{:?}", set("top-secret"));
    assert!(!shown.contains("top-secret"));
}
