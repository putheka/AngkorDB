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
    let failing = json!({ "updates": [{
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
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, Ordering};

    let ipc = setup();
    let state = ipc._app.state::<AppState>();

    // Without hooks (as in tests) the commands still work and the count is kept.
    assert_eq!(state.unsaved_changes(), 0);
    ipc.call("set_unsaved_changes", json!({ "count": 3 }))
        .unwrap();
    assert_eq!(state.unsaved_changes(), 3);
    ipc.call("quit_app", json!({})).unwrap();

    // With hooks: the edited dot follows "is there anything unsaved", quitting calls the hook.
    let dots = Arc::new(Mutex::new(Vec::new()));
    let quits = Arc::new(AtomicU32::new(0));
    state.set_window_hooks(WindowHooks {
        set_edited: {
            let dots = dots.clone();
            Box::new(move |edited| dots.lock().unwrap().push(edited))
        },
        quit: {
            let quits = quits.clone();
            Box::new(move || {
                quits.fetch_add(1, Ordering::SeqCst);
            })
        },
    });
    for count in [1, 4, 0] {
        ipc.call("set_unsaved_changes", json!({ "count": count }))
            .unwrap();
    }
    assert_eq!(*dots.lock().unwrap(), [true, true, false]);
    assert_eq!(state.unsaved_changes(), 0);

    assert_eq!(quits.load(Ordering::SeqCst), 0);
    ipc.call("quit_app", json!({})).unwrap();
    assert_eq!(quits.load(Ordering::SeqCst), 1);
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
