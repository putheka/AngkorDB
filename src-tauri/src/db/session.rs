use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::{Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime};
use tokio::sync::Mutex;
use tokio_postgres::{Client, Config};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::db::{config, tls};
use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;

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
    pg_config: Config,
    tls: MakeRustlsConnect,
    meta_pool: Pool,
    tabs: Mutex<HashMap<String, Arc<Client>>>,
}

impl Session {
    /// Connect and verify with `SELECT 1`. Fails fast on bad host, credentials or TLS.
    pub async fn open(config: ConnectionConfig, password: Option<&str>) -> AppResult<Self> {
        let pg_config = config::pg_config(&config, password);
        let tls = tls::make_tls()?;

        let manager = Manager::from_config(
            pg_config.clone(),
            tls.clone(),
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let meta_pool = Pool::builder(manager)
            .max_size(META_POOL_SIZE)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(POOL_WAIT_TIMEOUT))
            .create_timeout(Some(config::CONNECT_TIMEOUT))
            .build()
            .map_err(|e| AppError::Pool(e.to_string()))?;

        meta_pool.get().await?.simple_query("SELECT 1").await?;

        Ok(Self {
            config,
            pg_config,
            tls,
            meta_pool,
            tabs: Mutex::new(HashMap::new()),
        })
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
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
