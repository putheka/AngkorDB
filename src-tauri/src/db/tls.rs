//! TLS for Postgres connections: rustls (ring) + macOS system root certificates.
//! Custom CA files and client certificates come in ANG-44.

use std::sync::{Arc, OnceLock};

use rustls::{ClientConfig, RootCertStore};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error::{AppError, AppResult};

/// Loading system certificates takes ~100 ms, so build the config once per process.
static CLIENT_CONFIG: OnceLock<Result<ClientConfig, String>> = OnceLock::new();

pub fn make_tls() -> AppResult<MakeRustlsConnect> {
    let config = CLIENT_CONFIG
        .get_or_init(build_client_config)
        .clone()
        .map_err(AppError::Tls)?;
    Ok(MakeRustlsConnect::new(config))
}

fn build_client_config() -> Result<ClientConfig, String> {
    let mut roots = RootCertStore::empty();
    // Certificates the system store returns but rustls can't parse are skipped.
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth())
}
