//! Running scripts on a query tab's own connection, against the dev database (see `common`).

mod common;

use std::time::{Duration, Instant};

use angkordb_lib::db::query::{MAX_ROWS, run_script};
use angkordb_lib::db::session::Session;
use angkordb_lib::models::connection::SafeMode;
use angkordb_lib::models::query::{QueryRun, StatementOutcome};
use common::{DEV_PASSWORD, dev_config, open_or_skip};

type Cells = Vec<Vec<Option<String>>>;

async fn run(session: &Session, tab: &str, sql: &str) -> QueryRun {
    run_script(session, tab, sql)
        .await
        .unwrap_or_else(|e| panic!("run {sql:?}: {e:?}"))
}

fn cell(text: &str) -> Option<String> {
    Some(text.to_owned())
}

/// The rows of statement `index`, which must have returned rows.
fn rows_of(run: &QueryRun, index: usize) -> &Cells {
    match &run.statements[index].outcome {
        StatementOutcome::Rows { rows, .. } => rows,
        other => panic!("statement {index} did not return rows: {other:?}"),
    }
}

/// `(command, affected)` of statement `index`, which must be a command.
fn command_of(run: &QueryRun, index: usize) -> (&str, u32) {
    match &run.statements[index].outcome {
        StatementOutcome::Command { command, affected } => (command.as_str(), *affected),
        other => panic!("statement {index} was not a command: {other:?}"),
    }
}

#[tokio::test]
async fn a_select_returns_typed_columns_and_text_cells() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = run(
        &session,
        "t",
        "SELECT 1::int4 AS n, 'x'::text AS t, true AS yes, false AS no, NULL::text AS nothing,
                1.50::numeric(5,2) AS price, '{\"a\": 1}'::jsonb AS doc",
    )
    .await;

    assert_eq!(result.statements.len(), 1);
    let StatementOutcome::Rows {
        columns,
        rows,
        truncated,
    } = &result.statements[0].outcome
    else {
        panic!("{:?}", result.statements[0].outcome);
    };
    let oids: Vec<u32> = columns.iter().map(|c| c.type_oid).collect();
    assert_eq!(oids, [23, 25, 16, 16, 25, 1700, 3802]);
    assert_eq!(columns[0].name, "n");
    assert_eq!(columns[0].type_name, "int4");
    assert!(!truncated);
    assert_eq!(
        rows,
        &vec![vec![
            cell("1"),
            cell("x"),
            cell("true"), // the simple protocol says `t`; the UI is told `true`
            cell("false"),
            None,
            cell("1.50"),
            cell("{\"a\": 1}"),
        ]]
    );
}

#[tokio::test]
async fn a_script_runs_every_statement_and_reports_each() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = run(
        &session,
        "script",
        "CREATE TEMP TABLE items (x int);
         INSERT INTO items VALUES (1), (2), (3);
         UPDATE items SET x = x + 1 WHERE x > 1;
         SELECT x FROM items ORDER BY x;
         DELETE FROM items WHERE x = 1",
    )
    .await;

    assert_eq!(result.statements.len(), 5);
    assert_eq!(command_of(&result, 0), ("CREATE", 0));
    assert_eq!(command_of(&result, 1), ("INSERT", 3));
    assert_eq!(command_of(&result, 2), ("UPDATE", 2));
    assert_eq!(
        rows_of(&result, 3),
        &vec![vec![cell("1")], vec![cell("3")], vec![cell("4")]]
    );
    assert_eq!(command_of(&result, 4), ("DELETE", 1));

    // Each statement knows where it sits in the text.
    let r = result.statements[1].range;
    let text = "CREATE TEMP TABLE items (x int);\n         INSERT INTO items VALUES (1), (2), (3);";
    assert!(
        text.encode_utf16()
            .skip(r.start as usize)
            .take((r.end - r.start) as usize)
            .eq("INSERT INTO items VALUES (1), (2), (3)".encode_utf16())
    );
}

#[tokio::test]
async fn the_tab_keeps_its_session_between_runs() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    run(
        &session,
        "keeper",
        "CREATE TEMP TABLE kept (x int); SET application_name = 'sql-tab'",
    )
    .await;
    run(&session, "keeper", "BEGIN; INSERT INTO kept VALUES (7)").await;

    // Same tab: the temp table, the setting and the open transaction are all still there.
    let same = run(
        &session,
        "keeper",
        "SELECT x FROM kept; SHOW application_name",
    )
    .await;
    assert_eq!(rows_of(&same, 0), &vec![vec![cell("7")]]);
    assert_eq!(rows_of(&same, 1), &vec![vec![cell("sql-tab")]]);
    run(&session, "keeper", "ROLLBACK").await;
    let after = run(&session, "keeper", "SELECT count(*) FROM kept").await;
    assert_eq!(rows_of(&after, 0), &vec![vec![cell("0")]]);

    // Another tab has its own connection and sees none of it.
    let other = run(&session, "someone-else", "SELECT x FROM kept").await;
    let StatementOutcome::Error { error, .. } = &other.statements[0].outcome else {
        panic!("{:?}", other.statements[0].outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("42P01"));
}

#[tokio::test]
async fn the_first_error_stops_the_script_and_points_into_the_text() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let sql = "SELECT 1; SELEC 2; SELECT 3";
    let result = run(&session, "errors", sql).await;
    assert_eq!(
        result.statements.len(),
        2,
        "the statement after the error is not run"
    );
    assert_eq!(rows_of(&result, 0), &vec![vec![cell("1")]]);
    let StatementOutcome::Error { error, offset } = &result.statements[1].outcome else {
        panic!("{:?}", result.statements[1].outcome);
    };
    assert_eq!(error.code, "POSTGRES");
    assert_eq!(error.pg_code.as_deref(), Some("42601"));
    assert!(error.message.contains("syntax error"), "{}", error.message);
    // `SELEC` starts at offset 10 of the text.
    assert_eq!(*offset, Some(10));
}

#[tokio::test]
async fn error_offsets_count_utf16_units_even_after_emoji_and_khmer() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    // The unknown column comes after characters that take 1 to 2 UTF-16 units and 1 to 4 bytes.
    let sql = "SELECT 1; SELECT 'ក😀', no_such_column FROM generate_series(1, 2)";
    let result = run(&session, "utf", sql).await;
    let StatementOutcome::Error { error, offset } = &result.statements[1].outcome else {
        panic!("{:?}", result.statements[1].outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("42703"), "undefined_column");
    let offset = offset.expect("the server names the column's position") as usize;
    let units: Vec<u16> = sql.encode_utf16().collect();
    let found = String::from_utf16(&units[offset..offset + "no_such_column".len()]).unwrap();
    assert_eq!(found, "no_such_column");
}

#[tokio::test]
async fn statements_that_return_rows_without_selecting_work() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = run(
        &session,
        "returning",
        "CREATE TEMP TABLE r (id serial, name text);
         INSERT INTO r (name) VALUES ('a'), ('b') RETURNING id, name;
         SELECT * FROM r WHERE false;
         SHOW application_name",
    )
    .await;
    assert_eq!(
        rows_of(&result, 1),
        &vec![vec![cell("1"), cell("a")], vec![cell("2"), cell("b")]]
    );
    // No rows still means "a result set": the columns are known.
    let StatementOutcome::Rows { columns, rows, .. } = &result.statements[2].outcome else {
        panic!("{:?}", result.statements[2].outcome);
    };
    assert!(rows.is_empty());
    assert_eq!(
        columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "name"]
    );
    assert_eq!(rows_of(&result, 3), &vec![vec![cell("AngkorDB")]]);
}

#[tokio::test]
async fn text_with_only_comments_runs_nothing() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    for sql in ["", "   ", "-- nothing here", "/* or here */;;"] {
        assert!(
            run(&session, "empty", sql).await.statements.is_empty(),
            "{sql:?}"
        );
    }
}

#[tokio::test]
async fn a_huge_result_is_cut_at_the_cap_and_the_tab_stays_usable() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    for round in 0..3 {
        let started = Instant::now();
        let result = run(
            &session,
            "big",
            "SELECT g, repeat('x', 100) FROM generate_series(1, 5000000) g; SELECT 'after'",
        )
        .await;
        let StatementOutcome::Rows {
            rows, truncated, ..
        } = &result.statements[0].outcome
        else {
            panic!("{:?}", result.statements[0].outcome);
        };
        assert!(*truncated, "round {round}");
        assert_eq!(rows.len(), MAX_ROWS);
        assert_eq!(rows[0][0], cell("1"));
        assert_eq!(rows[MAX_ROWS - 1][0], cell(&MAX_ROWS.to_string()));
        // The cancelled query didn't leave the connection busy or poisoned.
        assert_eq!(
            rows_of(&result, 1),
            &vec![vec![cell("after")]],
            "round {round}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "round {round} took {:?}",
            started.elapsed()
        );
    }

    // Exactly at the cap is not truncated.
    let exact = run(
        &session,
        "big",
        &format!("SELECT g FROM generate_series(1, {MAX_ROWS}) g"),
    )
    .await;
    let StatementOutcome::Rows {
        rows, truncated, ..
    } = &exact.statements[0].outcome
    else {
        panic!("{:?}", exact.statements[0].outcome);
    };
    assert_eq!(rows.len(), MAX_ROWS);
    assert!(!truncated);
}

#[tokio::test]
async fn cancelling_a_minute_long_query_takes_under_a_second_and_the_tab_is_reusable() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let session = std::sync::Arc::new(session);
    let runner = {
        let session = std::sync::Arc::clone(&session);
        tokio::spawn(async move {
            run_script(&session, "slow", "SELECT 1; SELECT pg_sleep(60); SELECT 3").await
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;

    let asked = std::time::Instant::now();
    assert!(session.cancel_tab("slow").await.unwrap());
    let result = tokio::time::timeout(Duration::from_secs(5), runner)
        .await
        .expect("script did not stop within 5 s")
        .unwrap()
        .unwrap();
    let took = asked.elapsed();
    assert!(
        took < Duration::from_secs(1),
        "cancelling pg_sleep(60) took {took:?}"
    );

    assert_eq!(
        result.statements.len(),
        2,
        "stops at the cancelled statement"
    );
    let StatementOutcome::Error { error, .. } = &result.statements[1].outcome else {
        panic!("{:?}", result.statements[1].outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("57014"));

    // The tab still works.
    assert_eq!(
        rows_of(&run(&session, "slow", "SELECT 'ok'").await, 0),
        &vec![vec![cell("ok")]]
    );
}

#[tokio::test]
async fn notices_and_warnings_come_back_with_the_statement_that_raised_them() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = run(
        &session,
        "notices",
        "SELECT 1;
         DO $$ BEGIN
           RAISE NOTICE 'hello %', 42;
           RAISE WARNING 'careful' USING HINT = 'look again', DETAIL = 'because';
         END $$;
         DROP TABLE IF EXISTS public.ang32_no_such_table;
         SELECT 2",
    )
    .await;
    assert_eq!(result.statements.len(), 4);
    let heard = |i: usize| {
        result.statements[i]
            .notices
            .iter()
            .map(|n| (n.severity.as_str(), n.message.as_str()))
            .collect::<Vec<_>>()
    };

    assert!(heard(0).is_empty());
    assert_eq!(heard(1), [("NOTICE", "hello 42"), ("WARNING", "careful")]);
    let warning = &result.statements[1].notices[1];
    assert_eq!(warning.hint.as_deref(), Some("look again"));
    assert_eq!(warning.detail.as_deref(), Some("because"));
    assert_eq!(warning.code, "01000");
    // The server's own notice for a statement that did nothing.
    assert_eq!(heard(2).len(), 1);
    assert!(
        heard(2)[0].1.contains("does not exist, skipping"),
        "{:?}",
        heard(2)
    );
    assert!(
        heard(3).is_empty(),
        "notices are not carried over to the next statement"
    );
}

#[tokio::test]
async fn a_long_query_in_one_tab_does_not_block_the_others() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let session = std::sync::Arc::new(session);
    let slow = {
        let session = std::sync::Arc::clone(&session);
        tokio::spawn(async move { run_script(&session, "busy", "SELECT pg_sleep(30)").await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Another tab, and the shared pool the grid uses, answer at once while "busy" is sleeping.
    let started = std::time::Instant::now();
    assert_eq!(
        rows_of(&run(&session, "other", "SELECT 'quick'").await, 0),
        &vec![vec![cell("quick")]]
    );
    let client = session.meta().await.unwrap();
    client.simple_query("SELECT 1").await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );

    session.cancel_tab("busy").await.unwrap();
    slow.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_statement_timeout_on_the_connection_stops_slow_statements_everywhere() {
    if open_or_skip().await.is_none() {
        return;
    }
    let mut config = dev_config();
    config.statement_timeout_ms = Some(400);
    let session = Session::open(config, Some(DEV_PASSWORD)).await.unwrap();

    // The SQL tab: the slow statement ends with "statement timeout" and the script stops there.
    let started = std::time::Instant::now();
    let result = run(
        &session,
        "limited",
        "SELECT 1; SELECT pg_sleep(30); SELECT 3",
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(result.statements.len(), 2);
    let StatementOutcome::Error { error, .. } = &result.statements[1].outcome else {
        panic!("{:?}", result.statements[1].outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("57014"));
    assert!(
        error.message.contains("statement timeout"),
        "{}",
        error.message
    );
    // Fast statements are not affected, and the tab is still usable.
    assert_eq!(
        rows_of(&run(&session, "limited", "SELECT 'fine'").await, 0),
        &vec![vec![cell("fine")]]
    );

    // The pool (grid, introspection) has the same limit.
    let client = session.meta().await.unwrap();
    let setting: String = client
        .query_one("SELECT current_setting('statement_timeout')", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(setting, "400ms");

    // Without a timeout (or 0) nothing is set.
    let plain = Session::open(dev_config(), Some(DEV_PASSWORD))
        .await
        .unwrap();
    let client = plain.meta().await.unwrap();
    let setting: String = client
        .query_one("SELECT current_setting('statement_timeout')", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(setting, "0");
}

#[tokio::test]
async fn read_only_connections_refuse_writes_in_the_sql_tab() {
    if open_or_skip().await.is_none() {
        return;
    }
    let mut config = dev_config();
    config.safe_mode = SafeMode::ReadOnly;
    let session = Session::open(config, Some(DEV_PASSWORD)).await.unwrap();

    let result = run(
        &session,
        "ro",
        "SELECT 1; INSERT INTO public.short_codes (code, label) VALUES ('ZZ', 'x'); SELECT 3",
    )
    .await;
    assert_eq!(result.statements.len(), 2);
    let StatementOutcome::Error { error, .. } = &result.statements[1].outcome else {
        panic!("{:?}", result.statements[1].outcome);
    };
    assert_eq!(
        error.pg_code.as_deref(),
        Some("25006"),
        "read_only_sql_transaction"
    );
}

#[tokio::test]
async fn a_read_only_connection_cannot_be_unlocked_from_the_sql_tab() {
    if open_or_skip().await.is_none() {
        return;
    }
    let mut config = dev_config();
    config.safe_mode = SafeMode::ReadOnly;
    let session = Session::open(config, Some(DEV_PASSWORD)).await.unwrap();

    // Each way of switching the setting off is refused before it is sent, and ends the script.
    for unlock in [
        "SET default_transaction_read_only = off",
        "BEGIN READ WRITE",
        "RESET ALL",
        "SELECT set_config('default_transaction_read_only', 'off', false)",
        "DO $$ BEGIN PERFORM 1; END $$",
    ] {
        let result = run(
            &session,
            "ro-unlock",
            &format!("SELECT 1; {unlock}; SELECT 3"),
        )
        .await;
        assert_eq!(result.statements.len(), 2, "{unlock}");
        let StatementOutcome::Error { error, .. } = &result.statements[1].outcome else {
            panic!("{unlock}: {:?}", result.statements[1].outcome);
        };
        assert_eq!(error.code, "VALIDATION", "{unlock}");
        assert!(error.message.contains("read-only"), "{}", error.message);
    }

    // The session was never unlocked: a write is still refused by the server.
    let result = run(
        &session,
        "ro-unlock",
        "INSERT INTO public.short_codes (code, label) VALUES ('ZZ', 'x')",
    )
    .await;
    let StatementOutcome::Error { error, .. } = &result.statements[0].outcome else {
        panic!("{:?}", result.statements[0].outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("25006"));

    // Reading the setting is fine, and an ordinary connection may change it.
    let shown = run(&session, "ro-unlock", "SHOW default_transaction_read_only").await;
    assert_eq!(rows_of(&shown, 0)[0][0].as_deref(), Some("on"));
    let open = Session::open(dev_config(), Some(DEV_PASSWORD))
        .await
        .unwrap();
    let result = run(&open, "rw", "SET default_transaction_read_only = off").await;
    assert!(
        matches!(
            result.statements[0].outcome,
            StatementOutcome::Command { .. }
        ),
        "{:?}",
        result.statements[0].outcome
    );
}

#[tokio::test]
async fn a_dead_tab_connection_is_replaced_on_the_next_run() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    run(&session, "dies", "SELECT 1").await;
    // Kill the tab's backend from another connection, as a server restart or timeout would.
    let pid = rows_of(&run(&session, "dies", "SELECT pg_backend_pid()").await, 0)[0][0]
        .clone()
        .unwrap();
    let killer = session.meta().await.unwrap();
    killer
        .execute(&format!("SELECT pg_terminate_backend({pid})"), &[])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let again = run(&session, "dies", "SELECT 'back'").await;
    assert_eq!(rows_of(&again, 0), &vec![vec![cell("back")]]);
}
