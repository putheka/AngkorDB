//! The real command handlers, called through Tauri's IPC layer (mock runtime), with the same
//! JSON the TypeScript side sends. Proves argument names, serde shapes and error JSON match.

use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use angkordb_lib::specta_builder;
use angkordb_lib::state::AppState;
use angkordb_lib::storage::ConnectionManager;
use angkordb_lib::storage::secrets::{MemorySecrets, SecretStore};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};
use tempfile::TempDir;

struct Ipc {
    webview: WebviewWindow<MockRuntime>,
    secrets: Arc<MemorySecrets>,
    // Kept alive for the duration of the test.
    _app: App<MockRuntime>,
    _dir: TempDir,
}

fn setup() -> Ipc {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let state = AppState::new(ConnectionManager::new(dir.path(), secrets.clone()));

    let app = mock_builder()
        .manage(state)
        .invoke_handler(specta_builder::<MockRuntime>().invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    Ipc {
        webview,
        secrets,
        _app: app,
        _dir: dir,
    }
}

impl Ipc {
    /// Call a command the way `invoke()` does: JSON arguments in, JSON result or error out.
    fn call(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(&self.webview, request).map(|body| match body {
            InvokeResponseBody::Json(text) => serde_json::from_str(&text).unwrap(),
            InvokeResponseBody::Raw(_) => panic!("expected a JSON response"),
        })
    }
}

/// What the form sends for a connection (see `ConnectionConfig` in src/bindings.ts).
fn config(name: &str, host: &str, port: u16) -> Value {
    json!({
        "id": "", "name": name, "host": host, "port": port, "user": "alice", "database": "shop",
        "sslMode": "prefer", "color": "green", "group": null, "safeMode": "off",
        "hasPassword": false
    })
}

#[test]
fn save_and_list_round_trip_with_camel_case_fields() {
    let ipc = setup();
    assert_eq!(ipc.call("list_connections", json!({})).unwrap(), json!([]));

    let saved = ipc
        .call(
            "save_connection",
            json!({
                "config": config("Local", "localhost", 5432),
                "password": { "kind": "set", "value": "hunter2" }
            }),
        )
        .unwrap();

    let id = saved["id"].as_str().unwrap();
    assert!(!id.is_empty());
    assert_eq!(saved["name"], "Local");
    assert_eq!(saved["sslMode"], "prefer");
    assert_eq!(saved["safeMode"], "off");
    assert_eq!(saved["hasPassword"], true);
    assert_eq!(ipc.secrets.get(id).unwrap().as_deref(), Some("hunter2"));

    let listed = ipc.call("list_connections", json!({})).unwrap();
    assert_eq!(listed, json!([saved]));
    assert!(
        !listed.to_string().contains("hunter2"),
        "password in a list response"
    );
}

#[test]
fn the_three_password_changes_are_understood() {
    let ipc = setup();
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": config("A", "h", 5432), "password": { "kind": "set", "value": "one" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap().to_owned();

    let keep = ipc
        .call(
            "save_connection",
            json!({ "config": saved, "password": { "kind": "keep" } }),
        )
        .unwrap();
    assert_eq!(keep["hasPassword"], true);

    let cleared = ipc
        .call(
            "save_connection",
            json!({ "config": keep, "password": { "kind": "clear" } }),
        )
        .unwrap();
    assert_eq!(cleared["hasPassword"], false);
    assert_eq!(ipc.secrets.get(&id).unwrap(), None);
}

#[test]
fn errors_arrive_as_code_message_and_postgres_fields() {
    let ipc = setup();

    let err = ipc
        .call(
            "save_connection",
            json!({ "config": config("X", "", 5432), "password": { "kind": "keep" } }),
        )
        .unwrap_err();
    assert_eq!(
        err,
        json!({
            "code": "VALIDATION", "message": "Host is required",
            "pgCode": null, "detail": null, "hint": null, "position": null
        })
    );

    let err = ipc
        .call("connect_connection", json!({ "id": "nope" }))
        .unwrap_err();
    assert_eq!(err["code"], "CONNECTION_NOT_FOUND");
}

#[test]
fn duplicate_and_delete_work_through_ipc() {
    let ipc = setup();
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": config("Prod", "h", 5432), "password": { "kind": "set", "value": "pw" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();

    let copy = ipc
        .call("duplicate_connection", json!({ "id": id }))
        .unwrap();
    assert_eq!(copy["name"], "Prod copy");
    assert_eq!(copy["hasPassword"], true);
    let copy_id = copy["id"].as_str().unwrap();
    assert_eq!(ipc.secrets.get(copy_id).unwrap().as_deref(), Some("pw"));

    assert_eq!(
        ipc.call("delete_connection", json!({ "id": copy_id }))
            .unwrap(),
        Value::Null
    );
    assert_eq!(ipc.secrets.get(copy_id).unwrap(), None);
    assert_eq!(
        ipc.call("list_connections", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn parse_connection_url_fills_the_form_fields() {
    let ipc = setup();
    let parsed = ipc
        .call(
            "parse_connection_url",
            json!({ "url": "postgres://alice:p%40ss@db.example.com:6543/shop?sslmode=verify-full" }),
        )
        .unwrap();
    assert_eq!(
        parsed,
        json!({
            "name": "shop @ db.example.com", "host": "db.example.com", "port": 6543,
            "user": "alice", "password": "p@ss", "database": "shop", "sslMode": "verify-full"
        })
    );

    let err = ipc
        .call("parse_connection_url", json!({ "url": "mysql://x@y/z" }))
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
}

#[test]
fn test_connection_reports_an_unreachable_server_without_saving() {
    let ipc = setup();
    let err = ipc
        .call(
            "test_connection",
            json!({ "config": config("T", "127.0.0.1", 1), "password": { "kind": "keep" } }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "CONNECTION");
    assert!(
        err["message"].as_str().unwrap().contains("refused"),
        "{err}"
    );
    assert_eq!(ipc.call("list_connections", json!({})).unwrap(), json!([]));
}

/// The dev database, or `None` (test skipped) when it isn't running and isn't required.
fn dev_db_available() -> bool {
    let address: SocketAddr = "127.0.0.1:54329".parse().unwrap();
    if TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok() {
        return true;
    }
    assert!(
        std::env::var("ANGKORDB_REQUIRE_DB").map_or(true, |v| v != "1"),
        "the dev database is required but not reachable"
    );
    eprintln!("SKIPPED: dev database not reachable. Run `npm run db:up`.");
    false
}

#[test]
fn test_connect_and_disconnect_against_the_dev_database() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");

    // Test with a typed password, nothing saved yet.
    let tested = ipc
        .call(
            "test_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    assert!(tested["serverVersion"].as_str().unwrap().starts_with("16"));
    assert!(tested["latencyMs"].is_u64());
    assert_eq!(ipc.call("list_connections", json!({})).unwrap(), json!([]));

    // Wrong password: a Postgres error with its SQLSTATE.
    let err = ipc
        .call(
            "test_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "wrong" } }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "POSTGRES");
    assert_eq!(err["pgCode"], "28P01");

    // Save with the password, then open the saved connection: the Keychain-side lookup works.
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();

    let opened = ipc.call("connect_connection", json!({ "id": id })).unwrap();
    assert!(opened["serverVersion"].as_str().unwrap().starts_with("16"));
    assert_eq!(
        ipc.call("disconnect_connection", json!({ "id": id }))
            .unwrap(),
        Value::Null
    );

    // "Keep" while testing an edited saved connection uses the saved password.
    let again = ipc
        .call(
            "test_connection",
            json!({ "config": saved, "password": { "kind": "keep" } }),
        )
        .unwrap();
    assert!(again["serverVersion"].is_string());
}

#[test]
fn app_info_reports_name_and_version() {
    let ipc = setup();
    let info = ipc.call("app_info", json!({})).unwrap();
    assert_eq!(
        info,
        json!({ "name": "angkordb", "version": env!("CARGO_PKG_VERSION") })
    );
}

/// The bundle version comes from tauri.conf.json, the crate version from Cargo.toml.
#[test]
fn tauri_conf_and_cargo_versions_match() {
    let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(
        conf["version"],
        env!("CARGO_PKG_VERSION"),
        "bump both together"
    );
}

#[test]
fn schema_commands_need_an_open_connection() {
    let ipc = setup();
    for (cmd, args) in [
        ("list_databases", json!({ "connectionId": "nope" })),
        (
            "list_schemas",
            json!({ "connectionId": "nope", "includeSystem": false }),
        ),
        (
            "list_objects",
            json!({ "connectionId": "nope", "schema": "public" }),
        ),
        (
            "describe_table",
            json!({ "connectionId": "nope", "schema": "public", "table": "t" }),
        ),
        (
            "switch_database",
            json!({ "connectionId": "nope", "database": "postgres" }),
        ),
    ] {
        let err = ipc.call(cmd, args).unwrap_err();
        assert_eq!(err["code"], "NOT_CONNECTED", "{cmd}: {err}");
        assert_eq!(err["message"], "not connected to nope");
    }
}

#[test]
fn browse_the_dev_database_through_ipc() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    ipc.call("connect_connection", json!({ "id": id })).unwrap();

    let schemas = ipc
        .call(
            "list_schemas",
            json!({ "connectionId": id, "includeSystem": false }),
        )
        .unwrap();
    assert_eq!(
        schemas[0],
        json!({ "name": "public", "owner": "angkor", "isSystem": false })
    );

    let objects = ipc
        .call(
            "list_objects",
            json!({ "connectionId": id, "schema": "public" }),
        )
        .unwrap();
    let users = objects
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"] == "users")
        .expect("users is listed");
    assert_eq!(users["kind"], "table");
    assert_eq!(users["schema"], "public");
    assert_eq!(users["rowEstimate"], 205.0);
    assert!(users["oid"].is_u64());
    assert!(users["detail"].is_null());

    let table = ipc
        .call(
            "describe_table",
            json!({ "connectionId": id, "schema": "public", "table": "orders" }),
        )
        .unwrap();
    assert_eq!(
        table["identity"],
        json!({ "kind": "primaryKey", "columns": ["id"] })
    );
    let user_id = table["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "user_id")
        .unwrap();
    assert_eq!(user_id["typeName"], "bigint");
    assert_eq!(user_id["isPrimaryKey"], false);
    assert_eq!(user_id["nullable"], false);
    assert_eq!(user_id["foreignKeys"][0]["table"], "users");

    let err = ipc
        .call(
            "describe_table",
            json!({ "connectionId": id, "schema": "public", "table": "nope" }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "NOT_FOUND");

    // Switching database replaces the session: later calls run against the new database.
    let databases = ipc
        .call("list_databases", json!({ "connectionId": id }))
        .unwrap();
    assert!(
        databases
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["name"] == "postgres")
    );
    let switched = ipc
        .call(
            "switch_database",
            json!({ "connectionId": id, "database": "postgres" }),
        )
        .unwrap();
    assert!(switched["serverVersion"].is_string());
    let current = ipc
        .call("list_databases", json!({ "connectionId": id }))
        .unwrap();
    let current: Vec<_> = current
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["isCurrent"] == true)
        .map(|d| d["name"].clone())
        .collect();
    assert_eq!(current, [json!("postgres")]);

    // Disconnecting closes it: schema commands report "not connected" again.
    ipc.call("disconnect_connection", json!({ "id": id }))
        .unwrap();
    let err = ipc
        .call(
            "list_schemas",
            json!({ "connectionId": id, "includeSystem": false }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "NOT_CONNECTED");
}
