//! The SSL modes and certificate files against a real Postgres that insists on TLS
//! (`npm run db:up` starts one on port 54330; see `dev/tls/`). `tls_verify.rs` covers every
//! kind of bad certificate with a server of its own.

mod common;

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use angkordb_lib::db::session::{Extras, Session, test_connection_with};
use angkordb_lib::error::AppError;
use angkordb_lib::models::connection::{ConnectionConfig, SslFiles, SslMode};
use common::{DEV_PASSWORD, db_required, dev_config};

fn tls_port() -> u16 {
    std::env::var("ANGKORDB_TEST_TLS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(54330)
}

fn certs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev/tls/certs")
}

fn cert(name: &str) -> String {
    certs().join(name).display().to_string()
}

fn available() -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{}", tls_port()).parse().unwrap();
    if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok() {
        assert!(
            certs().join("ca.crt").exists(),
            "the TLS test server is up but dev/tls/certs has no certificates"
        );
        return true;
    }
    assert!(
        !db_required(),
        "the TLS test server is not reachable on port {}: run `npm run db:up`",
        tls_port()
    );
    eprintln!("SKIPPED: TLS test server not reachable. Run `npm run db:up`.");
    false
}

/// A connection to the TLS server: `angkor` with a password, as `host`, in this mode.
fn config(host: &str, mode: SslMode, files: Option<SslFiles>) -> ConnectionConfig {
    ConnectionConfig {
        host: host.into(),
        port: tls_port(),
        ssl_mode: mode,
        ssl_files: files,
        ..dev_config()
    }
}

fn root_only() -> Option<SslFiles> {
    Some(SslFiles {
        root_cert: Some(cert("ca.crt")),
        ..SslFiles::default()
    })
}

fn client_files(key: &str) -> Option<SslFiles> {
    Some(SslFiles {
        root_cert: Some(cert("ca.crt")),
        client_cert: Some(cert("client.crt")),
        client_key: Some(cert(key)),
        has_key_secret: false,
    })
}

/// Open a session and read `(current_user, whether this very connection uses TLS)`.
async fn who(
    config: ConnectionConfig,
    password: Option<&str>,
    passphrase: Option<&str>,
) -> Result<(String, bool), AppError> {
    let extras = Extras {
        ssl_key_passphrase: passphrase.map(str::to_owned),
        ..Extras::default()
    };
    let session = Session::open_with(config, password, extras).await?;
    let row = session
        .meta()
        .await?
        .query_one(
            "SELECT current_user::text, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid())",
            &[],
        )
        .await?;
    let answer = (row.get(0), row.get(1));
    session.close().await;
    Ok(answer)
}

#[tokio::test]
async fn require_and_prefer_encrypt_without_certificates_and_disable_is_turned_away() {
    if !available() {
        return;
    }
    for mode in [SslMode::Require, SslMode::Prefer] {
        let (user, tls) = who(config("localhost", mode, None), Some(DEV_PASSWORD), None)
            .await
            .unwrap();
        assert_eq!(user, "angkor");
        assert!(tls, "{mode:?} did not use TLS");
    }
    // The server refuses plain connections.
    let plain = who(
        config("localhost", SslMode::Disable, None),
        Some(DEV_PASSWORD),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(plain.pg_code(), Some("28000"), "{plain:?}");
}

#[tokio::test]
async fn verify_ca_and_verify_full_with_the_servers_root_certificate() {
    if !available() {
        return;
    }
    let password = Some(DEV_PASSWORD);
    // The certificate is for `localhost`: verify-full agrees, and verify-ca doesn't care.
    for mode in [SslMode::VerifyCa, SslMode::VerifyFull] {
        let (_, tls) = who(config("localhost", mode, root_only()), password, None)
            .await
            .unwrap();
        assert!(tls);
    }
    // Over the IP it is not: verify-ca still connects, verify-full refuses and says why.
    let (_, tls) = who(
        config("127.0.0.1", SslMode::VerifyCa, root_only()),
        password,
        None,
    )
    .await
    .unwrap();
    assert!(tls);
    let wrong = who(
        config("127.0.0.1", SslMode::VerifyFull, root_only()),
        password,
        None,
    )
    .await
    .unwrap_err();
    assert!(
        wrong.message().contains("not for 127.0.0.1") && wrong.message().contains("localhost"),
        "{}",
        wrong.message()
    );
}

#[tokio::test]
async fn without_the_root_certificate_the_system_roots_do_not_know_the_server() {
    if !available() {
        return;
    }
    for mode in [SslMode::VerifyCa, SslMode::VerifyFull] {
        let error = who(config("localhost", mode, None), Some(DEV_PASSWORD), None)
            .await
            .unwrap_err();
        assert!(
            error.message().contains("doesn't trust"),
            "{mode:?}: {}",
            error.message()
        );
    }
    // A missing root file is explained, not a handshake failure.
    let missing = who(
        config(
            "localhost",
            SslMode::VerifyFull,
            Some(SslFiles {
                root_cert: Some("/nonexistent/ca.crt".into()),
                ..SslFiles::default()
            }),
        ),
        Some(DEV_PASSWORD),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code(), "VALIDATION");
    assert!(
        missing.message().contains("There is no root certificate"),
        "{}",
        missing.message()
    );
}

#[tokio::test]
async fn a_client_certificate_logs_in_without_a_password() {
    if !available() {
        return;
    }
    let as_certuser = |key: &str| config("localhost", SslMode::VerifyFull, client_files(key));
    let certuser = |c: ConnectionConfig| ConnectionConfig {
        user: "certuser".into(),
        ..c
    };

    // A plain key, an old-style RSA key and a key protected by a passphrase.
    for key in ["client.key", "client-rsa.key"] {
        let (user, tls) = who(certuser(as_certuser(key)), None, None).await.unwrap();
        assert_eq!((user.as_str(), tls), ("certuser", true), "{key}");
    }
    let protected = certuser(as_certuser("client-protected.key"));
    let (user, _) = who(protected.clone(), None, Some("angkor-key"))
        .await
        .unwrap();
    assert_eq!(user, "certuser");

    // Without the passphrase, or with a wrong one, the key can't be used, and it says so.
    let none = who(protected.clone(), None, None).await.unwrap_err();
    assert!(
        none.message().contains("protected by a passphrase"),
        "{}",
        none.message()
    );
    let wrong = who(protected, None, Some("nope")).await.unwrap_err();
    assert!(
        wrong.message().contains("passphrase is wrong"),
        "{}",
        wrong.message()
    );

    // No client certificate at all: the server turns `certuser` away.
    let without = who(
        certuser(config("localhost", SslMode::VerifyFull, root_only())),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(without.pg_code(), Some("28000"), "{without:?}");
}

#[tokio::test]
async fn the_connection_test_uses_the_same_settings() {
    if !available() {
        return;
    }
    let ok = test_connection_with(
        &config("localhost", SslMode::VerifyFull, root_only()),
        Some(DEV_PASSWORD),
        Extras::default(),
    )
    .await
    .unwrap();
    assert!(ok.server_version.starts_with("16"));
    let refused = test_connection_with(
        &config("localhost", SslMode::VerifyFull, None),
        Some(DEV_PASSWORD),
        Extras::default(),
    )
    .await
    .unwrap_err();
    assert!(
        refused.message().contains("doesn't trust"),
        "{}",
        refused.message()
    );
}

#[tokio::test]
async fn a_server_without_tls_is_explained_when_tls_is_required() {
    // The ordinary dev database has no TLS at all.
    let addr: SocketAddr = "127.0.0.1:54329".parse().unwrap();
    if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_err() {
        assert!(!db_required(), "the dev database is required");
        return;
    }
    let error = Session::open(
        ConnectionConfig {
            ssl_mode: SslMode::Require,
            ..dev_config()
        },
        Some(DEV_PASSWORD),
    )
    .await;
    let message = match error {
        Ok(_) => return, // a dev database that does offer TLS: nothing to explain
        Err(e) => e.message(),
    };
    assert!(message.contains("does not support TLS"), "{message}");
}
