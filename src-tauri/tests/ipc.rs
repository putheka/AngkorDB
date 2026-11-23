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
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
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
    // Host keys go to a file of their own: never the real ~/.ssh/known_hosts.
    let state = AppState::new(ConnectionManager::new(dir.path(), secrets.clone()))
        .with_known_hosts(dir.path().join("known_hosts"));

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
    assert_eq!(info["name"], "angkordb");
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    // The commit the test binary was built from (the About window shows the same).
    let build = info["build"].as_str().unwrap();
    assert!(
        !build.is_empty() && build == env!("ANGKORDB_BUILD"),
        "{build}"
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
        (
            "fetch_rows",
            json!({ "connectionId": "nope", "query": {
                "schema": "public", "table": "t", "limit": 10, "offset": 0,
                "sort": [], "filters": [], "rawWhere": null } }),
        ),
        (
            "count_rows",
            json!({ "connectionId": "nope", "schema": "public", "table": "t",
                    "filters": [], "rawWhere": null, "exact": false }),
        ),
        (
            "list_enum_values",
            json!({ "connectionId": "nope", "typeOid": 16400 }),
        ),
        (
            "preview_changes",
            json!({ "connectionId": "nope", "schema": "public", "table": "t",
                    "changes": { "updates": [], "inserts": [], "deletes": [] } }),
        ),
        (
            "apply_changes",
            json!({ "connectionId": "nope", "schema": "public", "table": "t",
                    "changes": { "updates": [], "inserts": [], "deletes": [] } }),
        ),
        (
            "list_incoming_foreign_keys",
            json!({ "connectionId": "nope", "schema": "public", "table": "users" }),
        ),
        ("completion_schema", json!({ "connectionId": "nope" })),
        (
            "count_matching",
            json!({ "connectionId": "nope", "schema": "public", "table": "t",
                    "filters": [], "cap": 10 }),
        ),
        (
            "run_query",
            json!({ "connectionId": "nope", "tabId": "query:1", "sql": "SELECT 1" }),
        ),
        (
            "cancel_query",
            json!({ "connectionId": "nope", "tabId": "query:1" }),
        ),
        ("database_options", json!({ "connectionId": "nope" })),
        ("list_activity", json!({ "connectionId": "nope" })),
        ("list_roles", json!({ "connectionId": "nope" })),
        ("connection_health", json!({ "connectionId": "nope" })),
        (
            "start_backup",
            json!({ "connectionId": "nope", "request": { "toolsDir": null, "database": null,
                "path": "/tmp/x.dump", "format": "custom", "schemaOnly": false, "dataOnly": false,
                "includeTables": [], "excludeTables": [], "compression": null, "noOwner": true } }),
        ),
        (
            "start_restore",
            json!({ "connectionId": "nope", "request": { "toolsDir": null, "path": "/tmp/x.dump",
                "target": { "kind": "new", "database": "x" }, "clean": false, "noOwner": true,
                "jobs": 1 } }),
        ),
        (
            "start_import",
            json!({ "connectionId": "nope", "request": { "path": "/tmp/x.csv",
                "format": { "kind": "json" }, "onError": "abort",
                "target": { "kind": "new", "schema": "public", "table": "t", "columns": [] } } }),
        ),
        (
            "start_export",
            json!({ "connectionId": "nope", "request": { "source": { "kind": "query", "sql": "SELECT 1", "name": null },
                    "format": { "kind": "markdown" }, "path": "/tmp/x.md" } }),
        ),
        ("default_privileges", json!({ "connectionId": "nope" })),
        (
            "object_privileges",
            json!({ "connectionId": "nope",
                    "target": { "kind": "schema", "schema": "", "name": "public" } }),
        ),
        (
            "preview_privilege_changes",
            json!({ "connectionId": "nope", "changes": [] }),
        ),
        (
            "apply_privilege_changes",
            json!({ "connectionId": "nope", "changes": [] }),
        ),
        (
            "preview_role_operation",
            json!({ "connectionId": "nope", "operation": { "kind": "drop", "name": "x",
                    "reassignTo": null } }),
        ),
        (
            "apply_role_operation",
            json!({ "connectionId": "nope", "operation": { "kind": "drop", "name": "x",
                    "reassignTo": null } }),
        ),
        (
            "cancel_backend",
            json!({ "connectionId": "nope", "pid": 1 }),
        ),
        (
            "terminate_backend",
            json!({ "connectionId": "nope", "pid": 1 }),
        ),
        (
            "database_connections",
            json!({ "connectionId": "nope", "name": "x" }),
        ),
        (
            "object_definition",
            json!({ "connectionId": "nope", "kind": "function", "schema": "public",
                    "name": "f", "oid": 1 }),
        ),
        (
            "sequence_info",
            json!({ "connectionId": "nope", "schema": "public", "name": "s" }),
        ),
        (
            "preview_object_operation",
            json!({ "connectionId": "nope", "operation": { "kind": "truncate", "schema": "public",
                    "name": "t", "restartIdentity": false, "cascade": false } }),
        ),
        (
            "apply_object_operation",
            json!({ "connectionId": "nope", "operation": { "kind": "truncate", "schema": "public",
                    "name": "t", "restartIdentity": false, "cascade": false } }),
        ),
        (
            "preview_structure_changes",
            json!({ "connectionId": "nope", "schema": "public", "table": "t", "changes": [] }),
        ),
        (
            "apply_structure_changes",
            json!({ "connectionId": "nope", "schema": "public", "table": "t", "changes": [] }),
        ),
        (
            "table_structure",
            json!({ "connectionId": "nope", "schema": "public", "table": "users" }),
        ),
        (
            "explain_query",
            json!({ "connectionId": "nope", "tabId": "query:1", "sql": "SELECT 1", "analyze": false }),
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

    // What the cell editor sends for an enum column: the column's own type OID.
    let users = ipc
        .call(
            "describe_table",
            json!({ "connectionId": id, "schema": "public", "table": "users" }),
        )
        .unwrap();
    let status = users["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "status")
        .unwrap();
    let labels = ipc
        .call(
            "list_enum_values",
            json!({ "connectionId": id, "typeOid": status["typeOid"] }),
        )
        .unwrap();
    assert_eq!(labels, json!(["active", "invited", "suspended"]));
    assert_eq!(
        ipc.call(
            "list_enum_values",
            json!({ "connectionId": id, "typeOid": user_id["typeOid"] }),
        )
        .unwrap(),
        json!([])
    );

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

#[test]
fn fetch_and_count_rows_through_ipc() {
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

    // Exactly what the grid will send: camelCase keys, operators as strings, `null` for none.
    let page = ipc
        .call(
            "fetch_rows",
            json!({ "connectionId": id, "query": {
                "schema": "public", "table": "short_codes", "limit": 2, "offset": 0,
                "sort": [{ "column": "code", "dir": "desc" }],
                "filters": [{ "column": "label", "op": "iLike", "values": ["%a%"] }],
                "rawWhere": null } }),
        )
        .unwrap();
    assert_eq!(
        page,
        json!({
            "columns": [
                { "name": "code", "typeOid": 1043, "typeName": "character varying(3)" },
                { "name": "label", "typeOid": 25, "typeName": "text" },
            ],
            "rows": [["USA", "United States"], ["TH", "Thailand"]],
            "identity": { "kind": "primaryKey", "columns": ["code"] },
            "ctids": [],
            "hasMore": true,
        })
    );

    let completion = ipc
        .call("completion_schema", json!({ "connectionId": id }))
        .unwrap();
    assert!(
        completion["searchPath"]
            .as_array()
            .unwrap()
            .contains(&json!("public"))
    );
    let users = completion["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "users")
        .unwrap();
    assert_eq!(users["kind"], "table");
    assert_eq!(
        users["columns"][0],
        json!({ "name": "id", "typeName": "bigint" })
    );
    assert!(
        completion["functions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["name"] == "greet")
    );

    let incoming = ipc
        .call(
            "list_incoming_foreign_keys",
            json!({ "connectionId": id, "schema": "public", "table": "users" }),
        )
        .unwrap();
    assert_eq!(
        incoming,
        json!([{ "constraint": "orders_user_id_fkey", "schema": "public", "table": "orders",
                 "columns": ["user_id"], "referencedColumns": ["id"] }])
    );
    let referencing = ipc
        .call(
            "count_matching",
            json!({ "connectionId": id, "schema": "public", "table": "orders",
                    "filters": [{ "column": "user_id", "op": "eq", "values": ["1"] }],
                    "cap": 2 }),
        )
        .unwrap();
    assert_eq!(referencing["capped"], json!(true));
    assert_eq!(referencing["count"], json!(2));

    let count = ipc
        .call(
            "count_rows",
            json!({ "connectionId": id, "schema": "public", "table": "short_codes",
                    "filters": [{ "column": "code", "op": "isNull", "values": [] }],
                    "rawWhere": null, "exact": false }),
        )
        .unwrap();
    assert_eq!(count, json!({ "count": 0.0, "exact": true }));

    // Errors keep their shape.
    let err = ipc
        .call(
            "fetch_rows",
            json!({ "connectionId": id, "query": {
                "schema": "public", "table": "short_codes", "limit": 10, "offset": 0,
                "sort": [], "rawWhere": null,
                "filters": [{ "column": "nope", "op": "eq", "values": ["1"] }] } }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
}

#[test]
fn statement_at_needs_no_connection() {
    let ipc = setup();
    let sql = "SELECT 'ក😀';\nSELECT 2;";
    // Cursor in the second statement. Offsets are UTF-16 units: 😀 counts twice.
    let range = ipc
        .call("statement_at", json!({ "sql": sql, "cursor": 18 }))
        .unwrap();
    assert_eq!(range, json!({ "start": 14, "end": 22 }));
    assert_eq!(
        ipc.call("statement_at", json!({ "sql": "-- nothing", "cursor": 0 }))
            .unwrap(),
        json!(null)
    );
    // Closing the tab of a connection that isn't open is not an error.
    assert_eq!(
        ipc.call(
            "close_query_tab",
            json!({ "connectionId": "nope", "tabId": "query:1" })
        )
        .unwrap(),
        json!(null)
    );
}

#[test]
fn classify_sql_needs_no_connection_and_reports_utf16_ranges() {
    let ipc = setup();
    let sql = "SELECT 'ក😀';\nDELETE FROM t;\nCREATE TABLE x (i int); SET default_transaction_read_only = off";
    assert_eq!(
        ipc.call("classify_sql", json!({ "sql": sql })).unwrap(),
        json!([
            { "range": { "start": 0, "end": 12 }, "kind": "read", "command": "SELECT", "unlocksWrites": false },
            { "range": { "start": 14, "end": 27 }, "kind": "write", "command": "DELETE", "unlocksWrites": false },
            { "range": { "start": 29, "end": 51 }, "kind": "schema", "command": "CREATE", "unlocksWrites": false },
            { "range": { "start": 53, "end": 92 }, "kind": "read", "command": "SET", "unlocksWrites": true },
        ])
    );
    assert_eq!(
        ipc.call("classify_sql", json!({ "sql": "  -- only a comment" }))
            .unwrap(),
        json!([])
    );
}

#[test]
fn run_query_through_ipc() {
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

    let run = ipc
        .call(
            "run_query",
            json!({ "connectionId": id, "tabId": "query:1",
                    "sql": "SELECT 1 AS one, true AS yes, NULL::text AS nothing; UPDATE public.short_codes SET label = label WHERE false; SELEC 3" }),
        )
        .unwrap();

    // The exact shape the editor reads.
    let statements = run["statements"].as_array().unwrap();
    assert_eq!(statements.len(), 3);
    assert!(run["durationMs"].is_u64());

    assert_eq!(statements[0]["range"], json!({ "start": 0, "end": 51 }));
    assert!(statements[0]["durationMs"].is_u64());
    assert_eq!(
        statements[0]["outcome"],
        json!({
            "kind": "rows",
            "columns": [
                { "name": "one", "typeOid": 23, "typeName": "int4" },
                { "name": "yes", "typeOid": 16, "typeName": "bool" },
                { "name": "nothing", "typeOid": 25, "typeName": "text" },
            ],
            "rows": [["1", "true", null]],
            "truncated": false,
        })
    );
    assert_eq!(
        statements[1]["outcome"],
        json!({ "kind": "command", "command": "UPDATE", "affected": 0 })
    );
    let failed = &statements[2]["outcome"];
    assert_eq!(failed["kind"], "error");
    assert_eq!(failed["error"]["code"], "POSTGRES");
    assert_eq!(failed["error"]["pgCode"], "42601");
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("syntax error")
    );
    assert!(failed["error"]["detail"].is_null());
    assert!(failed["offset"].is_u64());

    // Nothing is running on the tab, but it has a connection now.
    assert_eq!(
        ipc.call(
            "cancel_query",
            json!({ "connectionId": id, "tabId": "query:1" })
        )
        .unwrap(),
        json!(true)
    );
    assert_eq!(
        ipc.call(
            "cancel_query",
            json!({ "connectionId": id, "tabId": "never-ran" })
        )
        .unwrap(),
        json!(false)
    );
    ipc.call(
        "close_query_tab",
        json!({ "connectionId": id, "tabId": "query:1" }),
    )
    .unwrap();
    assert_eq!(
        ipc.call(
            "cancel_query",
            json!({ "connectionId": id, "tabId": "query:1" })
        )
        .unwrap(),
        json!(false)
    );
}

#[test]
fn preview_and_apply_changes_through_ipc() {
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
    ipc.call(
        "run_query",
        json!({ "connectionId": id, "tabId": "query:ipc", "sql":
            "DROP SCHEMA IF EXISTS ang23_ipc CASCADE; CREATE SCHEMA ang23_ipc; \
             CREATE TABLE ang23_ipc.t (id serial PRIMARY KEY, name text, n numeric); \
             INSERT INTO ang23_ipc.t (name, n) VALUES ('a', 1), ('b', 2);" }),
    )
    .unwrap();

    // Exactly what the UI sends: camelCase, tagged unions, `kind` for every variant.
    let changes = json!({
        "updates": [{
            "row": { "kind": "key", "columns": ["id"], "values": ["1"] },
            "values": { "name": { "kind": "value", "text": "A!" }, "n": { "kind": "null" } },
        }],
        "inserts": [{ "values": { "name": { "kind": "value", "text": "c" } } }],
        "deletes": [{ "kind": "key", "columns": ["id"], "values": ["2"] }],
    });
    let args = |changes: &serde_json::Value| json!({ "connectionId": id, "schema": "ang23_ipc", "table": "t", "changes": changes });

    let shown = ipc.call("preview_changes", args(&changes)).unwrap();
    assert_eq!(
        shown,
        json!(
            "BEGIN;\n\
             DELETE FROM \"ang23_ipc\".\"t\" WHERE \"id\" = '2';\n\
             UPDATE \"ang23_ipc\".\"t\" SET \"name\" = 'A!', \"n\" = NULL WHERE \"id\" = '1';\n\
             INSERT INTO \"ang23_ipc\".\"t\" (\"name\") VALUES ('c');\n\
             COMMIT;"
        )
    );

    let result = ipc.call("apply_changes", args(&changes)).unwrap();
    assert_eq!(
        result,
        json!({ "updated": 1, "deleted": 1, "inserted": [["3", "c", null]] })
    );

    // A failure arrives as an error naming the change, with the Postgres details kept.
    let failing = json!({ "label": "main", "updates": [{
        "row": { "kind": "key", "columns": ["id"], "values": ["999"] },
        "values": { "name": { "kind": "value", "text": "x" } },
    }], "inserts": [], "deletes": [] });
    let err = ipc.call("apply_changes", args(&failing)).unwrap_err();
    assert_eq!(err["code"], "CHANGE_FAILED");
    assert_eq!(
        err["message"],
        "Change 1 of 1 (update row id = 999) failed: row changed or missing — nothing was saved."
    );

    // The connection's safe mode is enforced by the backend, not only by the UI.
    let mut read_only = config("Locked", "localhost", 54329);
    read_only["user"] = json!("angkor");
    read_only["database"] = json!("angkordb_dev");
    read_only["safeMode"] = json!("read-only");
    let locked = ipc
        .call(
            "save_connection",
            json!({ "config": read_only, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let locked_id = locked["id"].as_str().unwrap();
    ipc.call("connect_connection", json!({ "id": locked_id }))
        .unwrap();
    let err = ipc
        .call(
            "apply_changes",
            json!({ "connectionId": locked_id, "schema": "ang23_ipc", "table": "t",
                    "changes": changes }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
    assert_eq!(err["message"], "This connection is read-only (safe mode).");

    ipc.call(
        "run_query",
        json!({ "connectionId": id, "tabId": "query:ipc", "sql": "DROP SCHEMA ang23_ipc CASCADE" }),
    )
    .unwrap();
}

#[test]
fn unsaved_changes_are_remembered_and_drive_the_window_hooks() {
    use angkordb_lib::state::WindowHooks;
    use angkordb_lib::windows::Start;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, Ordering};

    let ipc = setup();
    let state = ipc._app.state::<AppState>();

    // Without hooks (as in tests) the commands still work and the counts are kept per window.
    assert_eq!(state.unsaved_changes(), 0);
    ipc.call(
        "set_unsaved_changes",
        json!({ "label": "main", "count": 3 }),
    )
    .unwrap();
    ipc.call(
        "set_unsaved_changes",
        json!({ "label": "window-2", "count": 2 }),
    )
    .unwrap();
    assert_eq!(state.unsaved_changes(), 5);
    ipc.call("quit_app", json!({ "label": "main" })).unwrap();
    ipc.call("close_window", json!({ "label": "window-2" }))
        .unwrap();
    assert_eq!(state.unsaved_changes(), 0);

    // With hooks: each window's edited dot follows "is there anything unsaved in it".
    let dots = Arc::new(Mutex::new(Vec::new()));
    let quits = Arc::new(AtomicU32::new(0));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(Mutex::new(Vec::new()));
    let opened = Arc::new(Mutex::new(Vec::new()));
    let focused = Arc::new(Mutex::new(Vec::new()));
    let opens = Arc::new(AtomicU32::new(0));
    let menus = Arc::new(Mutex::new(Vec::new()));
    state.set_window_hooks(WindowHooks {
        set_edited: {
            let dots = dots.clone();
            Box::new(move |label, edited| dots.lock().unwrap().push((label.to_owned(), edited)))
        },
        quit: {
            let quits = quits.clone();
            Box::new(move || {
                quits.fetch_add(1, Ordering::SeqCst);
            })
        },
        ask_quit: {
            let asked = asked.clone();
            Box::new(move |label| asked.lock().unwrap().push(label.to_owned()))
        },
        close_window: {
            let closed = closed.clone();
            Box::new(move |label| closed.lock().unwrap().push(label.to_owned()))
        },
        open_window: {
            let opened = opened.clone();
            Box::new(move |start| opened.lock().unwrap().push(start))
        },
        focus_window: {
            let focused = focused.clone();
            Box::new(move |label| focused.lock().unwrap().push(label.to_owned()))
        },
        open_settings: {
            let opens = opens.clone();
            Box::new(move || {
                opens.fetch_add(1, Ordering::SeqCst);
            })
        },
        update_menu: {
            let menus = menus.clone();
            Box::new(move |updates| menus.lock().unwrap().push(updates.len()))
        },
    });
    for count in [1, 4, 0] {
        ipc.call(
            "set_unsaved_changes",
            json!({ "label": "main", "count": count }),
        )
        .unwrap();
    }
    assert_eq!(
        *dots.lock().unwrap(),
        [
            ("main".to_owned(), true),
            ("main".to_owned(), true),
            ("main".to_owned(), false)
        ]
    );
    assert_eq!(state.unsaved_changes(), 0);

    // Quitting: the window that answers is done; the next one with edits is asked; with none
    // left the app exits.
    ipc.call(
        "set_unsaved_changes",
        json!({ "label": "window-2", "count": 1 }),
    )
    .unwrap();
    ipc.call(
        "set_unsaved_changes",
        json!({ "label": "main", "count": 1 }),
    )
    .unwrap();
    ipc.call("quit_app", json!({ "label": "main" })).unwrap();
    assert_eq!(*asked.lock().unwrap(), ["window-2"]);
    assert_eq!(quits.load(Ordering::SeqCst), 0);
    ipc.call("quit_app", json!({ "label": "window-2" }))
        .unwrap();
    assert_eq!(quits.load(Ordering::SeqCst), 1);
    assert_eq!(asked.lock().unwrap().len(), 1);

    // Closing a window is its own hook, and its edits stop counting.
    ipc.call(
        "set_unsaved_changes",
        json!({ "label": "window-2", "count": 2 }),
    )
    .unwrap();
    ipc.call("close_window", json!({ "label": "window-2" }))
        .unwrap();
    assert_eq!(*closed.lock().unwrap(), ["window-2"]);
    assert_eq!(state.unsaved_changes(), 0);

    // A connection is open in one window at a time: the second window is told no, and the
    // first is brought forward. It is free again once its window lets go.
    let claim = |label: &str, id: &str| {
        ipc.call(
            "claim_connection",
            json!({ "label": label, "connectionId": id }),
        )
        .unwrap()
    };
    assert_eq!(claim("main", "c1"), json!(true));
    assert_eq!(claim("window-3", "c1"), json!(false));
    assert_eq!(*focused.lock().unwrap(), ["main"]);
    assert_eq!(claim("window-3", "c2"), json!(true));
    ipc.call("release_connection", json!({ "label": "main" }))
        .unwrap();
    assert_eq!(claim("window-3", "c1"), json!(true));

    // New windows: blank, on the connection form, or on a connection.
    for args in [
        json!({ "connectionId": null, "newConnection": false }),
        json!({ "connectionId": null, "newConnection": true }),
        json!({ "connectionId": "c9", "newConnection": false }),
    ] {
        ipc.call("open_window", args).unwrap();
    }
    assert_eq!(
        *opened.lock().unwrap(),
        [
            Start::Welcome,
            Start::NewConnection,
            Start::Connection("c9".into())
        ]
    );

    // The settings window is asked for through the hook, once per call.
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    ipc.call("open_settings", json!({})).unwrap();
    ipc.call("open_settings", json!({})).unwrap();
    assert_eq!(opens.load(Ordering::SeqCst), 2);

    // The page's word on the menu items reaches the hook as it was sent.
    ipc.call(
        "update_menu",
        json!({ "label": "main", "updates": [
            { "id": "tabs.new", "accelerator": "Cmd+T", "enabled": true },
            { "id": "query.stop", "accelerator": null, "enabled": false } ] }),
    )
    .unwrap();
    assert_eq!(*menus.lock().unwrap(), [2]);
}

#[test]
fn history_and_saved_queries_through_ipc() {
    let ipc = setup();

    // Nothing yet; the arguments are the ones the UI sends.
    let none = ipc
        .call(
            "list_history",
            json!({ "query": "", "connectionId": null, "limit": 50, "offset": 0 }),
        )
        .unwrap();
    assert_eq!(none, json!([]));

    let saved = ipc
        .call(
            "save_query",
            json!({ "input": { "id": null, "connectionId": "c1", "name": "Orders",
                               "folder": "Reports", "sql": "SELECT * FROM orders" } }),
        )
        .unwrap();
    assert!(saved["id"].is_u64());
    assert_eq!(saved["connectionId"], "c1");
    assert_eq!(saved["folder"], "Reports");
    assert!(saved["createdAt"].is_number());

    let renamed = ipc
        .call(
            "save_query",
            json!({ "input": { "id": saved["id"], "connectionId": null, "name": "Orders 2",
                               "folder": "", "sql": "SELECT 2" } }),
        )
        .unwrap();
    assert_eq!(renamed["connectionId"], Value::Null);

    let listed = ipc
        .call("list_saved_queries", json!({ "connectionId": "other" }))
        .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "Orders 2");

    let invalid = ipc
        .call(
            "save_query",
            json!({ "input": { "id": null, "connectionId": null, "name": " ",
                               "folder": "", "sql": "SELECT 1" } }),
        )
        .unwrap_err();
    assert_eq!(invalid["code"], "VALIDATION");

    ipc.call("delete_saved_query", json!({ "id": saved["id"] }))
        .unwrap();
    let after = ipc
        .call("list_saved_queries", json!({ "connectionId": null }))
        .unwrap();
    assert_eq!(after, json!([]));

    ipc.call("clear_history", json!({ "connectionId": null }))
        .unwrap();
    ipc.call("delete_history_entry", json!({ "id": 1 }))
        .unwrap();
}

#[test]
fn running_queries_is_recorded_in_the_history_through_ipc() {
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

    ipc.call(
        "run_query",
        json!({ "connectionId": id, "tabId": "query:1",
                "sql": "SELECT 'é' AS first;\n  SELECT 2 AS second; SELEC 3" }),
    )
    .unwrap();

    let history = ipc
        .call(
            "list_history",
            json!({ "query": "", "connectionId": id, "limit": 50, "offset": 0 }),
        )
        .unwrap();
    let entries = history.as_array().unwrap();
    assert_eq!(entries.len(), 3);
    // Newest first, each statement on its own (not the whole script), with how it went.
    assert_eq!(entries[0]["sql"], "SELEC 3");
    assert_eq!(entries[0]["ok"], false);
    assert_eq!(entries[1]["sql"], "SELECT 2 AS second");
    assert_eq!(entries[1]["ok"], true);
    assert_eq!(entries[2]["sql"], "SELECT 'é' AS first");
    assert_eq!(entries[2]["connectionId"], id);
    assert!(entries[2]["durationMs"].is_u64());
    assert!(entries[2]["ranAt"].as_f64().unwrap() > 1.0e12);
}

#[test]
fn explain_through_ipc() {
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

    // The shape the plan view reads.
    let plain = ipc
        .call(
            "explain_query",
            json!({ "connectionId": id, "tabId": "query:1",
                    "sql": "SELECT * FROM public.users WHERE id = 1", "analyze": false }),
        )
        .unwrap();
    assert_eq!(plain["outcome"]["kind"], "plan");
    let plan: Value = serde_json::from_str(plain["outcome"]["json"].as_str().unwrap()).unwrap();
    assert!(plan[0]["Plan"]["Node Type"].is_string());
    assert_eq!(plain["analyzed"], false);
    assert_eq!(plain["rolledBack"], false);
    assert_eq!(plain["statementKind"], "read");
    assert_eq!(plain["command"], "SELECT");
    assert!(plain["durationMs"].is_u64());

    let analyzed = ipc
        .call(
            "explain_query",
            json!({ "connectionId": id, "tabId": "query:1",
                    "sql": "UPDATE public.short_codes SET label = label", "analyze": true }),
        )
        .unwrap();
    assert_eq!(analyzed["analyzed"], true);
    assert_eq!(analyzed["rolledBack"], true);
    assert_eq!(analyzed["statementKind"], "write");
    assert_eq!(analyzed["command"], "UPDATE");

    // A server error stays in the result, with where it is in the text.
    let failed = ipc
        .call(
            "explain_query",
            json!({ "connectionId": id, "tabId": "query:1",
                    "sql": "SELECT * FROM no_such_table", "analyze": false }),
        )
        .unwrap();
    assert_eq!(failed["outcome"]["kind"], "error");
    assert_eq!(failed["outcome"]["error"]["pgCode"], "42P01");
    assert_eq!(failed["outcome"]["offset"], 14);

    // Not exactly one statement: the command itself fails, with a message to show.
    let two = ipc
        .call(
            "explain_query",
            json!({ "connectionId": id, "tabId": "query:1", "sql": "SELECT 1; SELECT 2", "analyze": false }),
        )
        .unwrap_err();
    assert_eq!(two["code"], "VALIDATION");
}

#[test]
fn table_structure_through_ipc() {
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

    // The shape the Structure view reads.
    let s = ipc
        .call(
            "table_structure",
            json!({ "connectionId": id, "schema": "public", "table": "orders" }),
        )
        .unwrap();
    assert_eq!(s["schema"], "public");
    assert_eq!(s["kind"], "table");
    assert_eq!(s["info"]["owner"], "angkor");
    assert!(s["info"]["totalBytes"].is_number());
    assert!(s["info"]["rowEstimate"].is_number());
    assert_eq!(s["info"]["persistence"], "permanent");
    assert_eq!(s["columns"][0]["name"], "id");
    assert_eq!(s["columns"][0]["typeName"], "bigint");
    assert_eq!(s["columns"][0]["isPrimaryKey"], true);
    assert_eq!(s["columns"][0]["nullable"], false);
    assert_eq!(s["columns"][1]["foreignKeys"][0]["table"], "users");
    assert_eq!(s["indexes"][0]["name"], "orders_pkey");
    assert_eq!(s["indexes"][0]["constraint"], "orders_pkey");
    assert!(s["indexes"][0]["sizeBytes"].is_number());
    let kinds: Vec<&str> = s["constraints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["primaryKey", "check", "foreignKey"]);
    assert_eq!(s["constraints"][2]["references"], "public.users");
    assert!(
        s["ddl"]
            .as_str()
            .unwrap()
            .starts_with("CREATE TABLE public.orders (")
    );
    assert!(
        s["prerequisites"]
            .as_str()
            .unwrap()
            .contains("CREATE SEQUENCE public.orders_id_seq")
    );

    let users = ipc
        .call(
            "table_structure",
            json!({ "connectionId": id, "schema": "public", "table": "users" }),
        )
        .unwrap();
    assert_eq!(users["triggers"][0]["name"], "users_touch_updated_at");
    assert_eq!(users["triggers"][0]["timing"], "BEFORE");
    assert_eq!(users["triggers"][0]["state"], "enabled");
    assert_eq!(users["columns"][0]["identity"], "always");

    let err = ipc
        .call(
            "table_structure",
            json!({ "connectionId": id, "schema": "public", "table": "nope" }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "NOT_FOUND");
}

#[test]
fn structure_changes_through_ipc() {
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

    // A throwaway table in the dev database, removed at the end.
    let table = "ang37_ipc_scratch";
    let run = |sql: &str| {
        ipc.call(
            "run_query",
            json!({ "connectionId": id, "tabId": "query:1", "sql": sql }),
        )
        .unwrap()
    };
    run(&format!(
        "DROP TABLE IF EXISTS public.{table}; CREATE TABLE public.{table} (id integer PRIMARY KEY, label text)"
    ));

    // The JSON the editor sends: a tagged change with camelCase fields.
    let changes = json!([
        { "kind": "addColumn", "name": "added", "typeName": "integer", "nullable": false,
          "defaultValue": "0", "comment": null },
        { "kind": "alterColumn", "column": "label", "newName": "title", "typeName": null,
          "using": null, "nullable": null,
          "defaultValue": { "kind": "set", "expression": "'x'" },
          "comment": { "kind": "set", "text": "A title" } },
        { "kind": "createIndex", "name": "ang37_idx", "method": "btree",
          "columns": [{ "text": "added", "isExpression": false, "descending": true }],
          "unique": false, "whereClause": null, "concurrently": true },
        { "kind": "addForeignKey", "name": null, "columns": ["id"], "refSchema": "public",
          "refTable": table, "refColumns": ["id"], "onDelete": "cascade", "onUpdate": "noAction",
          "notValid": true },
    ]);
    let args =
        json!({ "connectionId": id, "schema": "public", "table": table, "changes": changes });

    let preview = ipc.call("preview_structure_changes", args.clone()).unwrap();
    let statements = preview["statements"].as_array().unwrap();
    assert_eq!(statements.len(), 6);
    assert_eq!(
        statements[0]["sql"],
        format!(
            "ALTER TABLE \"public\".\"{table}\" ADD COLUMN \"added\" integer DEFAULT 0 NOT NULL;"
        )
    );
    assert_eq!(statements[0]["change"], 1);
    assert_eq!(statements[0]["concurrent"], false);
    assert_eq!(statements[0]["destructive"], false);
    assert!(
        statements[3]["sql"]
            .as_str()
            .unwrap()
            .starts_with("COMMENT ON COLUMN")
    );
    assert!(
        statements[5]["sql"]
            .as_str()
            .unwrap()
            .ends_with("NOT VALID;")
    );
    let index = statements.iter().find(|s| s["concurrent"] == true).unwrap();
    assert!(
        index["sql"]
            .as_str()
            .unwrap()
            .starts_with("CREATE INDEX CONCURRENTLY \"ang37_idx\"")
    );
    let text = preview["sql"].as_str().unwrap();
    assert!(
        text.contains("In one transaction") && text.contains("CONCURRENTLY can't run"),
        "{text}"
    );

    let applied = ipc.call("apply_structure_changes", args).unwrap();
    assert_eq!(applied["statements"], 6);
    assert_eq!(applied["failedConcurrent"], Value::Null);

    let structure = ipc
        .call(
            "table_structure",
            json!({ "connectionId": id, "schema": "public", "table": table }),
        )
        .unwrap();
    let names: Vec<&str> = structure["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["id", "title", "added"]);
    assert!(
        structure["indexes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["name"] == "ang37_idx")
    );
    let fk = structure["constraints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "foreignKey")
        .unwrap();
    assert_eq!(fk["validated"], false);

    // A mistake in a change is a validation error that names the change.
    let bad = ipc
        .call(
            "preview_structure_changes",
            json!({ "connectionId": id, "schema": "public", "table": table, "changes": [
                { "kind": "addColumn", "name": "ok", "typeName": "text", "nullable": true,
                  "defaultValue": null, "comment": null },
                { "kind": "addColumn", "name": "x", "typeName": "text; DROP TABLE users",
                  "nullable": true, "defaultValue": null, "comment": null },
            ]}),
        )
        .unwrap_err();
    assert_eq!(bad["code"], "VALIDATION");
    assert!(
        bad["message"]
            .as_str()
            .unwrap()
            .starts_with("Change 2 of 2:"),
        "{bad}"
    );

    run(&format!("DROP TABLE public.{table}"));
}

#[test]
fn a_read_only_connection_refuses_structure_changes() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    form["safeMode"] = json!("read-only");
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    ipc.call("connect_connection", json!({ "id": id })).unwrap();

    let err = ipc
        .call(
            "apply_structure_changes",
            json!({ "connectionId": id, "schema": "public", "table": "users", "changes": [
                { "kind": "dropColumn", "column": "bio", "cascade": false }
            ]}),
        )
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
    assert!(
        err["message"].as_str().unwrap().contains("read-only"),
        "{err}"
    );
    // The preview is only text: it still works.
    let preview = ipc
        .call(
            "preview_structure_changes",
            json!({ "connectionId": id, "schema": "public", "table": "users", "changes": [
                { "kind": "dropColumn", "column": "bio", "cascade": false }
            ]}),
        )
        .unwrap();
    assert_eq!(preview["statements"][0]["destructive"], true);
}

#[test]
fn object_operations_through_ipc() {
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
    let run = |sql: &str| {
        ipc.call(
            "run_query",
            json!({ "connectionId": id, "tabId": "query:1", "sql": sql }),
        )
        .unwrap()
    };
    run("DROP TABLE IF EXISTS public.ang38_a, public.ang38_b");

    let create = json!({ "kind": "createTable", "schema": "public", "name": "ang38_a", "comment": null,
        "columns": [
            { "name": "id", "typeName": "bigint", "nullable": false, "defaultValue": null,
              "identity": "always", "primaryKey": true, "comment": null },
            { "name": "at", "typeName": "timestamp with time zone", "nullable": false,
              "defaultValue": "now()", "identity": null, "primaryKey": false, "comment": "When" }
        ] });
    let preview = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": create }),
        )
        .unwrap();
    assert_eq!(preview["statements"].as_array().unwrap().len(), 2);
    assert_eq!(preview["statements"][0]["destructive"], false);
    assert!(
        preview["sql"]
            .as_str()
            .unwrap()
            .contains("GENERATED ALWAYS AS IDENTITY")
    );
    assert_eq!(
        ipc.call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": create })
        )
        .unwrap(),
        2
    );

    let rename = json!({ "kind": "rename", "objectKind": "table", "schema": "public",
        "name": "ang38_a", "newName": "ang38_b" });
    ipc.call(
        "apply_object_operation",
        json!({ "connectionId": id, "operation": rename }),
    )
    .unwrap();
    let truncate = json!({ "kind": "truncate", "schema": "public", "name": "ang38_b",
        "restartIdentity": true, "cascade": false });
    let preview = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": truncate }),
        )
        .unwrap();
    assert_eq!(preview["statements"][0]["destructive"], true);
    assert!(
        preview["sql"]
            .as_str()
            .unwrap()
            .contains("RESTART IDENTITY")
    );
    ipc.call(
        "apply_object_operation",
        json!({ "connectionId": id, "operation": truncate }),
    )
    .unwrap();

    // A mistake is a validation error.
    let bad = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": { "kind": "createTable", "schema": "public",
                "name": "x", "comment": null, "columns": [] } }),
        )
        .unwrap_err();
    assert_eq!(bad["code"], "VALIDATION");

    let drop = json!({ "kind": "drop", "objectKind": "table", "schema": "public",
        "name": "ang38_b", "cascade": false });
    ipc.call(
        "apply_object_operation",
        json!({ "connectionId": id, "operation": drop }),
    )
    .unwrap();
    // Gone: a second drop fails with the server's message.
    let gone = ipc
        .call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": drop }),
        )
        .unwrap_err();
    assert_eq!(gone["code"], "POSTGRES");
}

#[test]
fn a_read_only_connection_refuses_object_operations() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    form["safeMode"] = json!("read-only");
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    ipc.call("connect_connection", json!({ "id": id })).unwrap();
    let err = ipc
        .call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": { "kind": "drop", "objectKind": "table",
                "schema": "public", "name": "users", "cascade": true } }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
    assert!(err["message"].as_str().unwrap().contains("read-only"));
}

#[test]
fn definitions_and_sequences_through_ipc() {
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

    // The oid comes from the sidebar's own listing.
    let objects = ipc
        .call(
            "list_objects",
            json!({ "connectionId": id, "schema": "public" }),
        )
        .unwrap();
    let find = |name: &str, kind: &str| {
        objects
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["name"] == name && o["kind"] == kind)
            .unwrap_or_else(|| panic!("{name} is not listed"))
            .clone()
    };
    let greet = find("greet", "function");
    let def = ipc
        .call(
            "object_definition",
            json!({ "connectionId": id, "kind": "function", "schema": "public",
                    "name": "greet", "oid": greet["oid"] }),
        )
        .unwrap();
    assert_eq!(def["title"], "greet()");
    let sql = def["sql"].as_str().unwrap();
    assert!(
        sql.starts_with("CREATE OR REPLACE FUNCTION public.greet"),
        "{sql}"
    );
    // PostgreSQL writes its own dollar-quote tag.
    assert!(
        sql.contains("$function$") && sql.contains("Hello; "),
        "{sql}"
    );

    let view = ipc
        .call(
            "object_definition",
            json!({ "connectionId": id, "kind": "view", "schema": "public",
                    "name": "user_order_totals", "oid": 0 }),
        )
        .unwrap();
    assert!(
        view["sql"]
            .as_str()
            .unwrap()
            .starts_with("CREATE OR REPLACE VIEW public.user_order_totals AS")
    );

    let seq = ipc
        .call(
            "sequence_info",
            json!({ "connectionId": id, "schema": "public", "name": "orders_id_seq" }),
        )
        .unwrap();
    assert_eq!(seq["dataType"], "bigint");
    assert_eq!(seq["increment"], "1");
    assert_eq!(seq["ownedBy"], "public.orders.id");
    assert!(seq["lastValue"].is_string());

    // Operations: the JSON the dialogs send.
    let set = json!({ "kind": "setSequence", "schema": "public", "name": "orders_id_seq",
        "value": "1000", "isCalled": true });
    let preview = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": set }),
        )
        .unwrap();
    assert!(
        preview["sql"]
            .as_str()
            .unwrap()
            .contains("setval('\"public\".\"orders_id_seq\"'::regclass, 1000, true)")
    );
    let add = json!({ "kind": "addEnumValue", "schema": "public", "name": "user_status",
        "value": "retired", "position": { "before": false, "existing": "suspended" },
        "ifNotExists": true });
    let preview = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": add }),
        )
        .unwrap();
    assert!(
        preview["sql"]
            .as_str()
            .unwrap()
            .contains("ADD VALUE IF NOT EXISTS 'retired' AFTER 'suspended'")
    );
    let refresh = json!({ "kind": "refreshMaterializedView", "schema": "billing",
        "name": "monthly_revenue", "concurrently": true, "withNoData": true });
    let bad = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": refresh }),
        )
        .unwrap_err();
    assert_eq!(bad["code"], "VALIDATION");
}

#[test]
fn databases_and_schemas_through_ipc() {
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

    let options = ipc
        .call("database_options", json!({ "connectionId": id }))
        .unwrap();
    assert_eq!(options["currentRole"], "angkor");
    assert!(
        options["templates"]
            .as_array()
            .unwrap()
            .contains(&json!("template0"))
    );
    assert!(
        options["encodings"]
            .as_array()
            .unwrap()
            .contains(&json!("UTF8"))
    );
    assert!(
        options["roles"]
            .as_array()
            .unwrap()
            .contains(&json!("angkor"))
    );

    let name = format!("angkordb_ddl_{}_ipc", std::process::id());
    let create = json!({ "kind": "createDatabase", "name": name, "owner": "angkor",
        "template": "template0", "encoding": "UTF8" });
    let preview = ipc
        .call(
            "preview_object_operation",
            json!({ "connectionId": id, "operation": create }),
        )
        .unwrap();
    assert_eq!(preview["statements"][0]["concurrent"], true);
    assert_eq!(preview["statements"][0]["destructive"], false);
    assert!(preview["sql"].as_str().unwrap().contains("ENCODING 'UTF8'"));
    assert_eq!(
        ipc.call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": create })
        )
        .unwrap(),
        1
    );
    assert_eq!(
        ipc.call(
            "database_connections",
            json!({ "connectionId": id, "name": name })
        )
        .unwrap(),
        0
    );
    let schema = json!({ "kind": "createSchema", "name": "ipc_s", "owner": null });
    let _ = schema;
    let drop = json!({ "kind": "dropDatabase", "name": name, "force": false });
    assert_eq!(
        ipc.call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": drop })
        )
        .unwrap(),
        1
    );
    // The one you are in is refused with a message.
    let current = json!({ "kind": "dropDatabase", "name": "angkordb_dev", "force": true });
    let err = ipc
        .call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": current }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
}

#[test]
fn the_process_list_through_ipc() {
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

    let list = ipc
        .call("list_activity", json!({ "connectionId": id }))
        .unwrap();
    let rows = list.as_array().unwrap();
    let me = rows
        .iter()
        .find(|r| r["isSelf"] == json!(true))
        .expect("this connection is in the list");
    assert_eq!(me["application"], "AngkorDB");
    assert!(me["pid"].is_u64());
    assert!(me["blockedBy"].is_array());

    // Stopping the connection the list is read with is refused; a pid nobody has is "not found".
    let own = me["pid"].as_u64().unwrap();
    let err = ipc
        .call(
            "terminate_backend",
            json!({ "connectionId": id, "pid": own }),
        )
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
    let gone = ipc
        .call(
            "cancel_backend",
            json!({ "connectionId": id, "pid": 2_000_000_000u64 }),
        )
        .unwrap();
    assert_eq!(gone, json!(false));
}

#[test]
fn a_read_only_connection_refuses_to_stop_a_backend() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    form["safeMode"] = json!("read-only");
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    ipc.call("connect_connection", json!({ "id": id })).unwrap();
    // Looking is fine; changing what others run is not.
    ipc.call("list_activity", json!({ "connectionId": id }))
        .unwrap();
    let err = ipc
        .call("cancel_backend", json!({ "connectionId": id, "pid": 1 }))
        .unwrap_err();
    assert_eq!(err["code"], "VALIDATION");
    assert!(err["message"].as_str().unwrap().contains("read-only"));
}

const ROLE_ATTRIBUTES: &str = r#"{ "canLogin": true, "superuser": false, "createDb": false,
    "createRole": false, "inherit": true, "replication": false, "bypassRls": false,
    "connectionLimit": null, "validUntil": null }"#;

fn dev_connection(ipc: &Ipc, safe_mode: &str) -> String {
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    form["safeMode"] = json!(safe_mode);
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap().to_owned();
    ipc.call("connect_connection", json!({ "id": id })).unwrap();
    id
}

#[test]
fn roles_and_privileges_through_ipc() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let id = dev_connection(&ipc, "off");
    let name = format!("angkordb_role_ipc_{}", std::process::id());
    let attributes: Value = serde_json::from_str(ROLE_ATTRIBUTES).unwrap();
    let _ = ipc.call(
        "apply_role_operation",
        json!({ "connectionId": id, "operation": { "kind": "drop", "name": name,
                "reassignTo": null } }),
    );

    let create = json!({ "kind": "create", "name": name, "attributes": attributes,
                         "password": "pa'ss\\word", "memberOf": [] });
    let preview = ipc
        .call(
            "preview_role_operation",
            json!({ "connectionId": id, "operation": create }),
        )
        .unwrap();
    let text = preview["sql"].as_str().unwrap();
    assert!(
        text.contains("CREATE ROLE") && text.contains("••••••••"),
        "{text}"
    );
    assert!(!text.contains("SCRAM") && !text.contains("pa'ss"), "{text}");
    assert_eq!(preview["statements"].as_array().unwrap().len(), 1);

    let ran = ipc
        .call(
            "apply_role_operation",
            json!({ "connectionId": id, "operation": create }),
        )
        .unwrap();
    assert_eq!(ran, json!(1));
    let roles = ipc
        .call("list_roles", json!({ "connectionId": id }))
        .unwrap();
    let mine = roles
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == json!(name))
        .expect("the new role is listed");
    assert_eq!(mine["canLogin"], json!(true));
    assert_eq!(mine["connectionLimit"], json!(null));
    assert_eq!(mine["memberOf"], json!([]));
    assert_eq!(mine["predefined"], json!(false));

    let alter = json!({ "kind": "alter", "name": name, "newName": null, "attributes": attributes,
                        "password": { "kind": "keep" }, "memberOf": ["pg_read_all_data"],
                        "previousMemberOf": [] });
    ipc.call(
        "apply_role_operation",
        json!({ "connectionId": id, "operation": alter }),
    )
    .unwrap();

    // The matrix of a table, a change through it, and the defaults.
    let target = json!({ "kind": "relation", "schema": "public", "name": "users" });
    let matrix = ipc
        .call(
            "object_privileges",
            json!({ "connectionId": id, "target": target }),
        )
        .unwrap();
    assert_eq!(matrix["privileges"][0], json!("SELECT"));
    assert_eq!(matrix["rows"][0]["grantee"], json!(null));
    let grant =
        json!([{ "target": target, "grantee": name, "privilege": "SELECT", "grant": true }]);
    let shown = ipc
        .call(
            "preview_privilege_changes",
            json!({ "connectionId": id, "changes": grant }),
        )
        .unwrap();
    assert!(shown["sql"].as_str().unwrap().contains(&format!(
        "GRANT SELECT ON TABLE \"public\".\"users\" TO \"{name}\";"
    )));
    ipc.call(
        "apply_privilege_changes",
        json!({ "connectionId": id, "changes": grant }),
    )
    .unwrap();
    let after = ipc
        .call(
            "object_privileges",
            json!({ "connectionId": id, "target": target }),
        )
        .unwrap();
    let row = after["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["grantee"] == json!(name))
        .unwrap();
    assert_eq!(row["granted"], json!(["SELECT"]));
    assert!(
        ipc.call("default_privileges", json!({ "connectionId": id }))
            .unwrap()
            .is_array()
    );

    // A bad privilege is a validation error before anything runs.
    let bad = ipc
        .call(
            "preview_privilege_changes",
            json!({ "connectionId": id, "changes": [{ "target": target, "grantee": name,
                    "privilege": "USAGE", "grant": true }] }),
        )
        .unwrap_err();
    assert_eq!(bad["code"], "VALIDATION");

    ipc.call(
        "apply_privilege_changes",
        json!({ "connectionId": id, "changes": [{ "target": target, "grantee": name,
                "privilege": "SELECT", "grant": false }] }),
    )
    .unwrap();
    ipc.call(
        "apply_role_operation",
        json!({ "connectionId": id, "operation": { "kind": "drop", "name": name,
                "reassignTo": null } }),
    )
    .unwrap();
}

#[test]
fn a_read_only_connection_refuses_role_and_privilege_changes() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let id = dev_connection(&ipc, "read-only");
    // Looking is fine.
    ipc.call("list_roles", json!({ "connectionId": id }))
        .unwrap();
    for (cmd, args) in [
        (
            "apply_role_operation",
            json!({ "connectionId": id, "operation": { "kind": "drop", "name": "x",
                    "reassignTo": null } }),
        ),
        (
            "apply_privilege_changes",
            json!({ "connectionId": id, "changes": [] }),
        ),
    ] {
        let err = ipc.call(cmd, args).unwrap_err();
        assert_eq!(err["code"], "VALIDATION", "{cmd}");
        assert!(err["message"].as_str().unwrap().contains("read-only"));
    }
}

fn ssh_env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

/// The test SSH server (`npm run db:up`), or `false` to skip.
fn ssh_available() -> bool {
    let port: u16 = ssh_env("ANGKORDB_TEST_SSH_PORT", "2222").parse().unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok() {
        return true;
    }
    assert!(
        std::env::var("ANGKORDB_REQUIRE_DB").as_deref() != Ok("1"),
        "the test SSH server is not reachable: run `npm run db:up`"
    );
    eprintln!("SKIPPED: test SSH server not reachable. Run `npm run db:up`.");
    false
}

#[test]
fn trusting_and_testing_ssh_need_nothing_open() {
    let ipc = setup();
    let unknown = ipc
        .call("trust_ssh_host", json!({ "fingerprint": "SHA256:nothing" }))
        .unwrap_err();
    assert_eq!(unknown["code"], "VALIDATION");
    // A form without a tunnel has nothing to test.
    let direct = ipc
        .call(
            "test_ssh",
            json!({ "config": config("Plain", "localhost", 5432), "sshSecret": null }),
        )
        .unwrap_err();
    assert_eq!(direct["code"], "VALIDATION");
}

#[test]
fn an_ssh_tunnel_through_ipc_asks_about_the_host_key_then_connects() {
    if !dev_db_available() || !ssh_available() {
        return;
    }
    let ipc = setup();
    let ssh_host = ssh_env("ANGKORDB_TEST_SSH_HOST", "localhost");
    let mut form = config(
        "Over SSH",
        &ssh_env("ANGKORDB_TEST_SSH_DB_HOST", "postgres"),
        5432,
    );
    form["port"] = json!(
        ssh_env("ANGKORDB_TEST_SSH_DB_PORT", "5432")
            .parse::<u16>()
            .unwrap()
    );
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    form["ssh"] = json!({
        "host": ssh_host,
        "port": ssh_env("ANGKORDB_TEST_SSH_PORT", "2222").parse::<u16>().unwrap(),
        "user": "tunnel", "auth": { "kind": "password" }, "hasSecret": false
    });
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" },
                    "sshSecret": { "kind": "set", "value": "tunnel" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    assert_eq!(saved["ssh"]["hasSecret"], json!(true));
    // The secret is in the Keychain stand-in under its own account; the file has none of it.
    assert_eq!(
        ipc.secrets.get(&format!("{id}:ssh")).unwrap().as_deref(),
        Some("tunnel")
    );
    let listed = ipc.call("list_connections", json!({})).unwrap();
    assert!(!listed.to_string().contains("sshSecret"));

    // First time: the host key is not trusted. The error carries what the dialog shows.
    let stopped = ipc
        .call("connect_connection", json!({ "id": id }))
        .unwrap_err();
    assert_eq!(stopped["code"], "SSH_HOST_UNKNOWN");
    let fingerprint = stopped["detail"].as_str().unwrap().to_owned();
    assert!(fingerprint.starts_with("SHA256:"), "{stopped}");
    assert!(stopped["hint"].as_str().unwrap().contains(&ssh_host));
    // The form's test stops there too, and the SSH-only test as well.
    let test = ipc
        .call(
            "test_connection",
            json!({ "config": saved, "password": { "kind": "keep" }, "sshSecret": null }),
        )
        .unwrap_err();
    assert_eq!(test["code"], "SSH_HOST_UNKNOWN");
    let ssh_only = ipc
        .call("test_ssh", json!({ "config": saved, "sshSecret": null }))
        .unwrap_err();
    assert_eq!(ssh_only["code"], "SSH_HOST_UNKNOWN");

    ipc.call("trust_ssh_host", json!({ "fingerprint": fingerprint }))
        .unwrap();
    // Trusting is once: the same fingerprint is not waiting any more.
    assert_eq!(
        ipc.call("trust_ssh_host", json!({ "fingerprint": fingerprint }))
            .unwrap_err()["code"],
        "VALIDATION"
    );

    let report = ipc
        .call("test_ssh", json!({ "config": saved, "sshSecret": null }))
        .unwrap();
    assert_eq!(report["reachesDatabase"], json!(true));
    assert_eq!(report["fingerprint"], json!(fingerprint));
    let tested = ipc
        .call(
            "test_connection",
            json!({ "config": saved, "password": { "kind": "keep" }, "sshSecret": null }),
        )
        .unwrap();
    assert!(tested["serverVersion"].as_str().unwrap().starts_with("16"));

    ipc.call("connect_connection", json!({ "id": id })).unwrap();
    let schemas = ipc
        .call(
            "list_schemas",
            json!({ "connectionId": id, "includeSystem": false }),
        )
        .unwrap();
    assert!(
        schemas
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "public")
    );
    ipc.call("disconnect_connection", json!({ "id": id }))
        .unwrap();

    ipc.call("delete_connection", json!({ "id": id })).unwrap();
    assert_eq!(ipc.secrets.get(&format!("{id}:ssh")).unwrap(), None);
}

/// The TLS test server (`npm run db:up`) and its certificates, or `None` to skip.
fn tls_certs() -> Option<std::path::PathBuf> {
    let port: u16 = ssh_env("ANGKORDB_TEST_TLS_PORT", "54330").parse().unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let certs = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev/tls/certs");
    if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok()
        && certs.join("ca.crt").exists()
    {
        return Some(certs);
    }
    assert!(
        std::env::var("ANGKORDB_REQUIRE_DB").as_deref() != Ok("1"),
        "the TLS test server is not reachable: run `npm run db:up`"
    );
    eprintln!("SKIPPED: TLS test server not reachable. Run `npm run db:up`.");
    None
}

#[test]
fn certificate_files_and_the_key_passphrase_through_ipc() {
    let Some(certs) = tls_certs() else {
        return;
    };
    let ipc = setup();
    let path = |name: &str| certs.join(name).display().to_string();
    let port: u16 = ssh_env("ANGKORDB_TEST_TLS_PORT", "54330").parse().unwrap();
    let mut form = config("Managed", "localhost", port);
    form["user"] = json!("certuser");
    form["database"] = json!("angkordb_dev");
    form["sslMode"] = json!("verify-full");
    form["sslFiles"] = json!({
        "rootCert": path("ca.crt"), "clientCert": path("client.crt"),
        "clientKey": path("client-protected.key"), "hasKeySecret": false
    });
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "keep" }, "sshSecret": null,
                    "sslKeySecret": { "kind": "set", "value": "angkor-key" } }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    assert_eq!(saved["sslFiles"]["hasKeySecret"], json!(true));
    assert_eq!(
        ipc.secrets.get(&format!("{id}:sslkey")).unwrap().as_deref(),
        Some("angkor-key")
    );

    // Saved passphrase: the form's test and a real connection both use it.
    let tested = ipc
        .call(
            "test_connection",
            json!({ "config": saved, "password": { "kind": "keep" }, "sshSecret": null,
                    "sslKeySecret": null }),
        )
        .unwrap();
    assert!(tested["serverVersion"].as_str().unwrap().starts_with("16"));
    // A passphrase typed in the form wins over the saved one.
    let wrong = ipc
        .call(
            "test_connection",
            json!({ "config": saved, "password": { "kind": "keep" }, "sshSecret": null,
                    "sslKeySecret": { "kind": "set", "value": "nope" } }),
        )
        .unwrap_err();
    assert_eq!(wrong["code"], "VALIDATION");
    assert!(
        wrong["message"]
            .as_str()
            .unwrap()
            .contains("passphrase is wrong"),
        "{wrong}"
    );

    ipc.call("connect_connection", json!({ "id": id })).unwrap();
    let schemas = ipc
        .call(
            "list_schemas",
            json!({ "connectionId": id, "includeSystem": false }),
        )
        .unwrap();
    assert!(
        schemas
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "public")
    );
    ipc.call("disconnect_connection", json!({ "id": id }))
        .unwrap();

    ipc.call("delete_connection", json!({ "id": id })).unwrap();
    assert_eq!(ipc.secrets.get(&format!("{id}:sslkey")).unwrap(), None);
}

#[test]
fn an_export_through_ipc_runs_reports_progress_and_can_be_cancelled() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let mut form = config("Dev", "localhost", 54329);
    form["user"] = json!("angkor");
    form["database"] = json!("angkordb_dev");
    // Exporting only reads, so a read-only connection may do it.
    form["safeMode"] = json!("read-only");
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": form, "password": { "kind": "set", "value": "angkor" },
                    "sshSecret": null, "sslKeySecret": null }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();
    ipc.call("connect_connection", json!({ "id": id })).unwrap();
    let dir = tempfile::tempdir().unwrap();

    let wait = |export: &str| -> Value {
        for _ in 0..400 {
            let status = ipc.call("export_status", json!({ "id": export })).unwrap();
            if status["state"] != "running" {
                return status;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the export never finished");
    };

    let file = dir.path().join("users.json");
    let export = ipc
        .call(
            "start_export",
            json!({ "connectionId": id, "request": {
                "source": { "kind": "table", "schema": "public", "table": "users", "filters": [],
                            "rawWhere": null, "sort": [{ "column": "id", "dir": "asc" }] },
                "format": { "kind": "json", "ndjson": true },
                "path": file.display().to_string() } }),
        )
        .unwrap();
    let export = export.as_str().unwrap().to_owned();
    let status = wait(&export);
    assert_eq!(status["state"], "done", "{status}");
    assert!(status["rows"].as_f64().unwrap() >= 200.0);
    assert_eq!(status["files"], json!([file.display().to_string()]));
    assert!(status["error"].is_null());
    let lines = std::fs::read_to_string(&file).unwrap();
    assert_eq!(
        lines.lines().count() as f64,
        status["rows"].as_f64().unwrap()
    );
    assert_eq!(status["bytes"].as_f64().unwrap() as usize, lines.len());

    // The SQL format takes its batch size in camelCase like everything the UI sends.
    let sql_file = dir.path().join("users.sql");
    let sql_export = ipc
        .call(
            "start_export",
            json!({ "connectionId": id, "request": {
                "source": { "kind": "query", "sql": "SELECT 1 AS a, 'x' AS b", "name": "t" },
                "format": { "kind": "sql", "batchSize": 10 },
                "path": sql_file.display().to_string() } }),
        )
        .unwrap();
    assert_eq!(wait(sql_export.as_str().unwrap())["state"], "done");
    assert_eq!(
        std::fs::read_to_string(&sql_file).unwrap(),
        "INSERT INTO \"t\" (\"a\", \"b\") VALUES\n  (1, 'x');\n"
    );

    // A failure is a status, with the error the UI shows.
    let bad = ipc
        .call(
            "start_export",
            json!({ "connectionId": id, "request": {
                "source": { "kind": "query", "sql": "SELECT * FROM no_such_table", "name": null },
                "format": { "kind": "csv", "delimiter": ",", "quote": "\"", "header": true, "nullText": "" },
                "path": dir.path().join("bad.csv").display().to_string() } }),
        )
        .unwrap();
    let failed = wait(bad.as_str().unwrap());
    assert_eq!(failed["state"], "failed");
    assert_eq!(failed["error"]["code"], "POSTGRES");
    assert!(!dir.path().join("bad.csv").exists());

    // Cancel a big one.
    let big = ipc
        .call(
            "start_export",
            json!({ "connectionId": id, "request": {
                "source": { "kind": "table", "schema": "public", "table": "metrics_big", "filters": [],
                            "rawWhere": null, "sort": [] },
                "format": { "kind": "csv", "delimiter": ",", "quote": "\"", "header": true, "nullText": "" },
                "path": dir.path().join("big.csv").display().to_string() } }),
        )
        .unwrap();
    let big = big.as_str().unwrap().to_owned();
    assert_eq!(
        ipc.call("cancel_export", json!({ "id": big })).unwrap(),
        json!(true)
    );
    let cancelled = wait(&big);
    assert_eq!(cancelled["state"], "cancelled");
    assert!(!dir.path().join("big.csv").exists());
    assert_eq!(
        ipc.call("cancel_export", json!({ "id": "nope" })).unwrap(),
        json!(false)
    );
    assert_eq!(
        ipc.call("export_status", json!({ "id": "nope" }))
            .unwrap_err()["code"],
        "NOT_FOUND"
    );
}

#[test]
fn an_import_through_ipc_previews_runs_reports_errors_and_is_refused_when_read_only() {
    if !dev_db_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("people.csv");
    std::fs::write(&file, "id,name\n1,Ann\n2,Bob\nx,Cy\n4,Di\n").unwrap();
    let format =
        json!({ "kind": "csv", "delimiter": ",", "quote": "\"", "header": true, "nullText": "" });

    let ipc = setup();
    // The preview needs no connection.
    let shown = ipc
        .call(
            "preview_import",
            json!({ "request": { "path": file.display().to_string(), "format": format } }),
        )
        .unwrap();
    assert_eq!(shown["columns"], json!(["id", "name"]));
    assert_eq!(shown["rows"][1], json!(["2", "Bob"]));
    assert_eq!(shown["suggestedTypes"], json!(["text", "text"])); // "x" is in the ids
    assert_eq!(shown["moreRows"], json!(false));
    let missing = ipc
        .call(
            "preview_import",
            json!({ "request": { "path": "/nonexistent/x.csv", "format": format } }),
        )
        .unwrap_err();
    assert_eq!(missing["code"], "VALIDATION");

    let id = dev_connection(&ipc, "off");
    let table = format!("angkordb_import_ipc_{}", std::process::id());
    let target = json!({ "kind": "new", "schema": "public", "table": table, "columns": [
        { "source": "id", "name": "id", "typeName": "integer" },
        { "source": "name", "name": "name", "typeName": "text" } ] });
    let wait = |job: &str| -> Value {
        for _ in 0..400 {
            let status = ipc.call("import_status", json!({ "id": job })).unwrap();
            if status["state"] != "running" {
                return status;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the import never finished");
    };
    let drop_table = || {
        let _ = ipc.call(
            "apply_object_operation",
            json!({ "connectionId": id, "operation": { "kind": "drop", "objectKind": "table",
                "schema": "public", "name": table, "cascade": false } }),
        );
    };
    drop_table();

    // Skipping bad rows: three go in, one is listed with its line.
    let job = ipc
        .call(
            "start_import",
            json!({ "connectionId": id, "request": { "path": file.display().to_string(),
                "format": format, "target": target, "onError": "skip" } }),
        )
        .unwrap();
    let status = wait(job.as_str().unwrap());
    assert_eq!(status["state"], "done", "{status}");
    assert_eq!(status["rowsWritten"], json!(3.0));
    assert_eq!(status["rowsSkipped"], json!(1.0));
    assert_eq!(status["errors"][0]["at"], "line 4");
    assert_eq!(status["table"], format!("public.{table}"));
    assert_eq!(status["bytesRead"], status["bytesTotal"]);

    // Aborting: the whole import fails with the line, and the table is not made.
    drop_table();
    let job = ipc
        .call(
            "start_import",
            json!({ "connectionId": id, "request": { "path": file.display().to_string(),
                "format": format, "target": target, "onError": "abort" } }),
        )
        .unwrap();
    let failed = wait(job.as_str().unwrap());
    assert_eq!(failed["state"], "failed");
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Line 4:"),
        "{failed}"
    );
    assert_eq!(failed["rowsWritten"], json!(0.0));
    drop_table();
    assert_eq!(
        ipc.call("cancel_import", json!({ "id": "nope" })).unwrap(),
        json!(false)
    );
    assert_eq!(
        ipc.call("import_status", json!({ "id": "nope" }))
            .unwrap_err()["code"],
        "NOT_FOUND"
    );

    // A read-only connection can't import.
    let read_only = dev_connection(&ipc, "read-only");
    let refused = ipc
        .call(
            "start_import",
            json!({ "connectionId": read_only, "request": { "path": file.display().to_string(),
                "format": format, "target": target, "onError": "abort" } }),
        )
        .unwrap_err();
    assert_eq!(refused["code"], "VALIDATION");
    assert!(refused["message"].as_str().unwrap().contains("read-only"));
}

#[test]
fn a_backup_through_ipc_runs_on_a_read_only_connection_but_a_restore_does_not() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let tools = ipc
        .call("detect_pg_tools", json!({ "toolsDir": null }))
        .unwrap();
    let Some(first) = tools.as_array().unwrap().first() else {
        assert!(
            std::env::var("ANGKORDB_REQUIRE_DB").as_deref() != Ok("1"),
            "pg_dump is needed"
        );
        return;
    };
    assert!(first["major"].as_u64().unwrap() >= 9 && first["dir"].is_string());
    assert!(
        first["version"]
            .as_str()
            .unwrap()
            .starts_with(&first["major"].to_string())
    );

    let id = dev_connection(&ipc, "read-only");
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("dev.dump");
    let job = ipc
        .call(
            "start_backup",
            json!({ "connectionId": id, "request": { "toolsDir": null, "database": "postgres",
                "path": file.display().to_string(), "format": "custom", "schemaOnly": true,
                "dataOnly": false, "includeTables": [], "excludeTables": [],
                "compression": 5, "noOwner": true } }),
        )
        .unwrap();
    let job = job.as_str().unwrap().to_owned();
    let status = loop {
        let status = ipc.call("tool_status", json!({ "id": job })).unwrap();
        if status["state"] != "running" {
            break status;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(status["state"], "done", "{status}");
    assert_eq!(status["output"], json!(file.display().to_string()));
    assert!(status["bytes"].as_f64().unwrap() > 100.0);
    assert!(!status["command"].as_str().unwrap().contains("PGPASSWORD"));
    assert!(std::fs::read(&file).unwrap().starts_with(b"PGDMP"));

    // Restoring writes: refused here.
    let refused = ipc
        .call(
            "start_restore",
            json!({ "connectionId": id, "request": { "toolsDir": null,
                "path": file.display().to_string(),
                "target": { "kind": "new", "database": "angkordb_ipc_never" },
                "clean": false, "noOwner": true, "jobs": 1 } }),
        )
        .unwrap_err();
    assert_eq!(refused["code"], "VALIDATION");
    assert!(refused["message"].as_str().unwrap().contains("read-only"));
    assert_eq!(
        ipc.call("cancel_tool", json!({ "id": "nope" })).unwrap(),
        json!(false)
    );
    assert_eq!(
        ipc.call("tool_status", json!({ "id": "nope" }))
            .unwrap_err()["code"],
        "NOT_FOUND"
    );
}

#[test]
fn the_connection_health_is_asked_for_through_ipc() {
    if !dev_db_available() {
        return;
    }
    let ipc = setup();
    let id = dev_connection(&ipc, "off");
    let health = ipc
        .call("connection_health", json!({ "connectionId": id }))
        .unwrap();
    assert_eq!(health["reconnecting"], json!(false));
    assert_eq!(health["reconnects"], json!(0));
}

#[test]
fn connections_move_between_macs_in_a_file_without_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("connections.json");
    let path = file.display().to_string();

    let source = setup();
    let mut prod = config("Production", "db.example.com", 5432);
    prod["sslMode"] = json!("verify-full");
    prod["color"] = json!("red");
    prod["safeMode"] = json!("read-only");
    prod["ssh"] = json!({ "host": "bastion", "port": 22, "user": "deploy",
        "auth": { "kind": "password" }, "hasSecret": false,
        "jump": { "host": "gateway.example.com", "port": 2200, "user": "hop",
                  "auth": { "kind": "password" }, "hasSecret": false } });
    prod["sslFiles"] = json!({ "rootCert": "/certs/ca.crt", "clientCert": "/certs/c.crt",
        "clientKey": "/certs/c.key", "hasKeySecret": false });
    let saved = source
        .call(
            "save_connection",
            json!({ "config": prod, "password": { "kind": "set", "value": "db-pass-123" },
                    "sshSecret": { "kind": "set", "value": "ssh-pass-456" },
                    "sslKeySecret": { "kind": "set", "value": "key-pass-789" },
                    "sshJumpSecret": { "kind": "set", "value": "jump-pass-321" } }),
        )
        .unwrap();
    assert_eq!(saved["ssh"]["jump"]["hasSecret"], json!(true));
    assert_eq!(
        source
            .secrets
            .get(&format!("{}:sshjump", saved["id"].as_str().unwrap()))
            .unwrap()
            .as_deref(),
        Some("jump-pass-321")
    );
    let plain = source
        .call(
            "save_connection",
            json!({ "config": config("Plain", "localhost", 5432),
                    "password": { "kind": "keep" }, "sshSecret": null, "sslKeySecret": null }),
        )
        .unwrap();
    let ids = json!([saved["id"], plain["id"]]);

    // Nothing to export, an unknown connection, a relative path, a folder that isn't there.
    for (args, code) in [
        (json!({ "ids": [], "path": path }), "VALIDATION"),
        (
            json!({ "ids": ["nope"], "path": path }),
            "CONNECTION_NOT_FOUND",
        ),
        (json!({ "ids": ids, "path": "relative.json" }), "VALIDATION"),
        (
            json!({ "ids": ids, "path": "/nonexistent-folder/x.json" }),
            "VALIDATION",
        ),
    ] {
        assert_eq!(
            source.call("export_connections", args).unwrap_err()["code"],
            code
        );
    }
    let count = source
        .call("export_connections", json!({ "ids": ids, "path": path }))
        .unwrap();
    assert_eq!(count, json!(2));

    // The file holds the settings and no secret, and not the connection's id.
    let text = std::fs::read_to_string(&file).unwrap();
    for secret in [
        "db-pass-123",
        "ssh-pass-456",
        "key-pass-789",
        "jump-pass-321",
    ] {
        assert!(!text.contains(secret), "{secret} is in the file");
    }
    assert!(!text.contains(saved["id"].as_str().unwrap()));
    assert!(
        text.contains("db.example.com")
            && text.contains("bastion")
            && text.contains("gateway.example.com")
            && text.contains("/certs/ca.crt")
    );
    assert!(!dir.path().join("connections.json.part").exists());

    // Another Mac: read it, then import with the secrets typed there.
    let target = setup();
    let shown = target
        .call("read_connection_file", json!({ "path": path }))
        .unwrap();
    assert_eq!(shown[0]["name"], "Production");
    assert_eq!(
        (
            shown[0]["needsPassword"].clone(),
            shown[0]["needsSshSecret"].clone(),
            shown[0]["needsSslKeySecret"].clone()
        ),
        (json!(true), json!(true), json!(true))
    );
    assert_eq!(shown[0]["needsSshJumpSecret"], json!(true));
    assert_eq!(shown[0]["ssh"]["jump"]["host"], "gateway.example.com");
    assert_eq!(shown[0]["ssh"]["jump"]["hasSecret"], json!(false));
    assert_eq!(shown[1]["needsPassword"], json!(false));
    assert_eq!(shown[0]["ssh"]["hasSecret"], json!(false));
    assert_eq!(shown[0]["color"], "red");

    let imported = target
        .call(
            "import_connections",
            json!({ "entries": [
                { "connection": shown[0], "password": "new-db-pass", "sshSecret": "new-ssh", "sslKeySecret": "new-key", "sshJumpSecret": "new-jump" },
                { "connection": shown[1], "password": null, "sshSecret": null, "sslKeySecret": null } ] }),
        )
        .unwrap();
    let imported = imported.as_array().unwrap();
    assert_eq!(imported.len(), 2);
    let id = imported[0]["id"].as_str().unwrap();
    assert_ne!(
        imported[0]["id"], saved["id"],
        "an import makes new connections"
    );
    assert_eq!(imported[0]["hasPassword"], json!(true));
    assert_eq!(imported[0]["ssh"]["hasSecret"], json!(true));
    assert_eq!(imported[0]["sslFiles"]["hasKeySecret"], json!(true));
    assert_eq!(imported[1]["hasPassword"], json!(false));
    assert_eq!(
        target.secrets.get(id).unwrap().as_deref(),
        Some("new-db-pass")
    );
    assert_eq!(
        target.secrets.get(&format!("{id}:ssh")).unwrap().as_deref(),
        Some("new-ssh")
    );
    assert_eq!(
        target
            .secrets
            .get(&format!("{id}:sslkey"))
            .unwrap()
            .as_deref(),
        Some("new-key")
    );
    assert_eq!(imported[0]["safeMode"], "read-only");
    assert_eq!(imported[0]["ssh"]["jump"]["hasSecret"], json!(true));
    assert_eq!(
        target
            .secrets
            .get(&format!("{id}:sshjump"))
            .unwrap()
            .as_deref(),
        Some("new-jump")
    );

    // Again: the names are taken, so they get numbers; and only the chosen one is imported.
    let again = target
        .call(
            "import_connections",
            json!({ "entries": [{ "connection": shown[1], "password": null, "sshSecret": null, "sslKeySecret": null }] }),
        )
        .unwrap();
    assert_eq!(again[0]["name"], "Plain (2)");
    let listed = target.call("list_connections", json!({})).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 3);

    // Files that aren't what they should be, and choices that make no sense.
    let bad = |content: &str| {
        let f = dir.path().join("bad.json");
        std::fs::write(&f, content).unwrap();
        target
            .call(
                "read_connection_file",
                json!({ "path": f.display().to_string() }),
            )
            .unwrap_err()
    };
    assert!(
        bad("not json")["message"]
            .as_str()
            .unwrap()
            .contains("not a file of AngkorDB")
    );
    assert!(
        bad(r#"{"kind":"other","version":1,"connections":[]}"#)["message"]
            .as_str()
            .unwrap()
            .contains("not a file of AngkorDB")
    );
    assert!(
        bad(r#"{"kind":"angkordb-connections","version":99,"connections":[]}"#)["message"]
            .as_str()
            .unwrap()
            .contains("newer version")
    );
    assert!(
        target
            .call(
                "read_connection_file",
                json!({ "path": "/nonexistent/x.json" })
            )
            .unwrap_err()["message"]
            .as_str()
            .unwrap()
            .contains("There is no file")
    );
    assert_eq!(
        target
            .call("import_connections", json!({ "entries": [] }))
            .unwrap_err()["code"],
        "VALIDATION"
    );
    // What is saved is what was shown, not what the file says by the time of the import.
    let swapped = dir.path().join("swapped.json");
    std::fs::copy(&file, &swapped).unwrap();
    let swapped_path = swapped.display().to_string();
    let shown_before = target
        .call("read_connection_file", json!({ "path": swapped_path }))
        .unwrap();
    std::fs::write(
        &swapped,
        std::fs::read_to_string(&swapped)
            .unwrap()
            .replace("db.example.com", "evil.example.net"),
    )
    .unwrap();
    let kept = target
        .call(
            "import_connections",
            json!({ "entries": [{ "connection": shown_before[0], "password": null, "sshSecret": null, "sslKeySecret": null }] }),
        )
        .unwrap();
    assert_eq!(kept[0]["host"], "db.example.com");
    // A connection with nothing to connect to is refused, by name, and the rest still stands.
    let broken = dir.path().join("broken.json");
    std::fs::write(
        &broken,
        r#"{"kind":"angkordb-connections","version":1,"connections":[
          {"name":"Good","host":"h","port":5432,"user":"u","database":"d","sslMode":"prefer","color":"none","group":null,"safeMode":"off"},
          {"name":"No host","host":"","port":5432,"user":"u","database":"d","sslMode":"prefer","color":"none","group":null,"safeMode":"off"}]}"#,
    )
    .unwrap();
    let shown_broken = target
        .call(
            "read_connection_file",
            json!({ "path": broken.display().to_string() }),
        )
        .unwrap();
    let err = target
        .call(
            "import_connections",
            json!({ "entries": [
                { "connection": shown_broken[0], "password": null, "sshSecret": null, "sslKeySecret": null },
                { "connection": shown_broken[1], "password": null, "sshSecret": null, "sslKeySecret": null }] }),
        )
        .unwrap_err();
    assert!(
        err["message"].as_str().unwrap().contains("\"No host\"")
            && err["message"]
                .as_str()
                .unwrap()
                .contains("Host is required"),
        "{err}"
    );
}

#[test]
fn resolve_ssh_alias_answers_nothing_for_a_blank_or_unknown_name() {
    let ipc = setup();
    assert_eq!(
        ipc.call("resolve_ssh_alias", json!({ "host": "  " }))
            .unwrap(),
        json!(null)
    );
    assert_eq!(
        ipc.call(
            "resolve_ssh_alias",
            json!({ "host": "angkordb-no-such-alias.invalid" })
        )
        .unwrap(),
        json!(null)
    );
}

#[test]
fn the_workspace_and_the_launch_settings_are_kept_and_deleting_a_connection_forgets_them() {
    let ipc = setup();
    let saved = ipc
        .call(
            "save_connection",
            json!({ "config": config("Work", "localhost", 5432),
                    "password": { "kind": "keep" }, "sshSecret": null, "sslKeySecret": null }),
        )
        .unwrap();
    let id = saved["id"].as_str().unwrap();

    // Nothing yet; reopening is on by default.
    assert_eq!(
        ipc.call("load_workspace", json!({ "connectionId": id }))
            .unwrap(),
        json!(null)
    );
    let startup = ipc.call("startup_state", json!({})).unwrap();
    assert_eq!(startup["restoreOnLaunch"], json!(true));
    assert_eq!(startup["lastConnectionId"], json!(null));

    let data =
        r#"{"version":1,"tabs":[{"kind":"query","number":1}],"queries":{"query:1":"select 1"}}"#;
    ipc.call(
        "save_workspace",
        json!({ "connectionId": id, "data": data }),
    )
    .unwrap();
    assert_eq!(
        ipc.call("load_workspace", json!({ "connectionId": id }))
            .unwrap(),
        json!(data)
    );
    ipc.call("set_last_connection", json!({ "connectionId": id }))
        .unwrap();
    ipc.call("set_restore_on_launch", json!({ "restore": false }))
        .unwrap();
    let startup = ipc.call("startup_state", json!({})).unwrap();
    assert_eq!(startup["restoreOnLaunch"], json!(false));
    assert_eq!(startup["lastConnectionId"], json!(id));

    // Bad input is refused, and does not touch what is kept.
    for args in [
        json!({ "connectionId": "../etc", "data": "{}" }),
        json!({ "connectionId": id, "data": "not json" }),
    ] {
        assert_eq!(
            ipc.call("save_workspace", args).unwrap_err()["code"],
            "VALIDATION"
        );
    }
    assert_eq!(
        ipc.call("load_workspace", json!({ "connectionId": id }))
            .unwrap(),
        json!(data)
    );

    ipc.call("delete_connection", json!({ "id": id })).unwrap();
    assert_eq!(
        ipc.call("load_workspace", json!({ "connectionId": id }))
            .unwrap(),
        json!(null)
    );
    assert_eq!(
        ipc.call("startup_state", json!({})).unwrap()["lastConnectionId"],
        json!(null)
    );
    ipc.call("set_last_connection", json!({ "connectionId": null }))
        .unwrap();
}

#[test]
fn the_settings_window_and_confirm_on_quit_commands_work_without_a_window() {
    let ipc = setup();
    // No window hooks in tests: opening the settings window is a no-op, not an error.
    assert_eq!(ipc.call("open_settings", json!({})).unwrap(), json!(null));
    let state = ipc._app.state::<AppState>();
    assert!(!state.confirm_quit());
    assert_eq!(
        ipc.call("set_confirm_on_quit", json!({ "confirm": true }))
            .unwrap(),
        json!(null)
    );
    assert!(state.confirm_quit());
    ipc.call("set_confirm_on_quit", json!({ "confirm": false }))
        .unwrap();
    assert!(!state.confirm_quit());
}
