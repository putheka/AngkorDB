//! Sessions, errors, cancel and read-only mode against the dev database (see `common`).

mod common;

use std::time::Duration;

use angkordb_lib::db::session::{Session, test_connection};
use angkordb_lib::error::AppError;
use angkordb_lib::models::connection::SafeMode;
use common::{DEV_PASSWORD, dev_config, open_or_skip};
use serde_json::Value;

fn to_json(err: &AppError) -> Value {
    serde_json::to_value(err).expect("AppError serializes")
}

#[tokio::test]
async fn connects_and_selects_one() {
    let Some(session) = open_or_skip().await else {
        return;
    };

    let client = session.meta().await.unwrap();
    let row = client
        .query_one("SELECT 1::int4 AS one", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, i32>("one"), 1);

    let app: String = client
        .query_one("SELECT current_setting('application_name')", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(app, "AngkorDB");
}

#[tokio::test]
async fn unique_violation_has_sqlstate_and_detail() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    let err: AppError = client
        .execute("INSERT INTO public.short_codes (code) VALUES ('KH')", &[])
        .await
        .unwrap_err()
        .into();

    let json = to_json(&err);
    assert_eq!(json["code"], "POSTGRES");
    assert_eq!(json["pgCode"], "23505");
    assert!(
        json["message"]
            .as_str()
            .unwrap()
            .starts_with("duplicate key value")
    );
    assert_eq!(json["detail"], "Key (code)=(KH) already exists.");
}

#[tokio::test]
async fn unknown_function_has_hint() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    let err: AppError = client
        .simple_query("SELECT public.order_total('not-a-number'::text)")
        .await
        .unwrap_err()
        .into();

    let json = to_json(&err);
    assert_eq!(json["pgCode"], "42883");
    assert!(
        json["hint"]
            .as_str()
            .is_some_and(|h| h.contains("explicit type casts")),
        "missing hint: {json}"
    );
}

#[tokio::test]
async fn syntax_error_has_position() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    let err: AppError = client
        .simple_query("SELECT 1;\nSELEC 2")
        .await
        .unwrap_err()
        .into();

    let json = to_json(&err);
    assert_eq!(json["pgCode"], "42601");
    assert_eq!(json["position"], 11, "points at `SELEC`: {json}");
}

#[tokio::test]
async fn tab_client_keeps_session_state_between_runs() {
    let Some(session) = open_or_skip().await else {
        return;
    };

    session
        .tab_client("tab-1")
        .await
        .unwrap()
        .batch_execute("SET application_name = 'angkordb-tab-test'")
        .await
        .unwrap();

    // Same tab again → same connection → setting is still there.
    let value: String = session
        .tab_client("tab-1")
        .await
        .unwrap()
        .query_one("SHOW application_name", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(value, "angkordb-tab-test");

    // Another tab gets its own connection with default settings.
    let other: String = session
        .tab_client("tab-2")
        .await
        .unwrap()
        .query_one("SHOW application_name", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(other, "AngkorDB");

    session.close().await;
}

#[tokio::test]
async fn cancel_stops_a_running_query() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.tab_client("slow").await.unwrap();

    let running = tokio::spawn(async move { client.simple_query("SELECT pg_sleep(30)").await });

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(session.cancel_tab("slow").await.unwrap());

    let result = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("query was not cancelled within 5 s")
        .unwrap();
    let err: AppError = result.unwrap_err().into();
    assert_eq!(err.pg_code(), Some("57014"), "query_canceled");

    // The tab connection is still usable after a cancel.
    let ok = session
        .tab_client("slow")
        .await
        .unwrap()
        .simple_query("SELECT 1")
        .await;
    assert!(ok.is_ok());
}

#[tokio::test]
async fn wrong_password_is_reported() {
    // Only meaningful when the DB is up.
    if open_or_skip().await.is_none() {
        return;
    }

    let err = match Session::open(dev_config(), Some("wrong-password")).await {
        Ok(_) => panic!("opened a session with a wrong password"),
        Err(e) => e,
    };
    assert_eq!(err.pg_code(), Some("28P01"), "invalid_password: {err:?}");
    assert!(!err.is_connection_error());
}

#[tokio::test]
async fn unreachable_server_is_a_connection_error() {
    let mut config = dev_config();
    config.port = 1; // nothing listens here

    let err = match Session::open(config, Some(DEV_PASSWORD)).await {
        Ok(_) => panic!("connected to port 1"),
        Err(e) => e,
    };
    assert!(err.is_connection_error(), "{err:?}");
    let json = to_json(&err);
    assert_eq!(json["code"], "CONNECTION");
    assert!(
        json["message"].as_str().unwrap().contains("refused"),
        "message should include the cause: {json}"
    );
}

#[tokio::test]
async fn session_reports_the_server_version() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let info = session.info();
    assert!(
        info.server_version
            .starts_with(|c: char| c.is_ascii_digit()),
        "server_version: {}",
        info.server_version
    );
}

#[tokio::test]
async fn test_connection_succeeds_and_reports_version_and_latency() {
    if open_or_skip().await.is_none() {
        return;
    }
    let info = test_connection(&dev_config(), Some(DEV_PASSWORD))
        .await
        .unwrap();
    assert!(
        info.server_version.starts_with("16"),
        "{}",
        info.server_version
    );
    assert!(info.latency_ms < 5_000);
}

#[tokio::test]
async fn test_connection_reports_a_wrong_password() {
    if open_or_skip().await.is_none() {
        return;
    }
    let err = test_connection(&dev_config(), Some("nope"))
        .await
        .unwrap_err();
    assert_eq!(err.pg_code(), Some("28P01"), "{err:?}");
    assert!(!err.is_connection_error());
}

#[tokio::test]
async fn test_connection_reports_an_unreachable_server() {
    let mut config = dev_config();
    config.port = 1;
    let err = test_connection(&config, Some(DEV_PASSWORD))
        .await
        .unwrap_err();
    assert!(err.is_connection_error(), "{err:?}");
}

#[tokio::test]
async fn test_connection_gives_up_on_a_server_that_never_answers() {
    // A listener that accepts connections but never speaks: the driver's connect timeout
    // does not cover this, our overall timeout must.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });

    let mut config = dev_config();
    config.host = "127.0.0.1".into();
    config.port = port;

    let started = std::time::Instant::now();
    let err = test_connection(&config, Some(DEV_PASSWORD))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "TIMEOUT", "{err:?}");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn read_only_mode_blocks_writes_on_the_server() {
    if open_or_skip().await.is_none() {
        return;
    }
    let mut config = dev_config();
    config.safe_mode = SafeMode::ReadOnly;
    let session = Session::open(config, Some(DEV_PASSWORD)).await.unwrap();

    let write = "INSERT INTO public.short_codes (code, label) VALUES ('ZZ', 'blocked')";

    // Pooled connection...
    let err: AppError = session
        .meta()
        .await
        .unwrap()
        .execute(write, &[])
        .await
        .unwrap_err()
        .into();
    assert_eq!(
        err.pg_code(),
        Some("25006"),
        "read_only_sql_transaction: {err:?}"
    );

    // ...and a query tab's own connection.
    let err: AppError = session
        .tab_client("t")
        .await
        .unwrap()
        .simple_query(write)
        .await
        .unwrap_err()
        .into();
    assert_eq!(err.pg_code(), Some("25006"), "{err:?}");

    // Reads still work.
    let rows = session
        .meta()
        .await
        .unwrap()
        .query("SELECT code FROM public.short_codes", &[])
        .await
        .unwrap();
    assert!(!rows.is_empty());
}

#[tokio::test]
async fn writes_work_when_safe_mode_is_off() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();
    // Rolled back: the seed data stays untouched.
    client
        .batch_execute("BEGIN; CREATE TEMP TABLE t (x int); INSERT INTO t VALUES (1); ROLLBACK;")
        .await
        .unwrap();
}
