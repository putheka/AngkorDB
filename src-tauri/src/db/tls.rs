//! TLS for Postgres connections: rustls (ring) (ANG-44).
//!
//! The SSL modes mean what they mean in libpq:
//!
//! | mode        | TLS      | the server's certificate                       |
//! |-------------|----------|-------------------------------------------------|
//! | disable     | never    | –                                               |
//! | prefer      | if offered | not checked                                   |
//! | require     | always   | not checked (encryption only)                  |
//! | verify-ca   | always   | must chain to a trusted root; name not checked |
//! | verify-full | always   | chain and host name                            |
//!
//! The trusted roots are the macOS system roots, unless a root certificate file is given: then
//! that file is the only root (a private CA is not trusted next to every public one). A client
//! certificate and its key (plain, or protected by a passphrase) are sent when the server asks.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use pkcs8::{EncryptedPrivateKeyInfo, SecretDocument};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error as TlsError, RootCertStore,
    SignatureScheme,
};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error::{AppError, AppResult};
use crate::models::connection::{ConnectionConfig, SslMode};

/// What building a connector needs: the mode, the files, and the key's passphrase.
#[derive(Clone)]
pub struct TlsOptions {
    pub mode: SslMode,
    pub root_cert: Option<PathBuf>,
    pub client_cert: Option<PathBuf>,
    pub client_key: Option<PathBuf>,
    pub key_passphrase: Option<String>,
}

// Never print the passphrase, even in debug logs.
impl std::fmt::Debug for TlsOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsOptions")
            .field("mode", &self.mode)
            .field("root_cert", &self.root_cert)
            .field("client_cert", &self.client_cert)
            .field("client_key", &self.client_key)
            .field(
                "key_passphrase",
                &self.key_passphrase.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl TlsOptions {
    /// No files: the mode alone.
    pub fn mode(mode: SslMode) -> Self {
        Self {
            mode,
            root_cert: None,
            client_cert: None,
            client_key: None,
            key_passphrase: None,
        }
    }

    /// The saved settings of a connection, and the passphrase of its client key.
    pub fn of(config: &ConnectionConfig, key_passphrase: Option<String>) -> Self {
        let files = config.ssl_files.as_ref();
        let path = |p: &Option<String>| p.as_deref().map(expand_home);
        Self {
            mode: config.ssl_mode,
            root_cert: files.and_then(|f| path(&f.root_cert)),
            client_cert: files.and_then(|f| path(&f.client_cert)),
            client_key: files.and_then(|f| path(&f.client_key)),
            key_passphrase,
        }
    }
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest),
        None => PathBuf::from(path),
    }
}

/// Loading the system certificates takes ~100 ms, so read them once per process.
static SYSTEM_ROOTS: OnceLock<RootCertStore> = OnceLock::new();

fn system_roots() -> RootCertStore {
    SYSTEM_ROOTS
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            // Certificates the system store returns but rustls can't parse are skipped.
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            roots
        })
        .clone()
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// The trusted roots: the file's certificates when there is one, else the system's.
fn roots(file: Option<&Path>) -> AppResult<RootCertStore> {
    let Some(file) = file else {
        return Ok(system_roots());
    };
    let certs = read_certs(file, "root certificate")?;
    let mut roots = RootCertStore::empty();
    let (added, _) = roots.add_parsable_certificates(certs);
    if added == 0 {
        return Err(invalid(format!(
            "{} has no usable certificate. It should be a PEM file (-----BEGIN CERTIFICATE-----).",
            file.display()
        )));
    }
    Ok(roots)
}

fn read_certs(file: &Path, what: &str) -> AppResult<Vec<CertificateDer<'static>>> {
    let certs = CertificateDer::pem_file_iter(file)
        .map_err(|e| unreadable(file, what, &e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| unreadable(file, what, &e))?;
    if certs.is_empty() {
        return Err(invalid(format!(
            "{} has no certificate. It should be a PEM file (-----BEGIN CERTIFICATE-----).",
            file.display()
        )));
    }
    Ok(certs)
}

fn unreadable(file: &Path, what: &str, error: &dyn std::fmt::Display) -> AppError {
    match error.to_string() {
        text if text.contains("No such file") || text.contains("not found") => {
            invalid(format!("There is no {what} at {}.", file.display()))
        }
        text => invalid(format!("Can't read the {what} {}: {text}.", file.display())),
    }
}

/// The client key: PEM, as PKCS#8, PKCS#1 or SEC1, or PKCS#8 protected by a passphrase.
fn read_key(file: &Path, passphrase: Option<&str>) -> AppResult<PrivateKeyDer<'static>> {
    let text = std::fs::read_to_string(file).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            invalid(format!("There is no client key at {}.", file.display()))
        } else {
            invalid(format!(
                "Can't read the client key {}: {e}.",
                file.display()
            ))
        }
    })?;

    if text.contains("BEGIN ENCRYPTED PRIVATE KEY") {
        let Some(passphrase) = passphrase.filter(|p| !p.is_empty()) else {
            return Err(invalid(format!(
                "The client key {} is protected by a passphrase: enter it.",
                file.display()
            )));
        };
        let wrong = || {
            invalid(format!(
                "Can't unlock the client key {}: the passphrase is wrong, or the key is damaged.",
                file.display()
            ))
        };
        let (_, document) = SecretDocument::from_pem(&text).map_err(|_| wrong())?;
        let encrypted =
            EncryptedPrivateKeyInfo::try_from(document.as_bytes()).map_err(|_| wrong())?;
        let plain = encrypted.decrypt(passphrase).map_err(|_| wrong())?;
        return Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            plain.as_bytes().to_vec(),
        )));
    }
    if text.contains("Proc-Type: 4,ENCRYPTED") {
        return Err(invalid(format!(
            "The client key {} uses an old encrypted format. Convert it: \
             openssl pkcs8 -topk8 -in key.pem -out key-pkcs8.pem",
            file.display()
        )));
    }
    PrivateKeyDer::from_pem_slice(text.as_bytes()).map_err(|_| {
        invalid(format!(
            "{} has no private key. It should be a PEM file (-----BEGIN PRIVATE KEY-----).",
            file.display()
        ))
    })
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts any certificate: `prefer` and `require` only ask for encryption. The handshake
/// signatures are still checked, so the connection is with whoever holds the certificate's key.
#[derive(Debug)]
struct AcceptAnyCert(WebPkiSupportedAlgorithms);

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_schemes()
    }
}

/// `verify-ca`: the chain must lead to a trusted root, but the certificate may be for another
/// name (what libpq does). Anything else wrong with it is still refused.
#[derive(Debug)]
struct IgnoreServerName(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for IgnoreServerName {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
        {
            // The name is checked after the chain, so this means the chain is good.
            Err(TlsError::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

/// The connector for these settings. Reads the certificate and key files, so a missing file or
/// a wrong passphrase is reported here, before any connection is tried.
pub fn make_tls(options: &TlsOptions) -> AppResult<MakeRustlsConnect> {
    let provider = provider();
    let algorithms = provider.signature_verification_algorithms;
    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Tls(e.to_string()))?;

    let wants_client_auth = match options.mode {
        SslMode::VerifyFull => {
            let roots = roots(options.root_cert.as_deref())?;
            builder.with_root_certificates(roots)
        }
        SslMode::VerifyCa => {
            let roots = roots(options.root_cert.as_deref())?;
            let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .map_err(|e| AppError::Tls(e.to_string()))?;
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(IgnoreServerName(inner)))
        }
        SslMode::Disable | SslMode::Prefer | SslMode::Require => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(algorithms))),
    };

    let config = match (&options.client_cert, &options.client_key) {
        (Some(cert), Some(key)) => {
            let chain = read_certs(cert, "client certificate")?;
            let key = read_key(key, options.key_passphrase.as_deref())?;
            wants_client_auth
                .with_client_auth_cert(chain, key)
                .map_err(|e| {
                    invalid(format!(
                        "The client certificate and its key don't work together: {e}."
                    ))
                })?
        }
        (None, None) => wants_client_auth.with_no_client_auth(),
        _ => {
            return Err(invalid(
                "A client certificate and its key go together: give both, or neither.",
            ));
        }
    };
    Ok(MakeRustlsConnect::new(config))
}

/// A rustls failure in words that say what to do.
pub fn explain(error: &TlsError) -> Option<String> {
    Some(match error {
        TlsError::InvalidCertificate(problem) => match problem {
            CertificateError::UnknownIssuer => {
                "The server's certificate was signed by an authority \
                 this Mac doesn't trust. Choose the root certificate (CA) file of the server, or \
                 set SSL to Require if you only need encryption."
                    .to_owned()
            }
            CertificateError::NotValidForName => {
                "The server's certificate is for another host name \
                 than the one you connect to. Connect with the name in the certificate, or use \
                 Verify CA."
                    .to_owned()
            }
            CertificateError::NotValidForNameContext {
                expected,
                presented,
            } => {
                let expected = match expected {
                    ServerName::DnsName(name) => name.as_ref().to_owned(),
                    ServerName::IpAddress(ip) => format!("{:?}", std::net::IpAddr::from(*ip)),
                    _ => "this server".to_owned(),
                };
                format!(
                    "The server's certificate is for {}, not for {expected}. Connect with the name \
                     in the certificate, or use Verify CA.",
                    if presented.is_empty() {
                        "no host name".to_owned()
                    } else {
                        presented.join(", ")
                    }
                )
            }
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => {
                "The server's certificate has expired.".to_owned()
            }
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                "The server's certificate is not valid yet: check this Mac's clock.".to_owned()
            }
            CertificateError::Revoked => "The server's certificate has been revoked.".to_owned(),
            other => format!("The server's certificate was refused ({other:?})."),
        },
        TlsError::AlertReceived(alert) => {
            format!(
                "The server ended the TLS handshake ({alert:?}). If it asks for a client certificate, choose one."
            )
        }
        _ => return None,
    })
}
