use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use deadpool_postgres::{
    Hook, HookError, Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime,
};
use tokio::sync::Mutex;
use tokio_postgres::{AsyncMessage, Client, Config};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::db::ssh::{SshSetup, SshTunnel};
use crate::db::tls::TlsOptions;
use crate::db::{config, tls};
use crate::error::{AppError, AppResult};
use crate::models::connection::{ConnectionConfig, ConnectionInfo};
use crate::models::query::{MAX_NOTICES, Notice};

/// Pooled connections for introspection, grid fetches and `apply_changes` (ANG-8 D3).
const META_POOL_SIZE: usize = 3;
const POOL_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

/// A connection idle for this long is checked before it is used again: after the laptop slept or
/// the Wi-Fi changed it can look open and be dead.
const IDLE_CHECK: Duration = Duration::from_secs(20);
/// How long a check may take before the connection counts as lost.
const PING_TIMEOUT: Duration = Duration::from_secs(2);

/// Is the connection answering?
async fn alive(client: &Client) -> bool {
    matches!(
        tokio::time::timeout(PING_TIMEOUT, client.simple_query("SELECT 1")).await,
        Ok(Ok(_))
    )
}

/// What the connection has been through, for the status bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionHealth {
    /// A lost connection was found and a new one is not there yet.
    pub reconnecting: bool,
    /// How many times a lost connection was replaced.
    pub reconnects: u32,
}

#[derive(Default)]
struct Health {
    reconnecting: AtomicBool,
    reconnects: AtomicU32,
    /// 0 checks every connection each time it is used (tests).
    idle_check_ms: AtomicU64,
}

impl Health {
    fn lost(&self) {
        self.reconnecting.store(true, Ordering::SeqCst);
    }

    /// A new connection is working again.
    fn recovered(&self) {
        if self.reconnecting.swap(false, Ordering::SeqCst) {
            self.reconnects.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn idle_check(&self) -> Duration {
        Duration::from_millis(self.idle_check_ms.load(Ordering::SeqCst))
    }
}

/// One open database connection (ANG-8 D3).
///
/// - `meta_pool`: shared, short-lived work.
/// - `tabs`: one dedicated, non-pooled client per query tab, so session state
///   (`SET`, temp tables, `BEGIN` … `COMMIT` across runs) survives between runs.
pub struct Session {
    config: ConnectionConfig,
    info: ConnectionInfo,
    pg_config: Config,
    tls: MakeRustlsConnect,
    meta_pool: Pool,
    tabs: Mutex<HashMap<String, (Arc<Client>, Instant)>>,
    health: Arc<Health>,
    /// What each tab's server connection has said (`RAISE NOTICE`, …) since it was last read.
    notices: std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<Vec<Notice>>>>>,
    /// The SSH tunnel the connections go through, if the connection has one. Shared with the
    /// sessions made by `switch_database`; the tunnel closes when the last of them goes.
    tunnel: std::sync::Mutex<Option<Arc<SshTunnel>>>,
}

impl Session {
    /// Connect and read the server version. Fails fast on bad host, credentials or TLS.
    pub async fn open(config: ConnectionConfig, password: Option<&str>) -> AppResult<Self> {
        Self::open_with_ssh(config, password, None).await
    }

    /// Like [`Session::open`], through the SSH tunnel the connection asks for (`ssh`: its
    /// password or passphrase and where host keys are kept; `None` uses the defaults).
    pub async fn open_with_ssh(
        config: ConnectionConfig,
        password: Option<&str>,
        ssh: Option<SshSetup>,
    ) -> AppResult<Self> {
        Self::open_with(
            config,
            password,
            Extras {
                ssh,
                ..Extras::default()
            },
        )
        .await
    }

    /// [`Session::open`] with everything a connection can need besides its password.
    pub async fn open_with(
        config: ConnectionConfig,
        password: Option<&str>,
        extras: Extras,
    ) -> AppResult<Self> {
        let tls = tls::make_tls(&TlsOptions::of(&config, extras.ssl_key_passphrase))?;
        let tunnel = open_tunnel(&config, extras.ssh).await?;
        let pg_config =
            config::pg_config_via(&config, password, tunnel.as_ref().map(|t| t.local_port()));
        Self::connect(config, pg_config, tls, tunnel).await
    }

    /// Open another database on the same server with the same credentials: a new session
    /// with its own pool (ANG-8 D3). This session stays open and usable if that fails.
    pub async fn switch_database(&self, database: &str) -> AppResult<Self> {
        let mut config = self.config.clone();
        config.database = database.to_owned();
        let mut pg_config = self.pg_config.clone();
        pg_config.dbname(database);
        let tunnel = self
            .tunnel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        Self::connect(config, pg_config, self.tls.clone(), tunnel).await
    }

    async fn connect(
        config: ConnectionConfig,
        pg_config: Config,
        tls: MakeRustlsConnect,
        tunnel: Option<Arc<SshTunnel>>,
    ) -> AppResult<Self> {
        let started = Instant::now();
        let health = Arc::new(Health {
            idle_check_ms: AtomicU64::new(
                u64::try_from(IDLE_CHECK.as_millis()).unwrap_or(u64::MAX),
            ),
            ..Health::default()
        });

        let manager = Manager::from_config(
            pg_config.clone(),
            tls.clone(),
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let mut pool = Pool::builder(manager)
            .max_size(META_POOL_SIZE)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(POOL_WAIT_TIMEOUT))
            .create_timeout(Some(config::CONNECT_TIMEOUT));
        // A new connection: set it up, and if it replaces a lost one, say it is back.
        let init = config::init_sql(&config);
        let recovered = Arc::clone(&health);
        pool = pool.post_create(Hook::async_fn(move |client, _| {
            let (sql, health) = (init.clone(), Arc::clone(&recovered));
            Box::pin(async move {
                if let Some(sql) = sql {
                    client
                        .batch_execute(&sql)
                        .await
                        .map_err(HookError::Backend)?;
                }
                health.recovered();
                Ok(())
            })
        }));
        // A connection that has been idle a while is asked if it is still there before it is used;
        // if not it is dropped and the pool makes a new one.
        let watching = Arc::clone(&health);
        pool = pool.pre_recycle(Hook::async_fn(move |client, metrics| {
            let health = Arc::clone(&watching);
            let idle = metrics.last_used();
            Box::pin(async move {
                if idle < health.idle_check() || alive(client).await {
                    return Ok(());
                }
                health.lost();
                Err(HookError::message("the connection was lost"))
            })
        }));
        let meta_pool = pool.build().map_err(|e| AppError::Pool(e.to_string()))?;

        let server_version = server_version(&*meta_pool.get().await?).await?;
        let info = ConnectionInfo {
            server_version,
            latency_ms: elapsed_ms(started),
        };

        Ok(Self {
            config,
            info,
            pg_config,
            tls,
            meta_pool,
            health,
            tabs: Mutex::new(HashMap::new()),
            notices: std::sync::Mutex::new(HashMap::new()),
            tunnel: std::sync::Mutex::new(tunnel),
        })
    }

    /// The local port of the SSH tunnel, when the connection goes through one.
    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|t| t.local_port())
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    pub fn info(&self) -> &ConnectionInfo {
        &self.info
    }

    /// Whether the connection was lost and found again, for the status bar.
    pub fn health(&self) -> SessionHealth {
        SessionHealth {
            reconnecting: self.health.reconnecting.load(Ordering::SeqCst),
            reconnects: self.health.reconnects.load(Ordering::SeqCst),
        }
    }

    /// Check a connection that has been idle this long before using it again. Zero: every time.
    #[doc(hidden)]
    pub fn set_idle_check(&self, after: Duration) {
        self.health.idle_check_ms.store(
            u64::try_from(after.as_millis()).unwrap_or(u64::MAX),
            Ordering::SeqCst,
        );
    }

    /// A pooled client for short metadata / grid work. Returned to the pool on drop.
    pub async fn meta(&self) -> AppResult<Object> {
        Ok(self.meta_pool.get().await?)
    }

    /// The dedicated client for a query tab, connected on first use and
    /// reconnected if the server closed it.
    pub async fn tab_client(&self, tab_id: &str) -> AppResult<Arc<Client>> {
        let known = self
            .tabs
            .lock()
            .await
            .get(tab_id)
            .map(|(client, used)| (Arc::clone(client), used.elapsed()));
        if let Some((client, idle)) = known
            && !client.is_closed()
        {
            if idle < self.health.idle_check() || alive(&client).await {
                if let Some(entry) = self.tabs.lock().await.get_mut(tab_id) {
                    entry.1 = Instant::now();
                }
                return Ok(client);
            }
            // Open, and not answering: the laptop slept, or the network changed. A new
            // connection is made below (what the old one had set up is gone with it).
            self.health.lost();
        }

        // Connect without holding the lock so other tabs aren't blocked.
        let (client, mut connection) = self.pg_config.connect(self.tls.clone()).await?;
        // The connection is polled by hand so that notices can be kept: they come on the same
        // socket as the results, ahead of the statement's own completion.
        let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&heard);
        tokio::spawn(async move {
            // Ends when the client is dropped or the server closes the socket.
            while let Some(Ok(message)) =
                std::future::poll_fn(|cx| connection.poll_message(cx)).await
            {
                if let AsyncMessage::Notice(notice) = message
                    && let Ok(mut list) = sink.lock()
                {
                    match list.len().cmp(&MAX_NOTICES) {
                        std::cmp::Ordering::Less => list.push(Notice::from(&notice)),
                        std::cmp::Ordering::Equal => list.push(Notice::overflow()),
                        std::cmp::Ordering::Greater => {}
                    }
                }
            }
        });
        if let Some(sql) = config::init_sql(&self.config) {
            client.batch_execute(&sql).await?;
        }

        let client = Arc::new(client);
        if let Ok(mut notices) = self.notices.lock() {
            notices.insert(tab_id.to_owned(), heard);
        }
        self.tabs
            .lock()
            .await
            .insert(tab_id.to_owned(), (Arc::clone(&client), Instant::now()));
        self.health.recovered();
        Ok(client)
    }

    /// What the tab's connection has said since this was last called, oldest first.
    pub fn take_notices(&self, tab_id: &str) -> Vec<Notice> {
        let heard = self
            .notices
            .lock()
            .ok()
            .and_then(|notices| notices.get(tab_id).cloned());
        heard
            .and_then(|list| list.lock().ok().map(|mut list| std::mem::take(&mut *list)))
            .unwrap_or_default()
    }

    /// Close a tab's dedicated connection (dropped once no query still holds it).
    pub async fn close_tab(&self, tab_id: &str) {
        if let Ok(mut notices) = self.notices.lock() {
            notices.remove(tab_id);
        }
        self.tabs.lock().await.remove(tab_id);
    }

    /// Ask the server to cancel whatever the tab is running. Returns `false` if the tab has
    /// no open connection. The running query then fails with SQLSTATE `57014`.
    pub async fn cancel_tab(&self, tab_id: &str) -> AppResult<bool> {
        let Some(client) = self
            .tabs
            .lock()
            .await
            .get(tab_id)
            .map(|(client, _)| Arc::clone(client))
        else {
            return Ok(false);
        };
        client.cancel_token().cancel_query(self.tls.clone()).await?;
        Ok(true)
    }

    /// Close every connection of this session.
    pub async fn close(&self) {
        if let Ok(mut notices) = self.notices.lock() {
            notices.clear();
        }
        self.tabs.lock().await.clear();
        self.meta_pool.close();
        // Let go of the tunnel: it closes with the last session that uses it.
        self.tunnel.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

/// What a connection needs besides its settings and password: the SSH secret, and the passphrase
/// of its TLS client key.
#[derive(Default)]
pub struct Extras {
    pub ssh: Option<SshSetup>,
    pub ssl_key_passphrase: Option<String>,
}

/// Open the SSH tunnel of a connection that has one.
async fn open_tunnel(
    config: &ConnectionConfig,
    setup: Option<SshSetup>,
) -> AppResult<Option<Arc<SshTunnel>>> {
    let Some(ssh) = &config.ssh else {
        return Ok(None);
    };
    let setup = setup.unwrap_or_else(|| SshSetup::new(None));
    let tunnel = SshTunnel::open(ssh, &setup, &config.host, config.port).await?;
    Ok(Some(Arc::new(tunnel)))
}

async fn server_version(client: &Client) -> AppResult<String> {
    let row = client
        .query_one("SELECT current_setting('server_version')", &[])
        .await?;
    Ok(row.get(0))
}

fn elapsed_ms(since: Instant) -> u32 {
    u32::try_from(since.elapsed().as_millis()).unwrap_or(u32::MAX)
}

/// Hard limit for a connection test. The driver's own connect timeout only covers the TCP
/// connect, not TLS or authentication, so a half-open server could otherwise hang the form.
const TEST_TIMEOUT: Duration = Duration::from_secs(6);

/// Connect once with the given (possibly unsaved) settings and report the server version.
/// Uses no pool and keeps nothing open afterwards.
pub async fn test_connection(
    config: &ConnectionConfig,
    password: Option<&str>,
) -> AppResult<ConnectionInfo> {
    test_connection_with_ssh(config, password, None).await
}

/// [`test_connection`] through the SSH tunnel the settings ask for. The tunnel is closed again
/// afterwards; logging in to the SSH server has its own time limit.
pub async fn test_connection_with_ssh(
    config: &ConnectionConfig,
    password: Option<&str>,
    ssh: Option<SshSetup>,
) -> AppResult<ConnectionInfo> {
    test_connection_with(
        config,
        password,
        Extras {
            ssh,
            ..Extras::default()
        },
    )
    .await
}

/// [`test_connection`] with everything a connection can need besides its password.
pub async fn test_connection_with(
    config: &ConnectionConfig,
    password: Option<&str>,
    extras: Extras,
) -> AppResult<ConnectionInfo> {
    let started = Instant::now();
    let tls = tls::make_tls(&TlsOptions::of(config, extras.ssl_key_passphrase))?;
    let tunnel = open_tunnel(config, extras.ssh).await?;
    let pg_config =
        config::pg_config_via(config, password, tunnel.as_ref().map(|t| t.local_port()));

    let attempt = async {
        let (client, connection) = pg_config.connect(tls).await?;
        let driver = tokio::spawn(connection);
        let version = server_version(&client).await;
        drop(client);
        driver.abort();
        version
    };

    let server_version = tokio::time::timeout(TEST_TIMEOUT, attempt)
        .await
        .map_err(|_| {
            AppError::Timeout(format!(
                "no response from {}:{} after {} seconds",
                config.host,
                config.port,
                TEST_TIMEOUT.as_secs()
            ))
        })??;

    Ok(ConnectionInfo {
        server_version,
        latency_ms: elapsed_ms(started),
    })
}
