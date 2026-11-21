//! Reaching the database through an SSH server (ANG-43): a local port that forwards to
//! `db_host:db_port` as the SSH server sees it, like `ssh -L`.
//!
//! - The server's host key is checked against `~/.ssh/known_hosts`. A key that is not there yet
//!   is reported (with its fingerprint) so the person can decide to trust it; a key that differs
//!   from the recorded one is refused.
//! - Login by password, by private key file (with its passphrase) or by the ssh-agent.
//! - The tunnel lives as long as the [`SshTunnel`]: dropping it closes the local port and the
//!   SSH connection. If the SSH connection drops, the next database connection opens it again.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::known_hosts::{
    check_known_hosts_path, known_host_keys_path, learn_known_hosts_path,
};
use russh::keys::ssh_key::{Algorithm, HashAlg, PublicKey};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key};
use russh::{Preferred, keys};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};

use crate::error::{AppError, AppResult};
use crate::models::connection::{SshAuth, SshConfig, SshJump};

/// How long to wait for the SSH server to answer and log us in.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE: Duration = Duration::from_secs(30);

/// What opening a tunnel needs besides the saved settings.
#[derive(Clone)]
pub struct SshSetup {
    /// The SSH password, or the key's passphrase.
    pub secret: Option<String>,
    /// The same for the jump host, if there is one.
    pub jump_secret: Option<String>,
    /// Where host keys are recorded: `~/.ssh/known_hosts`.
    pub known_hosts: PathBuf,
    /// The ssh-agent socket; `None` reads `SSH_AUTH_SOCK`.
    pub agent_socket: Option<PathBuf>,
}

impl SshSetup {
    pub fn new(secret: Option<String>) -> Self {
        Self {
            secret,
            jump_secret: None,
            known_hosts: default_known_hosts(),
            agent_socket: None,
        }
    }
}

// Never print the secret, even in debug logs.
impl std::fmt::Debug for SshSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshSetup")
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field(
                "jump_secret",
                &self.jump_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("known_hosts", &self.known_hosts)
            .finish_non_exhaustive()
    }
}

/// `~/.ssh/known_hosts`.
pub fn default_known_hosts() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh")
        .join("known_hosts")
}

/// A host key that is not in known_hosts yet, or does not match the one that is.
#[derive(Debug, Clone)]
pub struct HostKeyProblem {
    pub host: String,
    pub port: u16,
    /// `SHA256:…`, as `ssh` prints it.
    pub fingerprint: String,
    /// `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, …
    pub key_type: String,
    /// A different key is recorded for this host: it may have been replaced, or someone may be
    /// in between. Never trusted from here.
    pub changed: bool,
    /// The known_hosts line that has the other key.
    pub line: Option<usize>,
    pub key: Arc<PublicKey>,
}

impl HostKeyProblem {
    pub fn message(&self) -> String {
        if self.changed {
            let line = self
                .line
                .map(|l| format!(" (line {l})"))
                .unwrap_or_default();
            format!(
                "The SSH host key of {}:{} has changed{line}. It is not the one in known_hosts \
                 (the key on file is another one, or of another type): the server may have been \
                 reinstalled, or someone may be intercepting the connection. Connection refused.",
                self.host, self.port
            )
        } else {
            format!(
                "The authenticity of the SSH host {}:{} can't be established: it is not in \
                 known_hosts yet.",
                self.host, self.port
            )
        }
    }

    /// `ssh-ed25519 · host:port`
    pub fn summary(&self) -> String {
        format!("{} · {}:{}", self.key_type, self.host, self.port)
    }
}

fn describe(key: &PublicKey) -> (String, String) {
    (
        key.fingerprint(HashAlg::Sha256).to_string(),
        key.algorithm().to_string(),
    )
}

/// Record the key as trusted, as `ssh` does when you answer "yes".
pub fn trust(problem: &HostKeyProblem, known_hosts: &Path) -> AppResult<()> {
    if problem.changed {
        return Err(AppError::Validation(
            "A changed host key is not trusted from here. Check with whoever runs the server, \
             then remove the old line from known_hosts."
                .into(),
        ));
    }
    learn_known_hosts_path(&problem.host, problem.port, &problem.key, known_hosts)
        .map_err(|e| AppError::Ssh(format!("could not write {}: {e}", known_hosts.display())))
}

// ---- the SSH client --------------------------------------------------------------------------

/// What the host key check decided, handed from the handler back to whoever is connecting.
#[derive(Default)]
struct Verdict {
    problem: Option<HostKeyProblem>,
    other: Option<String>,
}

struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    verdict: Arc<StdMutex<Verdict>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Certificates are never advertised, so a server that sends one is not one we asked for.
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        let mut verdict = self.verdict.lock().unwrap_or_else(|e| e.into_inner());
        let problem = |changed, line| {
            let (fingerprint, key_type) = describe(key);
            HostKeyProblem {
                host: self.host.clone(),
                port: self.port,
                fingerprint,
                key_type,
                changed,
                line,
                key: Arc::new(key.clone()),
            }
        };
        match check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                // "Not found" also covers a host whose recorded key is of another type than the
                // one presented. That is not a new host: someone else's key may be on offer,
                // so it is refused like a changed key, never offered for trust.
                let recorded = known_host_keys_path(&self.host, self.port, &self.known_hosts)
                    .unwrap_or_default();
                verdict.problem = Some(match recorded.first() {
                    Some((line, _)) => problem(true, Some(*line)),
                    None => problem(false, None),
                });
                Ok(false)
            }
            Err(keys::Error::KeyChanged { line }) => {
                verdict.problem = Some(problem(true, Some(line)));
                Ok(false)
            }
            Err(e) => {
                verdict.other = Some(format!(
                    "could not read {}: {e}",
                    self.known_hosts.display()
                ));
                Ok(false)
            }
        }
    }
}

fn ssh_error(what: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("{what}: {e}"))
}

/// Key types to offer first: the ones already recorded for this host, so that a server whose
/// recorded key is ECDSA is asked for that one and not for its Ed25519 key.
fn preferred_for(host: &str, port: u16, known_hosts: &Path) -> Preferred {
    let mut preferred = Preferred::default();
    if let Ok(recorded) = known_host_keys_path(host, port, known_hosts) {
        let mut keys: Vec<Algorithm> = Vec::new();
        for (_, key) in recorded {
            if !keys.contains(&key.algorithm()) {
                keys.push(key.algorithm());
            }
        }
        for algorithm in preferred.key.iter() {
            if !keys.contains(algorithm) {
                keys.push(algorithm.clone());
            }
        }
        preferred.key = keys.into();
    }
    preferred
}

pub(crate) fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest),
        None => PathBuf::from(path),
    }
}

/// One server of the chain: where it is, who to log in as, and with what.
struct Hop<'a> {
    host: &'a str,
    port: u16,
    user: &'a str,
    auth: &'a SshAuth,
    secret: Option<&'a str>,
}

impl<'a> Hop<'a> {
    fn of(ssh: &'a SshConfig, secret: Option<&'a str>) -> Self {
        Self {
            host: &ssh.host,
            port: ssh.port,
            user: &ssh.user,
            auth: &ssh.auth,
            secret,
        }
    }

    fn of_jump(jump: &'a SshJump, secret: Option<&'a str>) -> Self {
        Self {
            host: &jump.host,
            port: jump.port,
            user: &jump.user,
            auth: &jump.auth,
            secret,
        }
    }
}

/// A login to the SSH server, and the jump host it goes through, kept open as long as it is
/// used (the jump host's connection carries the other one).
struct Connection {
    handle: Handle<Client>,
    jump: Option<Handle<Client>>,
}

impl Connection {
    fn is_closed(&self) -> bool {
        self.handle.is_closed() || self.jump.as_ref().is_some_and(Handle::is_closed)
    }
}

/// Connect to the SSH server (through the jump host, if there is one), check the host keys and
/// log in.
async fn connect(ssh: &SshConfig, setup: &SshSetup) -> AppResult<Connection> {
    let jump = match &ssh.jump {
        None => None,
        Some(jump) => {
            let hop = Hop::of_jump(jump, setup.jump_secret.as_deref());
            let handle = open_hop(&hop, setup, None).await.map_err(|e| match e {
                AppError::Ssh(m) => AppError::Ssh(format!("jump host {}: {m}", jump.host)),
                AppError::Validation(m) => {
                    AppError::Validation(format!("Jump host {}: {m}", jump.host))
                }
                AppError::Timeout(m) => AppError::Timeout(format!("the jump host: {m}")),
                other => other,
            })?;
            Some(handle)
        }
    };
    let hop = Hop::of(ssh, setup.secret.as_deref());
    let handle = open_hop(&hop, setup, jump.as_ref()).await?;
    Ok(Connection { handle, jump })
}

/// Connect to one server, straight or through `via` (a channel of the server before it), check
/// its host key and log in.
async fn open_hop(
    hop: &Hop<'_>,
    setup: &SshSetup,
    via: Option<&Handle<Client>>,
) -> AppResult<Handle<Client>> {
    let verdict = Arc::new(StdMutex::new(Verdict::default()));
    let handler = Client {
        host: hop.host.to_owned(),
        port: hop.port,
        known_hosts: setup.known_hosts.clone(),
        verdict: Arc::clone(&verdict),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE),
        keepalive_max: 3,
        preferred: preferred_for(hop.host, hop.port, &setup.known_hosts),
        ..client::Config::default()
    });

    let result = match via {
        None => {
            let connecting = client::connect(config, (hop.host, hop.port), handler);
            tokio::time::timeout(CONNECT_TIMEOUT, connecting).await
        }
        Some(jump) => {
            // The next server is reached by asking the one before it to open a connection to it.
            let opening =
                jump.channel_open_direct_tcpip(hop.host, u32::from(hop.port), "127.0.0.1", 0);
            let channel = match tokio::time::timeout(CONNECT_TIMEOUT, opening).await {
                Ok(Ok(channel)) => channel,
                Ok(Err(e)) => {
                    return Err(ssh_error(
                        &format!("the jump host could not reach {}:{}", hop.host, hop.port),
                        e,
                    ));
                }
                Err(_) => {
                    return Err(AppError::Timeout(format!(
                        "the jump host reaching {}:{}",
                        hop.host, hop.port
                    )));
                }
            };
            let connecting = client::connect_stream(config, channel.into_stream(), handler);
            tokio::time::timeout(CONNECT_TIMEOUT, connecting).await
        }
    };
    // Whatever went wrong, a host key the handler turned down is the real reason.
    {
        let mut verdict = verdict.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(problem) = verdict.problem.take() {
            return Err(AppError::SshHostKey(problem));
        }
        if let Some(other) = verdict.other.take() {
            return Err(AppError::Ssh(other));
        }
    }
    let mut handle = match result {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            return Err(ssh_error(
                &format!("could not connect to {}:{}", hop.host, hop.port),
                e,
            ));
        }
        Err(_) => {
            return Err(AppError::Timeout(format!(
                "connecting to the SSH server {}:{}",
                hop.host, hop.port
            )));
        }
    };

    tokio::time::timeout(CONNECT_TIMEOUT, authenticate(&mut handle, hop, setup))
        .await
        .map_err(|_| AppError::Timeout("logging in to the SSH server".into()))??;
    Ok(handle)
}

fn refused(ssh: &Hop<'_>, how: &str) -> AppError {
    AppError::Ssh(format!(
        "the SSH server {}:{} refused the login of {} ({how})",
        ssh.host, ssh.port, ssh.user
    ))
}

async fn authenticate(
    handle: &mut Handle<Client>,
    ssh: &Hop<'_>,
    setup: &SshSetup,
) -> AppResult<()> {
    match &ssh.auth {
        SshAuth::Password => {
            let password = ssh
                .secret
                .ok_or_else(|| AppError::Validation("Enter the SSH password.".into()))?;
            let result = handle
                .authenticate_password(ssh.user.to_owned(), password)
                .await
                .map_err(|e| ssh_error("login failed", e))?;
            if !result.success() {
                return Err(refused(ssh, "password"));
            }
        }
        SshAuth::PrivateKey { path } => {
            let file = expand_home(path);
            let key = load_secret_key(&file, ssh.secret.filter(|s| !s.is_empty())).map_err(
                |e| match e {
                    keys::Error::KeyIsEncrypted => AppError::Validation(format!(
                        "The key {} is protected by a passphrase: enter it.",
                        file.display()
                    )),
                    keys::Error::IO(io) if io.kind() == std::io::ErrorKind::NotFound => {
                        AppError::Validation(format!("There is no key file at {}.", file.display()))
                    }
                    other => AppError::Validation(format!(
                        "Can't use the key {} ({other}). A wrong passphrase looks like this too.",
                        file.display()
                    )),
                },
            )?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| ssh_error("login failed", e))?
                .flatten();
            let result = handle
                .authenticate_publickey(
                    ssh.user.to_owned(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|e| ssh_error("login failed", e))?;
            if !result.success() {
                return Err(refused(ssh, "key"));
            }
        }
        SshAuth::Agent => authenticate_with_agent(handle, ssh, setup).await?,
    }
    Ok(())
}

async fn authenticate_with_agent(
    handle: &mut Handle<Client>,
    ssh: &Hop<'_>,
    setup: &SshSetup,
) -> AppResult<()> {
    let no_agent = |e: &dyn std::fmt::Display| {
        AppError::Validation(format!(
            "No ssh-agent to ask ({e}). Start one and add your key with ssh-add."
        ))
    };
    let mut agent = match &setup.agent_socket {
        Some(socket) => AgentClient::connect_uds(socket)
            .await
            .map(AgentClient::dynamic),
        None => AgentClient::connect_env().await.map(AgentClient::dynamic),
    }
    .map_err(|e| no_agent(&e))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| ssh_error("could not read the keys of the ssh-agent", e))?;
    if identities.is_empty() {
        return Err(AppError::Validation(
            "The ssh-agent holds no keys. Add one with ssh-add.".into(),
        ));
    }
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| ssh_error("login failed", e))?
        .flatten();
    for identity in identities {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let result = handle
            .authenticate_publickey_with(ssh.user.to_owned(), key, hash, &mut agent)
            .await
            .map_err(|e| ssh_error("login failed", e))?;
        if result.success() {
            return Ok(());
        }
    }
    Err(refused(ssh, "none of the ssh-agent's keys was accepted"))
}

// ---- the tunnel ------------------------------------------------------------------------------

/// The SSH connection behind a tunnel, opened again when it has dropped.
struct Link {
    ssh: SshConfig,
    setup: SshSetup,
    handle: Mutex<Option<Connection>>,
}

impl Link {
    async fn channel(&self, host: &str, port: u16) -> AppResult<russh::Channel<client::Msg>> {
        let mut guard = self.handle.lock().await;
        for attempt in 0..2 {
            if guard.as_ref().is_none_or(Connection::is_closed) {
                *guard = Some(connect(&self.ssh, &self.setup).await?);
            }
            let Some(connection) = guard.as_ref() else {
                continue;
            };
            match connection
                .handle
                .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
                .await
            {
                Ok(channel) => return Ok(channel),
                // Refused by the server (nothing listens there): opening it again won't help.
                Err(russh::Error::ChannelOpenFailure(reason)) => {
                    return Err(AppError::Ssh(format!(
                        "the SSH server could not open {host}:{port} ({reason:?})"
                    )));
                }
                Err(e) if attempt == 1 => return Err(ssh_error("tunnel failed", e)),
                // The connection went away: start over once.
                Err(_) => *guard = None,
            }
        }
        Err(AppError::Ssh("tunnel failed".into()))
    }
}

/// A local port that leads to the database through the SSH server. Dropping it closes the port
/// and the SSH connection.
pub struct SshTunnel {
    local_port: u16,
    task: JoinHandle<()>,
    link: Arc<Link>,
}

impl SshTunnel {
    /// Log in to the SSH server, then listen on a free local port and forward every connection
    /// to `db_host:db_port`, as seen from the SSH server.
    pub async fn open(
        ssh: &SshConfig,
        setup: &SshSetup,
        db_host: &str,
        db_port: u16,
    ) -> AppResult<Self> {
        let handle = connect(ssh, setup).await?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| ssh_error("could not open a local port", e))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| ssh_error("could not open a local port", e))?
            .port();
        let link = Arc::new(Link {
            ssh: ssh.clone(),
            setup: setup.clone(),
            handle: Mutex::new(Some(handle)),
        });
        let accepting = Arc::clone(&link);
        let target = (db_host.to_owned(), db_port);
        let task = tokio::spawn(async move {
            // Each forwarded connection is a task of this set: they end with the tunnel.
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        let (link, target) = (Arc::clone(&accepting), target.clone());
                        connections.spawn(forward(link, target, socket));
                    }
                    // Reap the ones that are done.
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self {
            local_port,
            task,
            link,
        })
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// Cut the SSH connection, as a network drop would. The next database connection opens it
    /// again. For tests.
    #[doc(hidden)]
    pub async fn drop_ssh_connection(&self) {
        let guard = self.link.handle.lock().await;
        if let Some(connection) = guard.as_ref() {
            let _ = connection
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            for _ in 0..40 {
                if connection.handle.is_closed() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn forward(link: Arc<Link>, target: (String, u16), mut socket: tokio::net::TcpStream) {
    let Ok(channel) = link.channel(&target.0, target.1).await else {
        return; // the socket closes: the database client sees a refused connection
    };
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
}

/// What "Test SSH" reports.
#[derive(Debug, Clone)]
pub struct SshTestReport {
    pub fingerprint: String,
    pub key_type: String,
    /// The SSH server could open a connection to the database's host and port.
    pub reaches_database: bool,
    /// Why not, when it can't.
    pub database_problem: Option<String>,
}

/// Log in to the SSH server and ask it to open a connection to `db_host:db_port`; nothing else.
pub async fn test(
    ssh: &SshConfig,
    setup: &SshSetup,
    db_host: &str,
    db_port: u16,
) -> AppResult<SshTestReport> {
    let connection = connect(ssh, setup).await?;
    // The host key was accepted, so it is the recorded one.
    let key = known_host_keys_path(&ssh.host, ssh.port, &setup.known_hosts)
        .ok()
        .and_then(|keys| keys.into_iter().next())
        .map(|(_, key)| describe(&key));
    let (fingerprint, key_type) = key.unwrap_or_default();

    let opened = connection
        .handle
        .channel_open_direct_tcpip(db_host, u32::from(db_port), "127.0.0.1", 0)
        .await;
    let (reaches_database, database_problem) = match opened {
        Ok(channel) => {
            let _ = channel.close().await;
            (true, None)
        }
        Err(e) => (
            false,
            Some(format!(
                "the SSH server could not open {db_host}:{db_port} ({e})"
            )),
        ),
    };
    let _ = connection
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    if let Some(jump) = &connection.jump {
        let _ = jump
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(SshTestReport {
        fingerprint,
        key_type,
        reaches_database,
        database_problem,
    })
}
