//! A connection that looks open and is dead (the laptop slept, the Wi-Fi changed) is found and
//! replaced before it is used. The test puts a TCP proxy between the app and the database and
//! freezes it: connections made before stay open and say nothing, as after a sleep; connections
//! made after work.

mod common;

use std::time::{Duration, Instant};

use angkordb_lib::db::config::pg_config;
use angkordb_lib::db::session::Session;
use common::{DEV_PASSWORD, dev_config, open_or_skip};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

struct Proxy {
    port: u16,
    freeze: watch::Sender<u64>,
}

impl Proxy {
    /// Forward to the dev database.
    async fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (freeze, watching) = watch::channel(0u64);
        let target = dev_config().port;
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let epoch = *watching.borrow();
                let mut frozen = watching.clone();
                tokio::spawn(async move {
                    let Ok(mut server) = TcpStream::connect(("127.0.0.1", target)).await else {
                        return;
                    };
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
                        () = async {
                            while frozen.changed().await.is_ok() {
                                if *frozen.borrow() > epoch {
                                    return;
                                }
                            }
                            std::future::pending::<()>().await;
                        } => {
                            // Frozen: nothing more is passed on, and the sockets stay open.
                            std::future::pending::<()>().await;
                        }
                    }
                });
            }
        });
        Self { port, freeze }
    }

    /// The connections made so far stop answering; new ones work.
    fn freeze(&self) {
        self.freeze.send_modify(|epoch| *epoch += 1);
    }
}

async fn through(proxy: &Proxy) -> Option<Session> {
    open_or_skip().await?;
    let mut config = dev_config();
    config.host = "127.0.0.1".into();
    config.port = proxy.port;
    Some(Session::open(config, Some(DEV_PASSWORD)).await.unwrap())
}

#[tokio::test]
async fn a_dead_pooled_connection_is_replaced_before_it_is_used() {
    let proxy = Proxy::start().await;
    let Some(session) = through(&proxy).await else {
        return;
    };
    session.set_idle_check(Duration::ZERO);
    let one: i32 = session
        .meta()
        .await
        .unwrap()
        .query_one("SELECT 1", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(one, 1);
    assert_eq!(session.health().reconnects, 0);

    proxy.freeze();
    let started = Instant::now();
    let client = session.meta().await.unwrap();
    let took = started.elapsed();
    let answer: i32 = client.query_one("SELECT 2", &[]).await.unwrap().get(0);
    assert_eq!(answer, 2, "the connection handed out is a working one");
    // It waited for the check to give up (2 s), not for a TCP timeout.
    assert!(
        took >= Duration::from_millis(1500) && took < Duration::from_secs(6),
        "{took:?}"
    );
    let health = session.health();
    assert_eq!((health.reconnecting, health.reconnects), (false, 1));
    drop(client);

    // The new connection is a good one and needs no more waiting.
    let started = Instant::now();
    let again: i32 = session
        .meta()
        .await
        .unwrap()
        .query_one("SELECT 3", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(again, 3);
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert_eq!(session.health().reconnects, 1);
    session.close().await;
}

#[tokio::test]
async fn a_query_tab_gets_a_new_connection_too() {
    let proxy = Proxy::start().await;
    let Some(session) = through(&proxy).await else {
        return;
    };
    session.set_idle_check(Duration::ZERO);
    let first = session.tab_client("tab").await.unwrap();
    first.batch_execute("SELECT 1").await.unwrap();

    proxy.freeze();
    let started = Instant::now();
    let second = session.tab_client("tab").await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(
        !std::sync::Arc::ptr_eq(&first, &second),
        "the dead connection was kept"
    );
    let answer: i32 = second.query_one("SELECT 5", &[]).await.unwrap().get(0);
    assert_eq!(answer, 5);
    assert_eq!(session.health().reconnects, 1);
    // A tab that is fine keeps its connection.
    let third = session.tab_client("tab").await.unwrap();
    assert!(std::sync::Arc::ptr_eq(&second, &third));
    session.close().await;
}

#[tokio::test]
async fn a_connection_used_a_moment_ago_is_not_checked() {
    let proxy = Proxy::start().await;
    let Some(session) = through(&proxy).await else {
        return;
    };
    session.set_idle_check(Duration::from_secs(3600));
    let _ = session.meta().await.unwrap();
    proxy.freeze();
    // No check, so no wait, and no pretending it is fine: the dead one is simply handed out
    // (what the idle limit is for: a connection used just now is not asked again).
    let started = Instant::now();
    let _client = session.meta().await.unwrap();
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(session.health().reconnects, 0);
    session.close().await;
}

#[test]
fn the_connection_asks_the_network_often_enough_to_notice_it_is_gone() {
    let config = pg_config(&dev_config(), Some("x"));
    assert!(config.get_keepalives());
    assert_eq!(config.get_keepalives_idle(), Duration::from_secs(60));
    assert_eq!(
        config.get_keepalives_interval(),
        Some(Duration::from_secs(10))
    );
    assert_eq!(config.get_keepalives_retries(), Some(3));
    assert_eq!(
        config.get_tcp_user_timeout().copied(),
        Some(Duration::from_secs(30))
    );
}
