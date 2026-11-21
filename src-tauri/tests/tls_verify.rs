//! The TLS modes and certificate files (ANG-44), against a TLS server run in this process, so
//! every case of certificate (wrong name, expired, unknown CA, client certificate…) is exact.
//! `tls.rs` (Postgres in a container) checks the same with a real server.

use std::sync::Arc;

use angkordb_lib::db::tls::{TlsOptions, explain, make_tls};
use angkordb_lib::error::AppError;
use angkordb_lib::models::connection::SslMode;
use pkcs8::PrivateKeyInfo;
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, date_time_ymd,
};
use rustls::RootCertStore;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_postgres::tls::{MakeTlsConnect, TlsConnect};
use tokio_rustls::TlsAcceptor;

struct Ca {
    issuer: CertifiedIssuer<'static, KeyPair>,
}

impl Ca {
    fn new(name: &str) -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, name);
        Self {
            issuer: CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap(),
        }
    }

    fn pem(&self) -> String {
        self.issuer.pem()
    }

    fn issue(&self, names: &[&str], valid: Validity, client: bool) -> Leaf {
        let key = KeyPair::generate().unwrap();
        let mut params =
            CertificateParams::new(names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>())
                .unwrap();
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(
            DnType::CommonName,
            names.first().copied().unwrap_or("client"),
        );
        params.extended_key_usages = vec![if client {
            ExtendedKeyUsagePurpose::ClientAuth
        } else {
            ExtendedKeyUsagePurpose::ServerAuth
        }];
        match valid {
            Validity::Now => {}
            Validity::Expired => {
                params.not_before = date_time_ymd(2001, 1, 1);
                params.not_after = date_time_ymd(2002, 1, 1);
            }
        }
        let cert = params.signed_by(&key, &self.issuer).unwrap();
        Leaf {
            cert_pem: cert.pem(),
            key_pem: key.serialize_pem(),
            key_der: key.serialize_der(),
        }
    }
}

#[derive(Clone, Copy)]
enum Validity {
    Now,
    Expired,
}

struct Leaf {
    cert_pem: String,
    key_pem: String,
    key_der: Vec<u8>,
}

/// A server that completes the handshake and echoes one byte; `client_ca` makes it ask for a
/// client certificate (and refuse a connection without a good one).
async fn serve(server: &Leaf, client_ca: Option<&Ca>) -> u16 {
    let chain: Vec<CertificateDer<'static>> =
        CertificateDer::pem_slice_iter(server.cert_pem.as_bytes())
            .collect::<Result<_, _>>()
            .unwrap();
    let key = PrivateKeyDer::from_pem_slice(server.key_pem.as_bytes()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .unwrap();
    let config = match client_ca {
        Some(ca) => {
            let mut roots = RootCertStore::empty();
            roots.add(ca.issuer.der().clone()).unwrap();
            let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .unwrap();
            builder.with_client_cert_verifier(verifier)
        }
        None => builder.with_no_client_auth(),
    }
    .with_single_cert(chain, key)
    .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(mut stream) = acceptor.accept(socket).await {
                    let mut byte = [0u8; 1];
                    if stream.read_exact(&mut byte).await.is_ok() {
                        let _ = stream.write_all(&byte).await;
                        let _ = stream.flush().await;
                    }
                }
            });
        }
    });
    port
}

/// Connect with these settings as `name`: `Ok` when a byte makes the round trip, else what went
/// wrong, in the words the app uses.
async fn connect(port: u16, options: &TlsOptions, name: &str) -> Result<(), String> {
    let mut maker = make_tls(options).map_err(|e: AppError| e.message())?;
    let tls = <_ as MakeTlsConnect<TcpStream>>::make_tls_connect(&mut maker, name).unwrap();
    let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut stream = tls.connect(socket).await.map_err(describe)?;
    stream.write_all(b"x").await.map_err(describe)?;
    stream.flush().await.map_err(describe)?;
    let mut echoed = [0u8; 1];
    stream.read_exact(&mut echoed).await.map_err(describe)?;
    Ok(())
}

fn describe(error: std::io::Error) -> String {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        .and_then(explain)
        .unwrap_or_else(|| error.to_string())
}

struct Files {
    dir: TempDir,
}

impl Files {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    fn write(&self, name: &str, text: &str) -> std::path::PathBuf {
        let path = self.dir.path().join(name);
        std::fs::write(&path, text).unwrap();
        path
    }
}

fn mode(mode: SslMode, root: Option<&std::path::Path>) -> TlsOptions {
    TlsOptions {
        root_cert: root.map(std::path::Path::to_path_buf),
        ..TlsOptions::mode(mode)
    }
}

#[tokio::test]
async fn verify_full_checks_the_chain_and_the_host_name() {
    let (ca, files) = (Ca::new("Test CA"), Files::new());
    let server = ca.issue(&["localhost"], Validity::Now, false);
    let port = serve(&server, None).await;
    let root = files.write("ca.pem", &ca.pem());
    let full = mode(SslMode::VerifyFull, Some(&root));

    connect(port, &full, "localhost").await.unwrap();
    let wrong = connect(port, &full, "other.example").await.unwrap_err();
    assert!(
        wrong.contains("localhost") && wrong.contains("other.example"),
        "{wrong}"
    );
    // Without the CA the system roots are used, and they don't know this one.
    let unknown = connect(port, &mode(SslMode::VerifyFull, None), "localhost")
        .await
        .unwrap_err();
    assert!(unknown.contains("doesn't trust"), "{unknown}");
    // Another CA's file doesn't help either.
    let stranger = files.write("other-ca.pem", &Ca::new("Someone else").pem());
    let other = connect(
        port,
        &mode(SslMode::VerifyFull, Some(&stranger)),
        "localhost",
    )
    .await
    .unwrap_err();
    assert!(other.contains("doesn't trust"), "{other}");
}

#[tokio::test]
async fn verify_ca_checks_the_chain_but_not_the_name() {
    let (ca, files) = (Ca::new("Test CA"), Files::new());
    let server = ca.issue(&["localhost"], Validity::Now, false);
    let port = serve(&server, None).await;
    let root = files.write("ca.pem", &ca.pem());

    let verify_ca = mode(SslMode::VerifyCa, Some(&root));
    connect(port, &verify_ca, "localhost").await.unwrap();
    connect(port, &verify_ca, "other.example").await.unwrap();
    let unknown = connect(port, &mode(SslMode::VerifyCa, None), "other.example")
        .await
        .unwrap_err();
    assert!(unknown.contains("doesn't trust"), "{unknown}");
}

#[tokio::test]
async fn prefer_and_require_encrypt_without_checking_the_certificate() {
    let (ca, files) = (Ca::new("Unknown CA"), Files::new());
    let server = ca.issue(&["not-this-host"], Validity::Expired, false);
    let port = serve(&server, None).await;
    let _ = files;
    for ssl_mode in [SslMode::Prefer, SslMode::Require] {
        connect(port, &mode(ssl_mode, None), "localhost")
            .await
            .unwrap();
    }
    // The same certificate is refused as soon as it is to be checked.
    let checked = connect(port, &mode(SslMode::VerifyCa, None), "localhost")
        .await
        .unwrap_err();
    assert!(
        checked.contains("doesn't trust") || checked.contains("expired"),
        "{checked}"
    );
}

#[tokio::test]
async fn an_expired_certificate_is_refused_when_it_is_checked() {
    let (ca, files) = (Ca::new("Test CA"), Files::new());
    let server = ca.issue(&["localhost"], Validity::Expired, false);
    let port = serve(&server, None).await;
    let root = files.write("ca.pem", &ca.pem());
    for ssl_mode in [SslMode::VerifyCa, SslMode::VerifyFull] {
        let error = connect(port, &mode(ssl_mode, Some(&root)), "localhost")
            .await
            .unwrap_err();
        assert!(error.contains("expired"), "{error}");
    }
}

/// The key as `openssl pkcs8 -topk8` writes it with a passphrase (PBES2, PBKDF2 and AES-256).
/// Few iterations: this only has to be readable, not hard to guess, and debug builds are slow.
fn protect(key_der: &[u8], passphrase: &str) -> String {
    let params =
        pkcs8::pkcs5::pbes2::Parameters::pbkdf2_sha256_aes256cbc(1000, &[7; 16], &[9; 16]).unwrap();
    let info = PrivateKeyInfo::try_from(key_der).unwrap();
    let encrypted = info.encrypt_with_params(params, passphrase).unwrap();
    encrypted
        .to_pem("ENCRYPTED PRIVATE KEY", pkcs8::LineEnding::LF)
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_client_certificate_is_sent_when_the_server_asks_with_a_plain_or_protected_key() {
    let (ca, files) = (Ca::new("Test CA"), Files::new());
    let server = ca.issue(&["localhost"], Validity::Now, false);
    let port = serve(&server, Some(&ca)).await;
    let root = files.write("ca.pem", &ca.pem());
    let client = ca.issue(&["certuser"], Validity::Now, true);
    let cert = files.write("client.crt", &client.cert_pem);
    let plain_key = files.write("client.key", &client.key_pem);
    let protected_key = files.write("client-protected.key", &protect(&client.key_der, "s3cret"));

    let with = |key: &std::path::Path, passphrase: Option<&str>| TlsOptions {
        client_cert: Some(cert.clone()),
        client_key: Some(key.to_path_buf()),
        key_passphrase: passphrase.map(str::to_owned),
        ..mode(SslMode::VerifyFull, Some(&root))
    };
    connect(port, &with(&plain_key, None), "localhost")
        .await
        .unwrap();
    connect(port, &with(&protected_key, Some("s3cret")), "localhost")
        .await
        .unwrap();

    // Without a certificate the server turns the connection away.
    let none = connect(port, &mode(SslMode::VerifyFull, Some(&root)), "localhost").await;
    assert!(
        none.is_err(),
        "the server asked for a certificate and got none"
    );

    // A protected key: say so when there is no passphrase, and when it is wrong.
    let missing = connect(port, &with(&protected_key, None), "localhost")
        .await
        .unwrap_err();
    assert!(missing.contains("protected by a passphrase"), "{missing}");
    let wrong = connect(port, &with(&protected_key, Some("nope")), "localhost")
        .await
        .unwrap_err();
    assert!(wrong.contains("passphrase is wrong"), "{wrong}");
}

#[tokio::test]
async fn files_that_are_missing_or_wrong_are_explained_before_connecting() {
    let (ca, files) = (Ca::new("Test CA"), Files::new());
    let root = files.write("ca.pem", &ca.pem());
    let client = ca.issue(&["certuser"], Validity::Now, true);
    let cert = files.write("client.crt", &client.cert_pem);
    let key = files.write("client.key", &client.key_pem);
    let other_key = files.write("other.key", &KeyPair::generate().unwrap().serialize_pem());
    let garbage = files.write("garbage.pem", "this is not a certificate\n");
    let nowhere = files.dir.path().join("nowhere.pem");
    let full = |extra: TlsOptions| extra;
    let check = |options: TlsOptions, expected: &str| {
        let error = match make_tls(&options) {
            Ok(_) => panic!("expected: {expected}"),
            Err(e) => e,
        };
        assert_eq!(error.code(), "VALIDATION", "{error:?}");
        assert!(
            error.message().contains(expected),
            "{expected}: {}",
            error.message()
        );
    };

    check(
        TlsOptions {
            root_cert: Some(nowhere.clone()),
            ..TlsOptions::mode(SslMode::VerifyFull)
        },
        "There is no root certificate",
    );
    check(
        TlsOptions {
            root_cert: Some(garbage.clone()),
            ..TlsOptions::mode(SslMode::VerifyFull)
        },
        "has no certificate",
    );
    check(
        TlsOptions {
            client_cert: Some(cert.clone()),
            client_key: Some(nowhere),
            ..TlsOptions::mode(SslMode::Require)
        },
        "There is no client key",
    );
    check(
        TlsOptions {
            client_cert: Some(cert.clone()),
            client_key: Some(garbage),
            ..TlsOptions::mode(SslMode::Require)
        },
        "has no private key",
    );
    check(
        TlsOptions {
            client_cert: Some(cert.clone()),
            ..TlsOptions::mode(SslMode::Require)
        },
        "go together",
    );
    check(
        TlsOptions {
            client_cert: Some(cert.clone()),
            client_key: Some(other_key),
            ..TlsOptions::mode(SslMode::Require)
        },
        "don't work together",
    );
    // The right ones work, and the root file is only read for the modes that verify.
    let good = full(TlsOptions {
        root_cert: Some(root),
        client_cert: Some(cert),
        client_key: Some(key),
        ..TlsOptions::mode(SslMode::VerifyFull)
    });
    assert!(make_tls(&good).is_ok());
}

#[test]
fn the_passphrase_never_shows_in_debug_output() {
    let options = TlsOptions {
        key_passphrase: Some("hunter2".into()),
        ..TlsOptions::mode(SslMode::Require)
    };
    let text = format!("{options:?}");
    assert!(!text.contains("hunter2"), "{text}");
    assert!(text.contains("redacted"));
}
