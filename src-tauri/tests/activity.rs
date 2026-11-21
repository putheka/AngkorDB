//! The process list for real: find a `pg_sleep` from another connection and stop it, see who
//! blocks whom (see `common`).

mod common;

use std::sync::Arc;
use std::time::Duration;

use angkordb_lib::db::activity::{list, signal};
use angkordb_lib::error::AppError;
use angkordb_lib::models::activity::{Backend, Signal};
use common::open_or_skip;
use tokio_postgres::Client;

async fn pid_of(client: &Client) -> u32 {
    let pid: i32 = client
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .unwrap()
        .get(0);
    u32::try_from(pid).unwrap()
}

/// Ask until `found` is satisfied (the other connection needs a moment to get there).
async fn wait_for(admin: &Client, what: &str, found: impl Fn(&[Backend]) -> bool) -> Vec<Backend> {
    for _ in 0..100 {
        let backends = list(admin).await.unwrap();
        if found(&backends) {
            return backends;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never saw: {what}");
}

fn code(error: &tokio_postgres::Error) -> Option<String> {
    error.code().map(|c| c.code().to_owned())
}

#[tokio::test]
async fn a_sleeping_query_is_found_cancelled_and_the_connection_survives() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let admin = dev.meta().await.unwrap();
    let sleeper: Arc<Client> = dev.tab_client("sleeper").await.unwrap();
    let pid = pid_of(&sleeper).await;

    let running = Arc::clone(&sleeper);
    let task = tokio::spawn(async move { running.simple_query("SELECT pg_sleep(60)").await });

    let backends = wait_for(&admin, "the sleeper is active", |b| {
        b.iter()
            .any(|x| x.pid == pid && x.state.as_deref() == Some("active"))
    })
    .await;
    let me = backends.iter().find(|b| b.pid == pid).unwrap();
    assert!(me.query.contains("pg_sleep(60)"));
    assert_eq!(me.application, "AngkorDB");
    assert!(!me.is_self);
    assert!(me.blocked_by.is_empty());
    assert!(me.state_secs.unwrap() >= 0.0);
    assert_eq!(backends.iter().filter(|b| b.is_self).count(), 1);

    assert!(signal(&admin, pid, Signal::Cancel).await.unwrap());
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(code(&error).as_deref(), Some("57014"), "{error}");
    // Only the query was stopped: the connection is still there.
    sleeper.simple_query("SELECT 1").await.unwrap();
    dev.close_tab("sleeper").await;
}

#[tokio::test]
async fn terminating_closes_the_connection_and_a_second_try_finds_nobody() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let admin = dev.meta().await.unwrap();
    let victim: Arc<Client> = dev.tab_client("victim").await.unwrap();
    let pid = pid_of(&victim).await;

    let running = Arc::clone(&victim);
    let task = tokio::spawn(async move { running.simple_query("SELECT pg_sleep(60)").await });
    wait_for(&admin, "the victim is active", |b| {
        b.iter()
            .any(|x| x.pid == pid && x.state.as_deref() == Some("active"))
    })
    .await;

    assert!(signal(&admin, pid, Signal::Terminate).await.unwrap());
    let error = task.await.unwrap().unwrap_err();
    assert!(
        matches!(code(&error).as_deref(), Some("57P01") | None),
        "{error}"
    );
    wait_for(&admin, "the victim is gone", |b| {
        b.iter().all(|x| x.pid != pid)
    })
    .await;
    assert!(!signal(&admin, pid, Signal::Terminate).await.unwrap());
    dev.close_tab("victim").await;
}

#[tokio::test]
async fn who_blocks_whom_and_on_what() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let admin = dev.meta().await.unwrap();
    let table = format!("angkordb_lock_{}", std::process::id());
    admin
        .batch_execute(&format!(
            "DROP TABLE IF EXISTS {table}; CREATE TABLE {table} (id int)"
        ))
        .await
        .unwrap();

    let holder: Arc<Client> = dev.tab_client("holder").await.unwrap();
    let waiter: Arc<Client> = dev.tab_client("waiter").await.unwrap();
    let (holder_pid, waiter_pid) = (pid_of(&holder).await, pid_of(&waiter).await);
    holder
        .batch_execute(&format!(
            "BEGIN; LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE"
        ))
        .await
        .unwrap();
    let blocked = Arc::clone(&waiter);
    let blocked_sql = format!("SELECT count(*) FROM {table}");
    let task = tokio::spawn(async move { blocked.simple_query(&blocked_sql).await });

    let backends = wait_for(&admin, "the waiter is blocked", |b| {
        b.iter()
            .any(|x| x.pid == waiter_pid && !x.blocked_by.is_empty())
    })
    .await;
    let blocked = backends.iter().find(|b| b.pid == waiter_pid).unwrap();
    assert_eq!(blocked.blocked_by, vec![holder_pid]);
    let wait = blocked.lock_wait.as_deref().unwrap();
    assert!(
        wait.contains("AccessShareLock") && wait.contains(&table),
        "{wait}"
    );
    assert_eq!(blocked.wait_event_type.as_deref(), Some("Lock"));

    let holder_row = backends.iter().find(|b| b.pid == holder_pid).unwrap();
    assert_eq!(holder_row.state.as_deref(), Some("idle in transaction"));
    assert!(holder_row.transaction_secs.is_some());
    assert!(holder_row.blocked_by.is_empty());

    // Ending the holder lets the waiter through.
    assert!(signal(&admin, holder_pid, Signal::Terminate).await.unwrap());
    task.await.unwrap().unwrap();

    admin
        .batch_execute(&format!("DROP TABLE {table}"))
        .await
        .unwrap();
    dev.close_tab("waiter").await;
}

#[tokio::test]
async fn the_connection_the_list_is_read_with_is_refused() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let admin = dev.meta().await.unwrap();
    let own = pid_of(&admin).await;
    let error = signal(&admin, own, Signal::Terminate).await.unwrap_err();
    assert!(matches!(error, AppError::Validation(_)), "{error:?}");
    // Still alive.
    admin.simple_query("SELECT 1").await.unwrap();
}
