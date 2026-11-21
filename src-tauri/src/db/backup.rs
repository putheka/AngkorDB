//! `pg_dump` and `pg_restore` as the app's backup and restore (ANG-47).
//!
//! The programs are the ones on this Mac (Homebrew, Postgres.app, a folder the person names).
//! They are started with the connection in environment variables, so the password never shows
//! in a process list or a command line; behind an SSH tunnel they connect to the tunnel's port
//! while still checking the database's own name. A backup is written under a `.part` name and
//! only given its real name when it is complete.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_postgres::Client;

use crate::db::rows::quote_ident;
use crate::error::{AppError, AppResult};
use crate::models::backup::{
    BackupFormat, BackupRequest, PgTools, RestoreRequest, RestoreTarget, ToolState, ToolStatus,
};
use crate::models::connection::{ConnectionConfig, SslMode};

/// Lines of output kept.
const LOG_LINES: usize = 500;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

// ---- finding the programs --------------------------------------------------------------------

/// `pg_dump (PostgreSQL) 17.10 (Homebrew)` → (`17.10`, 17)
fn parse_version(output: &str) -> Option<(String, u32)> {
    let after = output.split(')').nth(1)?.trim();
    let token = after.split_whitespace().next()?;
    let major: String = token.chars().take_while(char::is_ascii_digit).collect();
    Some((token.to_owned(), major.parse().ok()?))
}

fn is_program(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn subfolders(parent: &str, prefix: &str, then: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .map(|e| e.path().join(then))
        .collect();
    found.sort();
    found
}

/// Where the programs usually are, most specific first.
fn candidate_dirs(chosen: Option<&str>) -> Vec<(PathBuf, &'static str)> {
    let mut dirs: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(chosen) = chosen.map(str::trim).filter(|c| !c.is_empty()) {
        let path = PathBuf::from(chosen);
        let folder = if path.is_dir() {
            path
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        };
        dirs.push((folder, "Chosen folder"));
    }
    for dir in subfolders("/opt/homebrew/opt", "postgresql", "bin") {
        dirs.push((dir, "Homebrew"));
    }
    dirs.push((PathBuf::from("/opt/homebrew/bin"), "Homebrew"));
    for dir in subfolders("/usr/local/opt", "postgresql", "bin") {
        dirs.push((dir, "Homebrew"));
    }
    for dir in subfolders("/Applications/Postgres.app/Contents/Versions", "", "bin") {
        dirs.push((dir, "Postgres.app"));
    }
    for dir in subfolders("/Library/PostgreSQL", "", "bin") {
        dirs.push((dir, "EDB installer"));
    }
    dirs.push((PathBuf::from("/usr/local/bin"), "/usr/local/bin"));
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            dirs.push((dir, "PATH"));
        }
    }
    dirs
}

async fn version_of(dir: &Path) -> Option<(String, u32)> {
    let run = Command::new(dir.join("pg_dump")).arg("--version").output();
    let output = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .ok()?
        .ok()?;
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// The PostgreSQL programs on this Mac, the newest first. `chosen` is a folder the person
/// named; it is tried first. A folder needs `pg_dump` and `pg_restore` both.
pub async fn detect(chosen: Option<&str>) -> Vec<PgTools> {
    let mut found: Vec<PgTools> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for (dir, source) in candidate_dirs(chosen) {
        let (dump, restore) = (dir.join("pg_dump"), dir.join("pg_restore"));
        if !is_program(&dump) || !is_program(&restore) {
            continue;
        }
        // The same program is reached by several paths (a symlink in /opt/homebrew/bin).
        let real = std::fs::canonicalize(&dump).unwrap_or_else(|_| dump.clone());
        if seen.contains(&real) {
            continue;
        }
        let Some((version, major)) = version_of(&dir).await else {
            continue;
        };
        seen.push(real);
        found.push(PgTools {
            dir: dir.display().to_string(),
            version,
            major,
            source: source.to_owned(),
        });
    }
    // Stable: for the same version the earlier (more specific) place stays first.
    found.sort_by_key(|t| std::cmp::Reverse(t.major));
    found
}

/// `16.4` → 16
pub fn major_of(server_version: &str) -> u32 {
    server_version
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

/// The programs to use for a server: the one asked for, or the closest version that is not older
/// than the server (an older `pg_dump` refuses a newer server).
pub fn pick<'a>(
    tools: &'a [PgTools],
    server_major: u32,
    chosen: Option<&str>,
) -> AppResult<&'a PgTools> {
    let usable = |t: &&PgTools| t.major >= server_major;
    if let Some(dir) = chosen.map(str::trim).filter(|c| !c.is_empty()) {
        let wanted = tools
            .iter()
            .find(|t| t.dir == dir || Path::new(dir).starts_with(&t.dir));
        return match wanted {
            Some(t) if usable(&t) => Ok(t),
            Some(t) => Err(invalid(format!(
                "pg_dump {} in {} is older than the server (PostgreSQL {server_major}): a backup would be refused. Choose a newer one.",
                t.version, t.dir
            ))),
            None => Err(invalid(format!(
                "There are no pg_dump and pg_restore in {dir}."
            ))),
        };
    }
    if tools.is_empty() {
        return Err(invalid(
            "pg_dump and pg_restore were not found. Install PostgreSQL (brew install postgresql@17) or choose the folder they are in.",
        ));
    }
    // The closest to the server that is not older: a newer program than the server is fine, but
    // the nearer the version the fewer surprises (`tools` is newest first).
    tools.iter().rev().find(usable).ok_or_else(|| {
        invalid(format!(
            "The newest pg_dump here is {} but the server is PostgreSQL {server_major}: it is too old to back it up. Install a newer one (brew install postgresql@{server_major}).",
            tools[0].version
        ))
    })
}

// ---- the connection --------------------------------------------------------------------------

/// Where the programs connect, and as whom.
pub struct Endpoint {
    host: String,
    /// Behind an SSH tunnel: the address to dial (the host name is then only for TLS).
    hostaddr: Option<String>,
    port: u16,
    user: String,
    pub database: String,
    password: Option<String>,
    ssl_mode: &'static str,
    root_cert: Option<String>,
    client_cert: Option<String>,
    client_key: Option<String>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("database", &self.database)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

fn check_database(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(invalid("Which database?"));
    }
    // `-d` reads a name with `=` in it, or a URL, as a connection string.
    if name.contains('=') || name.starts_with("postgres://") || name.starts_with("postgresql://") {
        return Err(invalid(
            "The programs can't be given a database name that looks like a connection string.",
        ));
    }
    if name.contains(['\0', '\n', '\r']) {
        return Err(invalid("The database name has a line break in it."));
    }
    Ok(())
}

impl Endpoint {
    /// The connection's settings, for `database` (or the one it names), with its password and
    /// the port of its SSH tunnel if it has one.
    pub fn of(
        config: &ConnectionConfig,
        database: Option<&str>,
        password: Option<String>,
        tunnel_port: Option<u16>,
    ) -> AppResult<Self> {
        let database = database.unwrap_or(&config.database).to_owned();
        check_database(&database)?;
        let files = config.ssl_files.as_ref();
        if files.is_some_and(|f| f.client_key.is_some() && f.has_key_secret) {
            return Err(invalid(
                "The client key of this connection is protected by a passphrase, and pg_dump can't be given one. Use a key without a passphrase for backups.",
            ));
        }
        Ok(Self {
            host: config.host.clone(),
            hostaddr: tunnel_port.map(|_| "127.0.0.1".to_owned()),
            port: tunnel_port.unwrap_or(config.port),
            user: config.user.clone(),
            database,
            password,
            ssl_mode: match config.ssl_mode {
                SslMode::Disable => "disable",
                SslMode::Prefer => "prefer",
                SslMode::Require => "require",
                SslMode::VerifyCa => "verify-ca",
                SslMode::VerifyFull => "verify-full",
            },
            root_cert: files.and_then(|f| f.root_cert.clone()),
            client_cert: files.and_then(|f| f.client_cert.clone()),
            client_key: files.and_then(|f| f.client_key.clone()),
        })
    }

    /// The same connection to another database.
    pub fn with_database(mut self, database: &str) -> AppResult<Self> {
        check_database(database)?;
        database.clone_into(&mut self.database);
        Ok(self)
    }

    /// The connection as environment variables: nothing secret goes on a command line.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("PGHOST".to_owned(), self.host.clone()),
            ("PGPORT".to_owned(), self.port.to_string()),
            ("PGUSER".to_owned(), self.user.clone()),
            ("PGSSLMODE".to_owned(), self.ssl_mode.to_owned()),
            ("PGCONNECT_TIMEOUT".to_owned(), "10".to_owned()),
            ("PGAPPNAME".to_owned(), "AngkorDB".to_owned()),
        ];
        let mut optional = |name: &str, value: &Option<String>| {
            if let Some(value) = value {
                env.push((name.to_owned(), value.clone()));
            }
        };
        optional("PGHOSTADDR", &self.hostaddr);
        optional("PGPASSWORD", &self.password);
        optional("PGSSLROOTCERT", &self.root_cert);
        optional("PGSSLCERT", &self.client_cert);
        optional("PGSSLKEY", &self.client_key);
        env
    }
}

// ---- the command lines -----------------------------------------------------------------------

fn pattern(text: &str) -> AppResult<&str> {
    let text = text.trim();
    if text.is_empty()
        || text.starts_with('-')
        || text.len() > 200
        || text.contains(['\0', '\n', '\r'])
    {
        return Err(invalid(format!(
            "\"{text}\" is not a table name or pattern."
        )));
    }
    Ok(text)
}

/// The arguments of `pg_dump` for the request, writing to `output`.
pub fn dump_args(request: &BackupRequest, database: &str, output: &Path) -> AppResult<Vec<String>> {
    if request.schema_only && request.data_only {
        return Err(invalid(
            "Choose either the schema only or the data only, not both.",
        ));
    }
    let mut args: Vec<String> = vec!["--verbose".into(), "--no-password".into()];
    args.push(format!("--dbname={database}"));
    args.push("--format".into());
    args.push(
        match request.format {
            BackupFormat::Custom => "custom",
            BackupFormat::Plain => "plain",
            BackupFormat::Directory => "directory",
            BackupFormat::Tar => "tar",
        }
        .into(),
    );
    args.push("--file".into());
    args.push(output.display().to_string());
    if let Some(level) = request.compression {
        if level > 9 {
            return Err(invalid("The compression level is 0 to 9."));
        }
        if matches!(
            request.format,
            BackupFormat::Custom | BackupFormat::Directory
        ) {
            args.push(format!("--compress={level}"));
        }
    }
    if request.schema_only {
        args.push("--schema-only".into());
    }
    if request.data_only {
        args.push("--data-only".into());
    }
    if request.no_owner {
        args.push("--no-owner".into());
    }
    for table in &request.include_tables {
        args.push(format!("--table={}", pattern(table)?));
    }
    for table in &request.exclude_tables {
        args.push(format!("--exclude-table={}", pattern(table)?));
    }
    Ok(args)
}

/// What a backup file is, and so which program restores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupKind {
    /// A custom, directory or tar archive: `pg_restore`.
    Archive,
    /// A SQL script: `psql`.
    Script,
}

pub fn kind_of(path: &Path) -> AppResult<BackupKind> {
    if path.is_dir() {
        return if path.join("toc.dat").is_file() {
            Ok(BackupKind::Archive)
        } else {
            Err(invalid(format!(
                "{} is a folder, but not a pg_dump directory backup (it has no toc.dat).",
                path.display()
            )))
        };
    }
    let mut head = [0u8; 512];
    let n = {
        use std::io::Read;
        std::fs::File::open(path)
            .and_then(|mut f| f.read(&mut head))
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    invalid(format!("There is no backup at {}.", path.display()))
                } else {
                    invalid(format!("Can't read {}: {e}.", path.display()))
                }
            })?
    };
    if head[..n].starts_with(b"PGDMP") || (n > 262 && &head[257..262] == b"ustar") {
        Ok(BackupKind::Archive)
    } else {
        Ok(BackupKind::Script)
    }
}

fn is_custom(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 5];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok()
        && &head == b"PGDMP"
}

/// The arguments of `pg_restore` (an archive) or `psql` (a script) for the request.
pub fn restore_args(
    request: &RestoreRequest,
    kind: BackupKind,
    database: &str,
    path: &Path,
) -> AppResult<Vec<String>> {
    match kind {
        BackupKind::Script => {
            if request.clean {
                return Err(invalid(
                    "A SQL script is run as it is: \"drop first\" only works for custom, directory and tar backups.",
                ));
            }
            // The script is not given to psql as a file: it is fed through its input behind
            // `\restrict` (see `ScriptFeed`), so that nothing in it can run a psql command.
            let _ = path;
            Ok(vec![
                "--no-password".into(),
                "--no-psqlrc".into(),
                format!("--dbname={database}"),
                "--file=-".into(),
            ])
        }
        BackupKind::Archive => {
            let mut args: Vec<String> = vec![
                "--verbose".into(),
                "--no-password".into(),
                format!("--dbname={database}"),
            ];
            if request.clean {
                args.push("--clean".into());
                args.push("--if-exists".into());
            }
            if request.no_owner {
                args.push("--no-owner".into());
            }
            // Restoring in parallel needs an archive that can be read out of order: a tar can't.
            let tar = path.is_file() && !is_custom(path);
            let jobs = request.jobs.clamp(1, 16);
            if jobs > 1 && !tar {
                args.push(format!("--jobs={jobs}"));
            }
            args.push(path.display().to_string());
            Ok(args)
        }
    }
}

// ---- running a program -----------------------------------------------------------------------

/// A running (or finished) backup or restore.
pub struct ToolJob {
    status: StdMutex<ToolStatus>,
    cancel: AtomicBool,
    /// The program's complaints, kept apart from the log (which is cut to its last lines).
    problems: StdMutex<Vec<String>>,
    /// The partly written file or folder of a backup, whose size is the progress.
    growing: StdMutex<Option<PathBuf>>,
}

fn size_of(path: &Path) -> u64 {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => std::fs::read_dir(path)
            .map(|d| d.flatten().map(|e| size_of(&e.path())).sum())
            .unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

impl ToolJob {
    pub fn new() -> Self {
        Self {
            status: StdMutex::new(ToolStatus {
                state: ToolState::Running,
                log: Vec::new(),
                lines: 0.0,
                bytes: 0.0,
                command: String::new(),
                output: None,
                error: None,
            }),
            cancel: AtomicBool::new(false),
            problems: StdMutex::new(Vec::new()),
            growing: StdMutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ToolStatus> {
        self.status.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> ToolStatus {
        let mut status = self.lock().clone();
        if let Some(path) = self
            .growing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            status.bytes = size_of(path) as f64;
        }
        status
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn line(&self, text: String) {
        // A parallel restore prints where an error happened as lines of their own, which the
        // workers' output can garble; they say nothing about what went wrong.
        let context = text.contains("while PROCESSING TOC") || text.contains("from TOC entry");
        let complaint = !context
            && (text.starts_with("pg_restore: error:")
            || text.starts_with("pg_dump: error:")
            || text.starts_with("Command was:")
            || text.contains("ERROR:")
            || text.contains("FATAL:")
            // psql: "psql:<stdin>:3: error: backslash commands are restricted…"
            || (text.starts_with("psql:") && text.contains("error:")));
        if complaint {
            let mut problems = self.problems.lock().unwrap_or_else(|e| e.into_inner());
            if problems.len() < 100 {
                problems.push(text.clone());
            }
        }
        let mut status = self.lock();
        status.lines += 1.0;
        status.log.push(text);
        if status.log.len() > LOG_LINES {
            status.log.remove(0);
        }
    }

    pub fn finish(&self, result: AppResult<()>) {
        let mut status = self.lock();
        match result {
            Ok(()) if self.cancelled() => status.state = ToolState::Cancelled,
            Ok(()) => status.state = ToolState::Done,
            Err(e) => {
                status.state = ToolState::Failed;
                status.error = Some((&e).into());
            }
        }
    }
}

impl Default for ToolJob {
    fn default() -> Self {
        Self::new()
    }
}

/// The jobs of this run, by id.
#[derive(Default)]
pub struct ToolJobs {
    jobs: StdMutex<Vec<(String, Arc<ToolJob>)>>,
}

impl ToolJobs {
    const KEEP: usize = 20;

    pub fn add(&self, id: String, job: Arc<ToolJob>) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.push((id, job));
        while jobs.len() > Self::KEEP {
            match jobs
                .iter()
                .position(|(_, j)| j.snapshot().state != ToolState::Running)
            {
                Some(i) => {
                    jobs.remove(i);
                }
                None => break,
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<ToolJob>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, j)| Arc::clone(j))
    }
}

fn shown(program: &str, args: &[String]) -> String {
    let quote = |a: &String| {
        if a.contains([' ', '\'', '"']) {
            format!("'{}'", a.replace('\'', "'\\''"))
        } else {
            a.clone()
        }
    };
    format!(
        "{program} {}",
        args.iter().map(quote).collect::<Vec<_>>().join(" ")
    )
}

enum Exit {
    Success,
    Cancelled,
    Failed(String),
}

/// Run the program, collecting what it prints, until it ends or the job is cancelled.
async fn run_program(
    job: &Arc<ToolJob>,
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    feed: Option<&Path>,
) -> AppResult<Exit> {
    let name = program
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    job.lock().command = shown(&name, args);
    let mut child = Command::new(program)
        .args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(if feed.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Internal(format!("could not start {name}: {e}")))?;

    // A SQL script goes in through the program's input, behind `\restrict`.
    let feeder = match (feed, child.stdin.take()) {
        (Some(path), Some(stdin)) => Some(tokio::spawn(feed_script(path.to_path_buf(), stdin))),
        _ => None,
    };

    // What the program prints, line by line, into the job's log.
    let tail = Arc::new(StdMutex::new(Vec::<String>::new()));
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(tokio::spawn(read_lines(
            BufReader::new(out),
            Arc::clone(job),
            Arc::clone(&tail),
        )));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(tokio::spawn(read_lines(
            BufReader::new(err),
            Arc::clone(job),
            Arc::clone(&tail),
        )));
    }

    let outcome = loop {
        tokio::select! {
            status = child.wait() => {
                let status = status.map_err(|e| AppError::Internal(e.to_string()))?;
                break if status.success() { Exit::Success } else { Exit::Failed(status.to_string()) };
            }
            () = tokio::time::sleep(Duration::from_millis(100)) => {
                if job.cancelled() {
                    let _ = child.kill().await;
                    break Exit::Cancelled;
                }
            }
        }
    };
    if let Some(feeder) = feeder {
        feeder.abort();
    }
    // Let the readers take the last lines.
    for reader in readers {
        let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    }
    Ok(match outcome {
        Exit::Failed(status) => {
            let tail = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let errors: Vec<&String> = tail
                .iter()
                .filter(|l| {
                    ["error", "ERROR", "FATAL", "could not", "aborting"]
                        .iter()
                        .any(|k| l.contains(k))
                })
                .collect();
            let chosen = if errors.is_empty() {
                tail.iter().collect()
            } else {
                errors
            };
            let text = chosen
                .iter()
                .rev()
                .take(4)
                .rev()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            Exit::Failed(if text.is_empty() {
                format!("{name} ended with {status}")
            } else {
                text
            })
        }
        other => other,
    })
}

async fn read_lines<R: tokio::io::AsyncRead + Unpin>(
    reader: BufReader<R>,
    job: Arc<ToolJob>,
    tail: Arc<StdMutex<Vec<String>>>,
) {
    let mut lines = reader.lines();
    while let Ok(Some(text)) = lines.next_line().await {
        job.line(text.clone());
        let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
        tail.push(text);
        if tail.len() > 12 {
            tail.remove(0);
        }
    }
}

/// `pg_dump` 17 writes `SET transaction_timeout`, which a server older than 17 does not know.
/// Restoring such a dump there reports that one error and carries on correctly; it is not a
/// failure. Anything else in the complaints is.
fn only_known_harmless(problems: &[String]) -> bool {
    !problems.is_empty()
        && problems.iter().all(|p| {
            p.contains("transaction_timeout")
                || p.starts_with("Command was: SET transaction_timeout")
        })
}

/// Why a restore failed, in the program's words: its errors, not its last log lines.
fn complaint(job: &ToolJob, fallback: String) -> String {
    let problems = job.problems.lock().unwrap_or_else(|e| e.into_inner());
    let errors: Vec<&str> = problems
        .iter()
        .filter(|p| !p.starts_with("Command was:"))
        .map(String::as_str)
        .take(3)
        .collect();
    if errors.is_empty() {
        fallback
    } else {
        errors.join("\n")
    }
}

/// What `psql` is given for a SQL script: first `\restrict <key>` with a key made here, then the
/// script. In restricted mode `psql` refuses every meta-command (`\!`, `\copy … program`, `\i`,
/// `\gset`, wherever on a line they are) except `\unrestrict` with that key, which the script
/// cannot know. `pg_dump` itself writes `\restrict` and `\unrestrict` lines with its own key
/// into a plain backup; those are left out (outside of `COPY` data, where a line is only data).
pub struct ScriptFilter {
    in_copy: bool,
}

impl ScriptFilter {
    pub fn new() -> Self {
        Self { in_copy: false }
    }

    /// `true`: pass the line on.
    pub fn keep(&mut self, line: &[u8]) -> bool {
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end_matches(['\n', '\r']);
        if self.in_copy {
            if text == "\\." {
                self.in_copy = false;
            }
            return true;
        }
        if text.starts_with("COPY ") && text.ends_with("FROM stdin;") {
            self.in_copy = true;
            return true;
        }
        !(text.starts_with("\\restrict ") || text.starts_with("\\unrestrict "))
    }
}

impl Default for ScriptFilter {
    fn default() -> Self {
        Self::new()
    }
}

/// Write the script to `psql`'s input: our `\restrict` line, then the file, line by line.
async fn feed_script(path: PathBuf, mut stdin: tokio::process::ChildStdin) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let Ok(file) = tokio::fs::File::open(&path).await else {
        return;
    };
    let key = uuid::Uuid::new_v4().simple().to_string();
    if stdin
        .write_all(format!("\\restrict {key}\n").as_bytes())
        .await
        .is_err()
    {
        return;
    }
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut filter = ScriptFilter::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if filter.keep(&line) && stdin.write_all(&line).await.is_err() {
                    return; // the program ended: nothing more to say to it
                }
            }
        }
    }
    let _ = stdin.shutdown().await;
}

/// Does this `psql` have restricted mode (CVE-2025-8714)? It came with 13.22, 14.19, 15.14,
/// 16.10, 17.6 and 18.
pub fn supports_restrict(tools: &PgTools) -> bool {
    let minor: u32 = tools
        .version
        .split('.')
        .nth(1)
        .map(|m| {
            m.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    match tools.major {
        13 => minor >= 22,
        14 => minor >= 19,
        15 => minor >= 14,
        16 => minor >= 10,
        17 => minor >= 6,
        major => major >= 18,
    }
}

/// `<path>.part`
fn part_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn remove_any(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// Back the database up. The result is in `request.path` only when it is complete.
pub async fn run_backup(
    job: &Arc<ToolJob>,
    tools: &PgTools,
    request: &BackupRequest,
    endpoint: &Endpoint,
) -> AppResult<()> {
    let path = PathBuf::from(&request.path);
    if !path.is_absolute() {
        return Err(invalid("Choose where to save the backup."));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(invalid(format!(
            "The folder of {} does not exist.",
            path.display()
        )));
    }
    if request.format == BackupFormat::Directory && path.exists() {
        return Err(invalid(format!(
            "{} exists already: a directory backup needs a folder that is not there yet.",
            path.display()
        )));
    }
    if path.is_dir() && request.format != BackupFormat::Directory {
        return Err(invalid(format!(
            "{} is a folder: give the file a name.",
            path.display()
        )));
    }
    let part = part_of(&path);
    remove_any(&part);
    let args = dump_args(request, &endpoint.database, &part)?;
    {
        let mut status = job.lock();
        status.output = Some(path.display().to_string());
    }
    *job.growing.lock().unwrap_or_else(|e| e.into_inner()) = Some(part.clone());

    let outcome = run_program(
        job,
        &Path::new(&tools.dir).join("pg_dump"),
        &args,
        &endpoint.env(),
        None,
    )
    .await;
    match outcome {
        Ok(Exit::Success) => {
            remove_any_if_file(&path);
            std::fs::rename(&part, &path).map_err(|e| {
                AppError::Internal(format!("could not save {}: {e}", path.display()))
            })?;
            *job.growing.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
            Ok(())
        }
        Ok(Exit::Cancelled) => {
            remove_any(&part);
            Ok(())
        }
        Ok(Exit::Failed(message)) => {
            remove_any(&part);
            Err(AppError::Internal(message))
        }
        Err(e) => {
            remove_any(&part);
            Err(e)
        }
    }
}

fn remove_any_if_file(path: &Path) {
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
}

/// Restore a backup. For a new database `admin` (a connection to the server) makes it first,
/// and drops it again if the restore does not finish.
pub async fn run_restore(
    job: &Arc<ToolJob>,
    tools: &PgTools,
    request: &RestoreRequest,
    endpoint: Endpoint,
    admin: &Client,
) -> AppResult<()> {
    let path = PathBuf::from(&request.path);
    let kind = kind_of(&path)?;
    let (database, created) = match &request.target {
        RestoreTarget::Existing { database } => (database.as_str(), false),
        RestoreTarget::New { database } => (database.as_str(), true),
    };
    let endpoint = endpoint.with_database(database)?;
    if kind == BackupKind::Script && !supports_restrict(tools) {
        return Err(invalid(format!(
            "psql {} can't run a SQL script safely: a script can carry psql commands that run programs. \
             Update PostgreSQL (brew upgrade postgresql@{}) or restore a custom, directory or tar backup.",
            tools.version, tools.major
        )));
    }
    let args = restore_args(request, kind, database, &path)?;
    let program = match kind {
        BackupKind::Archive => "pg_restore",
        BackupKind::Script => "psql",
    };

    if created {
        admin
            .batch_execute(&format!("CREATE DATABASE {}", quote_ident(database)))
            .await?;
    }
    job.lock().output = Some(database.to_owned());
    let outcome = run_program(
        job,
        &Path::new(&tools.dir).join(program),
        &args,
        &endpoint.env(),
        (kind == BackupKind::Script).then_some(path.as_path()),
    )
    .await;
    let undo = || async {
        if created {
            let _ = admin
                .batch_execute(&format!(
                    "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                    quote_ident(database)
                ))
                .await;
        }
    };
    // `psql` goes on after an error and ends well: what it complained about decides.
    let outcome = match outcome {
        Ok(Exit::Success)
            if kind == BackupKind::Script
                && !job
                    .problems
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_empty() =>
        {
            Ok(Exit::Failed(String::new()))
        }
        other => other,
    };
    match outcome {
        Ok(Exit::Success) => Ok(()),
        Ok(Exit::Cancelled) => {
            undo().await;
            Ok(())
        }
        Ok(Exit::Failed(_))
            if only_known_harmless(&job.problems.lock().unwrap_or_else(|e| e.into_inner())) =>
        {
            job.line(
                "Ignored: this server does not know transaction_timeout (the backup was made by a newer pg_dump)."
                    .to_owned(),
            );
            Ok(())
        }
        Ok(Exit::Failed(message)) => {
            undo().await;
            Err(AppError::Internal(complaint(job, message)))
        }
        Err(e) => {
            undo().await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ColorTag, SafeMode, SslFiles};

    fn config() -> ConnectionConfig {
        ConnectionConfig {
            id: "1".into(),
            name: "n".into(),
            host: "db.example.com".into(),
            port: 5432,
            user: "app".into(),
            database: "shop".into(),
            ssl_mode: SslMode::VerifyFull,
            color: ColorTag::None,
            group: None,
            safe_mode: SafeMode::Off,
            statement_timeout_ms: None,
            has_password: true,
            ssh: None,
            ssl_files: None,
        }
    }

    fn backup() -> BackupRequest {
        BackupRequest {
            tools_dir: None,
            database: None,
            path: "/tmp/x.dump".into(),
            format: BackupFormat::Custom,
            schema_only: false,
            data_only: false,
            include_tables: vec![],
            exclude_tables: vec![],
            compression: None,
            no_owner: false,
        }
    }

    fn tools(versions: &[u32]) -> Vec<PgTools> {
        versions
            .iter()
            .map(|v| PgTools {
                dir: format!("/pg{v}/bin"),
                version: format!("{v}.1"),
                major: *v,
                source: "test".into(),
            })
            .collect()
    }

    #[test]
    fn versions_are_read_from_what_the_program_says() {
        assert_eq!(
            parse_version("pg_dump (PostgreSQL) 17.10 (Homebrew)\n"),
            Some(("17.10".into(), 17))
        );
        assert_eq!(
            parse_version("pg_dump (PostgreSQL) 16.4"),
            Some(("16.4".into(), 16))
        );
        assert_eq!(
            parse_version("pg_dump (PostgreSQL) 18devel"),
            Some(("18devel".into(), 18))
        );
        assert_eq!(parse_version("nonsense"), None);
        assert_eq!(major_of("16.4"), 16);
        assert_eq!(major_of("9.6.24 (Debian)"), 9);
        assert_eq!(major_of("x"), 0);
    }

    #[test]
    fn the_newest_program_that_is_not_older_than_the_server_is_picked() {
        let found = tools(&[17, 16, 14]);
        // The closest version that is not older than the server.
        assert_eq!(pick(&found, 16, None).unwrap().major, 16);
        assert_eq!(pick(&found, 15, None).unwrap().major, 16);
        assert_eq!(pick(&found, 17, None).unwrap().major, 17);
        assert_eq!(pick(&found, 1, None).unwrap().major, 14);
        let old = pick(&found, 18, None).unwrap_err().message();
        assert!(
            old.contains("too old") && old.contains("postgresql@18"),
            "{old}"
        );
        assert!(
            pick(&[], 16, None)
                .unwrap_err()
                .message()
                .contains("not found")
        );
        // A folder asked for: used if it is new enough, refused with the reason if not.
        assert_eq!(pick(&found, 15, Some("/pg16/bin")).unwrap().major, 16);
        let refused = pick(&found, 16, Some("/pg14/bin")).unwrap_err().message();
        assert!(refused.contains("older than the server"), "{refused}");
        assert!(
            pick(&found, 16, Some("/nowhere/bin"))
                .unwrap_err()
                .message()
                .contains("no pg_dump")
        );
    }

    #[test]
    fn a_dump_command_line_follows_the_request_and_has_no_secret() {
        let mut request = backup();
        request.schema_only = true;
        request.compression = Some(6);
        request.no_owner = true;
        request.include_tables = vec!["public.orders*".into()];
        request.exclude_tables = vec!["public.logs".into()];
        let args = dump_args(&request, "shop", Path::new("/tmp/x.dump.part")).unwrap();
        for expected in [
            "--dbname=shop",
            "custom",
            "/tmp/x.dump.part",
            "--compress=6",
            "--schema-only",
            "--no-owner",
            "--table=public.orders*",
            "--exclude-table=public.logs",
            "--no-password",
        ] {
            assert!(args.iter().any(|a| a == expected), "{expected}: {args:?}");
        }
        // Compression only applies where it can.
        request.format = BackupFormat::Plain;
        assert!(
            !dump_args(&request, "shop", Path::new("/x"))
                .unwrap()
                .iter()
                .any(|a| a.starts_with("--compress"))
        );
    }

    #[test]
    fn nonsense_in_a_request_is_refused_before_anything_runs() {
        let mut both = backup();
        both.schema_only = true;
        both.data_only = true;
        assert!(
            dump_args(&both, "d", Path::new("/x"))
                .unwrap_err()
                .message()
                .contains("not both")
        );
        let mut level = backup();
        level.compression = Some(12);
        assert!(dump_args(&level, "d", Path::new("/x")).is_err());
        for bad in ["--file=/etc/passwd", "-t x", "", "a\nb"] {
            let mut r = backup();
            r.include_tables = vec![bad.into()];
            assert!(dump_args(&r, "d", Path::new("/x")).is_err(), "{bad:?}");
            let mut r = backup();
            r.exclude_tables = vec![bad.into()];
            assert!(dump_args(&r, "d", Path::new("/x")).is_err(), "{bad:?}");
        }
        for name in ["a=b", "postgresql://u:p@h/d", "postgres://h/d", "", "a\nb"] {
            assert!(check_database(name).is_err(), "{name:?}");
        }
        assert!(check_database("my db").is_ok());
        assert!(check_database("postgres").is_ok());
    }

    #[test]
    fn the_connection_is_in_the_environment_not_on_the_command_line() {
        let endpoint = Endpoint::of(&config(), None, Some("s3cret".into()), None).unwrap();
        let env: std::collections::HashMap<_, _> = endpoint.env().into_iter().collect();
        assert_eq!(env["PGHOST"], "db.example.com");
        assert_eq!(env["PGPORT"], "5432");
        assert_eq!(env["PGUSER"], "app");
        assert_eq!(env["PGPASSWORD"], "s3cret");
        assert_eq!(env["PGSSLMODE"], "verify-full");
        assert!(!env.contains_key("PGHOSTADDR"));
        assert!(!format!("{endpoint:?}").contains("s3cret"));
        // Nothing of it in the arguments.
        let args = dump_args(&backup(), "shop", Path::new("/x"))
            .unwrap()
            .join(" ");
        assert!(!args.contains("s3cret") && !args.contains("db.example.com"));

        // Behind an SSH tunnel: dial the tunnel's port, keep the name for TLS.
        let tunneled = Endpoint::of(&config(), Some("other"), None, Some(49152)).unwrap();
        let env: std::collections::HashMap<_, _> = tunneled.env().into_iter().collect();
        assert_eq!(env["PGHOST"], "db.example.com");
        assert_eq!(env["PGHOSTADDR"], "127.0.0.1");
        assert_eq!(env["PGPORT"], "49152");
        assert!(!env.contains_key("PGPASSWORD"));
        assert_eq!(tunneled.database, "other");

        // Certificate files travel as the libpq variables; a protected key can't.
        let mut with_files = config();
        with_files.ssl_files = Some(SslFiles {
            root_cert: Some("/c/ca.crt".into()),
            client_cert: Some("/c/client.crt".into()),
            client_key: Some("/c/client.key".into()),
            has_key_secret: false,
        });
        let env: std::collections::HashMap<_, _> = Endpoint::of(&with_files, None, None, None)
            .unwrap()
            .env()
            .into_iter()
            .collect();
        assert_eq!(env["PGSSLROOTCERT"], "/c/ca.crt");
        assert_eq!(env["PGSSLCERT"], "/c/client.crt");
        assert_eq!(env["PGSSLKEY"], "/c/client.key");
        with_files.ssl_files.as_mut().unwrap().has_key_secret = true;
        assert!(
            Endpoint::of(&with_files, None, None, None)
                .unwrap_err()
                .message()
                .contains("passphrase")
        );
    }

    #[test]
    fn only_the_known_harmless_complaint_is_forgiven() {
        let timeout = vec![
            "pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter \"transaction_timeout\"".to_owned(),
            "Command was: SET transaction_timeout = 0;".to_owned(),
        ];
        assert!(only_known_harmless(&timeout));
        assert!(!only_known_harmless(&[]));
        let mut worse = timeout.clone();
        worse.push(
            "pg_restore: error: could not execute query: ERROR:  relation \"t\" already exists"
                .into(),
        );
        assert!(!only_known_harmless(&worse));
        assert!(!only_known_harmless(&[
            "psql:x.sql:3: ERROR:  syntax error at or near \"THIS\"".to_owned()
        ]));
    }

    #[test]
    fn a_script_is_filtered_and_psql_commands_are_left_to_restricted_mode() {
        let mut filter = ScriptFilter::new();
        let script = "\\restrict abc123\nSET x = 1;\nCOPY public.t (a) FROM stdin;\n\\N\n\\restrict not-a-command-but-data\n\\.\nSELECT 1;\n\\unrestrict abc123\n";
        let kept: Vec<&str> = script
            .split_inclusive('\n')
            .filter(|l| filter.keep(l.as_bytes()))
            .collect();
        assert_eq!(
            kept,
            [
                "SET x = 1;\n",
                "COPY public.t (a) FROM stdin;\n",
                "\\N\n",
                "\\restrict not-a-command-but-data\n", // data inside COPY stays
                "\\.\n",
                "SELECT 1;\n",
            ]
        );
        // A real meta-command is not removed here: restricted mode refuses it.
        let mut filter = ScriptFilter::new();
        assert!(filter.keep(b"\\! touch /tmp/x\n"));
        assert!(filter.keep(b"SELECT 1 \\gset\n"));
    }

    #[test]
    fn restricted_mode_is_needed_and_only_some_versions_have_it() {
        let v = |major: u32, version: &str| PgTools {
            dir: String::new(),
            version: version.into(),
            major,
            source: String::new(),
        };
        assert!(supports_restrict(&v(17, "17.10")));
        assert!(supports_restrict(&v(17, "17.6")));
        assert!(!supports_restrict(&v(17, "17.5")));
        assert!(supports_restrict(&v(16, "16.10")));
        assert!(!supports_restrict(&v(16, "16.9")));
        assert!(supports_restrict(&v(18, "18.0")));
        assert!(supports_restrict(&v(18, "18devel")));
        assert!(!supports_restrict(&v(15, "15.13")));
        assert!(supports_restrict(&v(15, "15.14")));
        assert!(!supports_restrict(&v(12, "12.99")));
    }

    #[test]
    fn a_restore_picks_the_program_by_what_the_file_is() {
        let dir = std::env::temp_dir().join(format!("angkordb-backup-kind-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let custom = dir.join("a.dump");
        std::fs::write(&custom, b"PGDMP\x01\x0e\x00").unwrap();
        let script = dir.join("a.sql");
        std::fs::write(&script, "CREATE TABLE t (a int);\n").unwrap();
        let folder = dir.join("d");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(kind_of(&folder).is_err(), "a folder without toc.dat");
        std::fs::write(folder.join("toc.dat"), b"x").unwrap();
        assert_eq!(kind_of(&custom).unwrap(), BackupKind::Archive);
        assert_eq!(kind_of(&script).unwrap(), BackupKind::Script);
        assert_eq!(kind_of(&folder).unwrap(), BackupKind::Archive);
        assert!(
            kind_of(&dir.join("nope"))
                .unwrap_err()
                .message()
                .contains("no backup")
        );

        let request = RestoreRequest {
            tools_dir: None,
            path: String::new(),
            target: RestoreTarget::New {
                database: "copy".into(),
            },
            clean: true,
            no_owner: true,
            jobs: 4,
        };
        let args = restore_args(&request, BackupKind::Archive, "copy", &custom).unwrap();
        for expected in [
            "--clean",
            "--if-exists",
            "--no-owner",
            "--jobs=4",
            "--dbname=copy",
        ] {
            assert!(args.iter().any(|a| a == expected), "{expected}: {args:?}");
        }
        assert_eq!(args.last().unwrap(), &custom.display().to_string());
        let error = restore_args(&request, BackupKind::Script, "copy", &script)
            .unwrap_err()
            .message();
        assert!(error.contains("only works for custom"), "{error}");
        let args = restore_args(
            &RestoreRequest {
                clean: false,
                ..request
            },
            BackupKind::Script,
            "copy",
            &script,
        )
        .unwrap();
        assert!(args.iter().any(|a| a == "--no-psqlrc"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
