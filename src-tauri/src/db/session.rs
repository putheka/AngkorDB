use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use deadpool_postgres::{
    Hook, HookError, Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime,
};
use tokio::sync::Mutex;
use tokio_postgres::{Client, Config};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::db::{config, tls};
use crate::error::{AppError, AppResult};
use crate::models::connection::{ConnectionConfig, ConnectionInfo};

/// Pooled connections for introspection, grid fetches and `apply_changes` (ANG-8 D3).
const META_POOL_SIZE: usize = 3;
const POOL_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

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
    tabs: Mutex<HashMap<String, Arc<Client>>>,
}

impl Session {
    /// Connect and read the server version. Fails fast on bad host, credentials or TLS.
    pub async fn open(config: ConnectionConfig, password: Option<&str>) -> AppResult<Self> {
        let pg_config = config::pg_config(&config, password);
        Self::connect(config, pg_config).await
    }

    /// Open another database on the same server with the same credentials: a new session
    /// with its own pool (ANG-8 D3). This session stays open and usable if that fails.
    pub async fn switch_database(&self, database: &str) -> AppResult<Self> {
        let mut config = self.config.clone();
        config.database = database.to_owned();
        let mut pg_config = self.pg_config.clone();
        pg_config.dbname(database);
        Self::connect(config, pg_config).await
    }

    async fn connect(config: ConnectionConfig, pg_config: Config) -> AppResult<Self> {
        let started = Instant::now();
        let tls = tls::make_tls()?;

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
        if let Some(sql) = config::init_sql(&config) {
            pool = pool.post_create(Hook::async_fn(move |client, _| {
                let sql = sql.clone();
                Box::pin(
                    async move { client.batch_execute(&sql).await.map_err(HookError::Backend) },
                )
            }));
        }
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
            tabs: Mutex::new(HashMap::new()),
        })
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    pub fn info(&self) -> &ConnectionInfo {
        &self.info
    }

    /// A pooled client for short metadata / grid work. Returned to the pool on drop.
    pub async fn meta(&self) -> AppResult<Object> {
        Ok(self.meta_pool.get().await?)
    }

    /// The dedicated client for a query tab, connected on first use and
    /// reconnected if the server closed it.
    pub async fn tab_client(&self, tab_id: &str) -> AppResult<Arc<Client>> {
        if let Some(client) = self.tabs.lock().await.get(tab_id)
            && !client.is_closed()
        {
            return Ok(Arc::clone(client));
        }

        // Connect without holding the lock so other tabs aren't blocked.
        let (client, connection) = self.pg_config.connect(self.tls.clone()).await?;
        tokio::spawn(async move {
            // Ends when the client is dropped or the server closes the socket.
            let _ = connection.await;
        });
        if let Some(sql) = config::init_sql(&self.config) {
            client.batch_execute(&sql).await?;
        }

        let client = Arc::new(client);
        self.tabs
            .lock()
            .await
            .insert(tab_id.to_owned(), Arc::clone(&client));
        Ok(client)
    }

    /// Close a tab's dedicated connection (dropped once no query still holds it).
    pub async fn close_tab(&self, tab_id: &str) {
        self.tabs.lock().await.remove(tab_id);
    }

    /// Ask the server to cancel whatever the tab is running. Returns `false` if the tab has
    /// no open connection. The running query then fails with SQLSTATE `57014`.
    pub async fn cancel_tab(&self, tab_id: &str) -> AppResult<bool> {
        let Some(client) = self.tabs.lock().await.get(tab_id).cloned() else {
            return Ok(false);
        };
        client.cancel_token().cancel_query(self.tls.clone()).await?;
        Ok(true)
    }

    /// Close every connection of this session.
    pub async fn close(&self) {
        self.tabs.lock().await.clear();
        self.meta_pool.close();
    }
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
    let started = Instant::now();
    let pg_config = config::pg_config(config, password);
    let tls = tls::make_tls()?;

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
