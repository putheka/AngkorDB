//! The SSH tunnel against a real `sshd` (`npm run db:up` starts one: `ssh -p 2222 tunnel@localhost`,
//! password `tunnel`). The database is reached as the SSH server sees it: `postgres:5432` on the
//! compose network, a name this machine can't resolve, so a connection that works went through
//! the tunnel. See `dev/sshd/`.

mod common;

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use angkordb_lib::db::session::Session;
use angkordb_lib::db::ssh::{self, SshSetup, SshTunnel};
use angkordb_lib::error::AppError;
use angkordb_lib::models::connection::{SshAuth, SshConfig};
use common::{DEV_PASSWORD, db_required, dev_config};
use tempfile::TempDir;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn ssh_host() -> String {
    env_or("ANGKORDB_TEST_SSH_HOST", "localhost")
}

fn ssh_port() -> u16 {
    env_or("ANGKORDB_TEST_SSH_PORT", "2222").parse().unwrap()
}

/// The database as the SSH server sees it.
fn db_target() -> (String, u16) {
    (
        env_or("ANGKORDB_TEST_SSH_DB_HOST", "postgres"),
        env_or("ANGKORDB_TEST_SSH_DB_PORT", "5432").parse().unwrap(),
    )
}

/// `true` when the test can run; skipped (or failed, with `ANGKORDB_REQUIRE_DB=1`) otherwise.
fn available() -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{}", ssh_port()).parse().unwrap();
    if TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok() {
        return true;
    }
    assert!(
        !db_required(),
        "the test SSH server is not reachable on port {}: run `npm run db:up`",
        ssh_port()
    );
    eprintln!("SKIPPED: test SSH server not reachable. Run `npm run db:up`.");
    false
}

struct Keys {
    plain: PathBuf,
    rsa: PathBuf,
    protected: PathBuf,
    /// A key the server does not know.
    stranger: PathBuf,
    other_public: String,
    /// The public half of a key of a type the server doesn't have.
    foreign_type_public: String,
}

const PASSPHRASE: &str = "angkor-passphrase";

fn keygen(dir: &Path, name: &str, kind: &str, passphrase: &str) -> PathBuf {
    let path = dir.join(name);
    let mut command = Command::new("ssh-keygen");
    command.args([
        "-q",
        "-t",
        kind,
        "-N",
        passphrase,
        "-C",
        "angkordb-test",
        "-f",
    ]);
    command.arg(&path);
    match kind {
        "rsa" => {
            command.args(["-b", "2048"]);
        }
        // A key type the test server does not have (it has 256-bit ECDSA, Ed25519 and RSA).
        "ecdsa" => {
            command.args(["-b", "384"]);
        }
        _ => {}
    }
    assert!(command.status().expect("ssh-keygen").success());
    path
}

fn public_of(private: &Path) -> String {
    std::fs::read_to_string(format!("{}.pub", private.display())).unwrap()
}

/// Key pairs for this run, made once; their public halves go to the server's `authorized` file.
fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let dir = TempDir::new().unwrap().keep();
        let plain = keygen(&dir, "plain", "ed25519", "");
        let rsa = keygen(&dir, "rsa", "rsa", "");
        let protected = keygen(&dir, "protected", "ed25519", PASSPHRASE);
        let stranger = keygen(&dir, "stranger", "ed25519", "");
        let foreign = keygen(&dir, "foreign", "ecdsa", "");
        let authorized =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev/sshd/authorized/tunnel");
        std::fs::write(
            authorized,
            [&plain, &rsa, &protected]
                .iter()
                .map(|k| public_of(k))
                .collect::<String>(),
        )
        .unwrap();
        Keys {
            other_public: public_of(&stranger),
            foreign_type_public: public_of(&foreign),
            plain,
            rsa,
            protected,
            stranger,
        }
    })
}

fn config(auth: SshAuth) -> SshConfig {
    SshConfig {
        host: ssh_host(),
        port: ssh_port(),
        user: "tunnel".into(),
        auth,
        has_secret: false,
    }
}

fn key_auth(path: &Path) -> SshAuth {
    SshAuth::PrivateKey {
        path: path.display().to_string(),
    }
}

fn setup(secret: Option<&str>, known_hosts: &Path) -> SshSetup {
    SshSetup {
        secret: secret.map(str::to_owned),
        known_hosts: known_hosts.to_path_buf(),
        agent_socket: None,
    }
}

async fn open(ssh: &SshConfig, setup: &SshSetup) -> Result<SshTunnel, AppError> {
    let (host, port) = db_target();
    SshTunnel::open(ssh, setup, &host, port).await
}

/// A known_hosts file that already trusts the server.
async fn trusted(dir: &TempDir) -> PathBuf {
    let path = dir.path().join("known_hosts");
    let attempt = open(&config(SshAuth::Password), &setup(Some("tunnel"), &path)).await;
    match attempt {
        Err(AppError::SshHostKey(problem)) => ssh::trust(&problem, &path).unwrap(),
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("a new known_hosts file should not know the server"),
    }
    path
}

fn expect_err<T>(result: Result<T, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e,
    }
}

async fn port_closes(port: u16) -> bool {
    for _ in 0..80 {
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

fn dev_over_ssh(ssh: SshConfig) -> angkordb_lib::models::connection::ConnectionConfig {
    let (host, port) = db_target();
    let mut config = dev_config();
    config.host = host;
    config.port = port;
    config.ssh = Some(ssh);
    config
}

#[tokio::test]
async fn an_unknown_host_key_is_reported_with_its_fingerprint_and_trusting_it_opens_the_tunnel() {
    if !available() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let known = dir.path().join("known_hosts");
    let ssh = config(SshAuth::Password);

    let error = expect_err(open(&ssh, &setup(Some("tunnel"), &known)).await);
    assert_eq!(error.code(), "SSH_HOST_UNKNOWN");
    assert!(
        error.message().contains("can't be established"),
        "{}",
        error.message()
    );
    let problem = error.host_key().expect("the host key").clone();
    assert!(
        problem.fingerprint.starts_with("SHA256:"),
        "{}",
        problem.fingerprint
    );
    assert!(problem.key_type.starts_with("ssh-") || problem.key_type.starts_with("ecdsa-"));
    assert!(!problem.changed);
    assert_eq!(
        (problem.host.as_str(), problem.port),
        (ssh_host().as_str(), ssh_port())
    );
    // The error carries what the form shows, and nothing is recorded until the person says so.
    let payload = serde_json::to_value(&error).unwrap();
    assert_eq!(payload["detail"], problem.fingerprint);
    assert!(!known.exists());

    ssh::trust(&problem, &known).unwrap();
    let recorded = std::fs::read_to_string(&known).unwrap();
    assert!(
        recorded.contains(&format!("[{}]:{}", ssh_host(), ssh_port())),
        "{recorded}"
    );

    let tunnel = open(&ssh, &setup(Some("tunnel"), &known)).await.unwrap();
    assert!(tunnel.local_port() > 0);
}

#[tokio::test]
async fn a_session_reaches_the_database_through_the_tunnel_and_closing_frees_the_port() {
    if !available() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let known = trusted(&dir).await;
    let config = dev_over_ssh(config(SshAuth::Password));

    let first = Session::open_with_ssh(
        config,
        Some(DEV_PASSWORD),
        Some(setup(Some("tunnel"), &known)),
    )
    .await
    .unwrap();
    let port = first.tunnel_port().expect("a tunnel");
    let database: String = first
        .meta()
        .await
        .unwrap()
        .query_one("SELECT current_database()::text", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(database, "angkordb_dev");

    // Another database of the server goes through the same tunnel.
    let second = first.switch_database("postgres").await.unwrap();
    assert_eq!(second.tunnel_port(), Some(port));
    let other: String = second
        .meta()
        .await
        .unwrap()
        .query_one("SELECT current_database()::text", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(other, "postgres");

    // The tunnel stays while one of them uses it, and goes with the last.
    first.close().await;
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "closed too early"
    );
    second.close().await;
    drop((first, second));
    assert!(port_closes(port).await, "the local port stayed open");
}

#[tokio::test]
async fn a_wrong_or_missing_password_is_refused() {
    if !available() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let known = trusted(&dir).await;
    let ssh = config(SshAuth::Password);

    let wrong = expect_err(open(&ssh, &setup(Some("not-the-password"), &known)).await);
    assert_eq!(wrong.code(), "SSH");
    assert!(
        wrong.message().contains("refused the login"),
        "{}",
        wrong.message()
    );
    let missing = expect_err(open(&ssh, &setup(None, &known)).await);
    assert_eq!(missing.code(), "VALIDATION");
}

#[tokio::test]
async fn private_keys_log_in_with_and_without_a_passphrase() {
    if !available() {
        return;
    }
    let keys = keys();
    let dir = TempDir::new().unwrap();
    let known = trusted(&dir).await;

    for key in [&keys.plain, &keys.rsa] {
        open(&config(key_auth(key)), &setup(None, &known))
            .await
            .unwrap();
    }

    // Protected: it says so, a wrong passphrase is refused, the right one works.
    let protected = config(key_auth(&keys.protected));
    let none = expect_err(open(&protected, &setup(None, &known)).await);
    assert_eq!(none.code(), "VALIDATION");
    assert!(none.message().contains("passphrase"), "{}", none.message());
    let wrong = expect_err(open(&protected, &setup(Some("nope"), &known)).await);
    assert_eq!(wrong.code(), "VALIDATION");
    open(&protected, &setup(Some(PASSPHRASE), &known))
        .await
        .unwrap();

    // A key the server doesn't know, and one that isn't there.
    let stranger = expect_err(open(&config(key_auth(&keys.stranger)), &setup(None, &known)).await);
    assert_eq!(stranger.code(), "SSH");
    let missing = expect_err(
        open(
            &config(key_auth(Path::new("/nonexistent/id_ed25519"))),
            &setup(None, &known),
        )
        .await,
    );
    assert!(
        missing.message().contains("no key file"),
        "{}",
        missing.message()
    );
}

/// An `ssh-agent` of its own, stopped at the end.
struct Agent {
    socket: PathBuf,
    child: Child,
}

impl Agent {
    fn start() -> Self {
        let socket = std::env::temp_dir().join(format!("angkordb-agent-{}", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let child = Command::new("ssh-agent")
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(Stdio::null())
            .spawn()
            .expect("ssh-agent");
        for _ in 0..50 {
            if socket.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Self { socket, child }
    }

    fn add(&self, key: &Path) {
        let status = Command::new("ssh-add")
            .arg(key)
            .env("SSH_AUTH_SOCK", &self.socket)
            .stderr(Stdio::null())
            .status()
            .expect("ssh-add");
        assert!(status.success());
    }

    fn remove_all(&self) {
        Command::new("ssh-add")
            .arg("-D")
            .env("SSH_AUTH_SOCK", &self.socket)
            .stderr(Stdio::null())
            .status()
            .expect("ssh-add");
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

#[tokio::test]
async fn the_ssh_agent_logs_in_and_its_problems_are_explained() {
    if !available() {
        return;
    }
    let keys = keys();
    let dir = TempDir::new().unwrap();
    let known = trusted(&dir).await;
    let ssh = config(SshAuth::Agent);
    let agent = Agent::start();
    let with_agent = |known: &Path| SshSetup {
        agent_socket: Some(agent.socket.clone()),
        ..setup(None, known)
    };

    // Nothing in it.
    let empty = expect_err(open(&ssh, &with_agent(&known)).await);
    assert_eq!(empty.code(), "VALIDATION");
    assert!(empty.message().contains("no keys"), "{}", empty.message());

    // A key the server doesn't know.
    agent.add(&keys.stranger);
    let refused = expect_err(open(&ssh, &with_agent(&known)).await);
    assert_eq!(refused.code(), "SSH");

    // Its keys are tried in turn: the right one is found after the wrong one.
    agent.add(&keys.plain);
    open(&ssh, &with_agent(&known)).await.unwrap();
    agent.remove_all();
    agent.add(&keys.rsa);
    open(&ssh, &with_agent(&known)).await.unwrap();

    // No agent at all.
    let nowhere = SshSetup {
        agent_socket: Some(dir.path().join("no-such-agent")),
        ..setup(None, &known)
    };
    let none = expect_err(open(&ssh, &nowhere).await);
    assert_eq!(none.code(), "VALIDATION");
    assert!(
        none.message().contains("No ssh-agent"),
        "{}",
        none.message()
    );
}

#[tokio::test]
async fn a_changed_host_key_is_refused_and_cannot_be_trusted_from_here() {
    if !available() {
        return;
    }
    let keys = keys();
    let dir = TempDir::new().unwrap();
    let known = dir.path().join("known_hosts");
    // Another Ed25519 key recorded for the server's address.
    let mut fields = keys.other_public.split_whitespace();
    let (kind, blob) = (fields.next().unwrap(), fields.next().unwrap());
    let line = format!("[{}]:{} {kind} {blob}\n", ssh_host(), ssh_port());
    std::fs::write(&known, &line).unwrap();

    let error = expect_err(open(&config(SshAuth::Password), &setup(Some("tunnel"), &known)).await);
    assert_eq!(error.code(), "SSH_HOST_CHANGED");
    assert!(
        error.message().contains("has changed"),
        "{}",
        error.message()
    );
    let problem = error.host_key().unwrap();
    assert!(problem.changed);
    assert_eq!(problem.line, Some(1));
    assert!(ssh::trust(problem, &known).is_err());
    assert_eq!(
        std::fs::read_to_string(&known).unwrap(),
        line,
        "known_hosts was changed"
    );
}

#[tokio::test]
async fn a_host_key_of_another_type_than_the_default_is_honoured() {
    if !available() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let known = dir.path().join("known_hosts");
    // What `ssh` would have recorded: the server's ECDSA key only.
    let scan = Command::new("ssh-keyscan")
        .args(["-t", "ecdsa", "-p"])
        .arg(ssh_port().to_string())
        .arg(ssh_host())
        .stderr(Stdio::null())
        .output()
        .expect("ssh-keyscan");
    let recorded = String::from_utf8(scan.stdout).unwrap();
    assert!(recorded.contains("ecdsa-sha2-nistp256"), "{recorded}");
    std::fs::write(&known, recorded).unwrap();

    open(&config(SshAuth::Password), &setup(Some("tunnel"), &known))
        .await
        .map(|_| ())
        .unwrap_or_else(|e| panic!("asked about a key that is recorded: {e:?}"));
}

#[tokio::test]
async fn the_tunnel_opens_the_ssh_connection_again_after_it_dropped() {
    if !available() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let known = trusted(&dir).await;
    let tunnel = open(&config(SshAuth::Password), &setup(Some("tunnel"), &known))
        .await
        .unwrap();

    async fn select_one(port: u16) -> bool {
        let mut config = tokio_postgres::Config::new();
        config
            .host("127.0.0.1")
            .port(port)
            .user("angkor")
            .password(DEV_PASSWORD)
            .dbname("angkordb_dev");
        let Ok((client, connection)) = config.connect(tokio_postgres::NoTls).await else {
            return false;
        };
        tokio::spawn(connection);
        client.simple_query("SELECT 1").await.is_ok()
    }

    assert!(select_one(tunnel.local_port()).await);
    tunnel.drop_ssh_connection().await;
    assert!(
        select_one(tunnel.local_port()).await,
        "no new SSH connection after the drop"
    );
}

#[tokio::test]
async fn test_ssh_says_whether_the_database_can_be_reached() {
    if !available() {
        return;
    }
    let dir = TempDir::new().unwrap();
    let known = trusted(&dir).await;
    let ssh = config(SshAuth::Password);
    let secret = setup(Some("tunnel"), &known);
    let (host, port) = db_target();

    let good = ssh::test(&ssh, &secret, &host, port).await.unwrap();
    assert!(good.reaches_database, "{:?}", good.database_problem);
    assert!(good.fingerprint.starts_with("SHA256:"));

    let closed = ssh::test(&ssh, &secret, &host, 1).await.unwrap();
    assert!(!closed.reaches_database);
    assert!(
        closed
            .database_problem
            .unwrap()
            .contains(&format!("{host}:1"))
    );

    let unknown_host = expect_err(
        ssh::test(
            &config(SshAuth::Password),
            &setup(Some("tunnel"), &dir.path().join("empty")),
            &host,
            port,
        )
        .await,
    );
    assert_eq!(unknown_host.code(), "SSH_HOST_UNKNOWN");
}

#[tokio::test]
async fn a_recorded_key_of_another_type_is_not_a_new_host() {
    if !available() {
        return;
    }
    // known_hosts has a key for this server, but of a type the server doesn't have, so the key
    // it presents is of another type. That must not look like an unknown host to trust.
    let dir = TempDir::new().unwrap();
    let known = dir.path().join("known_hosts");
    let mut fields = keys().foreign_type_public.split_whitespace();
    let (kind, blob) = (fields.next().unwrap(), fields.next().unwrap());
    assert_eq!(kind, "ecdsa-sha2-nistp384");
    let line = format!("[{}]:{} {kind} {blob}\n", ssh_host(), ssh_port());
    std::fs::write(&known, &line).unwrap();

    let error = expect_err(open(&config(SshAuth::Password), &setup(Some("tunnel"), &known)).await);
    assert_eq!(error.code(), "SSH_HOST_CHANGED", "{error:?}");
    let problem = error.host_key().unwrap();
    assert_eq!(problem.line, Some(1));
    assert!(ssh::trust(problem, &known).is_err());
    assert_eq!(std::fs::read_to_string(&known).unwrap(), line);
}
