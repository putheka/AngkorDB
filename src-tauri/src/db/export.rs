//! Writing rows to a file as they are read (ANG-45).
//!
//! The rows come through a server-side cursor in a read-only transaction, a few thousand at a
//! time as text, so memory stays flat however big the table is (a million rows take the same
//! as a hundred) and nothing the query does can change data. The file is written under a
//! `.part` name and only given its real name when it is complete; cancelling or failing leaves
//! nothing behind.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::io::AsyncWriteExt;
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{Client, SimpleQueryMessage};

use crate::db::export_format::{Column, RowWriter, kind_of};
use crate::db::introspect;
use crate::db::rows::{build_export_select, quote_ident};
use crate::db::script;
use crate::db::session::Session;
use crate::error::{AppError, AppResult};
use crate::models::export::{
    ExportFormat, ExportRequest, ExportSource, ExportState, ExportStatus, QueryExport, TableExport,
};

/// Rows fetched, formatted and written at a time.
const BATCH_ROWS: usize = 5_000;
const CURSOR: &str = "angkor_export";

/// A running (or finished) export, shared between the task that does it and whoever asks.
pub struct ExportJob {
    status: StdMutex<ExportStatus>,
    cancel: AtomicBool,
}

impl ExportJob {
    pub fn new() -> Self {
        Self {
            status: StdMutex::new(ExportStatus {
                state: ExportState::Running,
                rows: 0.0,
                bytes: 0.0,
                estimated_rows: None,
                current: None,
                files: Vec::new(),
                error: None,
            }),
            cancel: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ExportStatus> {
        self.status.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> ExportStatus {
        self.lock().clone()
    }

    /// Ask the export to stop after the batch it is on.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn add(&self, rows: usize, bytes: usize) {
        let mut status = self.lock();
        status.rows += rows as f64;
        status.bytes += bytes as f64;
    }

    fn start_unit(&self, label: String, estimate: Option<f64>) {
        let mut status = self.lock();
        status.current = Some(label);
        // The estimates of several tables add up.
        status.estimated_rows = match (status.estimated_rows, estimate) {
            (Some(total), Some(more)) => Some(total + more),
            (None, Some(more)) if status.files.is_empty() => Some(more),
            (total, _) => total,
        };
    }

    fn finish_unit(&self, file: &Path) {
        self.lock().files.push(file.display().to_string());
    }

    /// Record how it ended.
    pub fn finish(&self, result: AppResult<()>) {
        let mut status = self.lock();
        status.current = None;
        match result {
            Ok(()) if self.cancelled() => status.state = ExportState::Cancelled,
            Ok(()) => status.state = ExportState::Done,
            Err(e) => {
                status.state = ExportState::Failed;
                status.error = Some((&e).into());
            }
        }
    }
}

impl Default for ExportJob {
    fn default() -> Self {
        Self::new()
    }
}

/// One thing to write to one file.
struct Unit {
    /// A `SELECT` (with `$n` for the values of `params`).
    sql: String,
    params: Vec<String>,
    /// The table name `INSERT` statements use, quoted.
    insert_into: String,
    label: String,
    estimate: Option<f64>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// The file name for a table: `schema.table.csv`, with nothing in it a file system dislikes.
fn file_name(schema: &str, table: &str, extension: &str) -> String {
    let clean: String = format!("{schema}.{table}")
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{clean}.{extension}")
}

async fn estimate(client: &Client, schema: &str, table: &str) -> Option<f64> {
    let row = client
        .query_opt(
            "SELECT c.reltuples::float8 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .ok()??;
    let guess: f64 = row.get(0);
    (guess >= 0.0).then_some(guess)
}

async fn table_unit(client: &Client, export: &TableExport) -> AppResult<Unit> {
    let desc = introspect::describe_table(client, &export.schema, &export.table).await?;
    let built = build_export_select(
        &desc,
        &export.filters,
        export.raw_where.as_deref(),
        &export.sort,
    )?;
    let unfiltered = export.filters.is_empty()
        && export
            .raw_where
            .as_deref()
            .is_none_or(|w| w.trim().is_empty());
    Ok(Unit {
        sql: built.sql,
        params: built.params,
        insert_into: format!(
            "{}.{}",
            quote_ident(&export.schema),
            quote_ident(&export.table)
        ),
        label: format!("{}.{}", export.schema, export.table),
        estimate: if unfiltered {
            estimate(client, &export.schema, &export.table).await
        } else {
            None
        },
    })
}

fn query_unit(export: &QueryExport) -> AppResult<Unit> {
    let statements = script::split(&export.sql);
    let [statement] = statements.as_slice() else {
        return Err(invalid(if statements.is_empty() {
            "There is no query to export."
        } else {
            "Export one query at a time: this is more than one statement."
        }));
    };
    let sql = export.sql[statement.start..statement.end]
        .trim()
        .trim_end_matches(';')
        .trim_end()
        .to_owned();
    let name = export
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("query_result");
    Ok(Unit {
        sql,
        params: Vec::new(),
        insert_into: quote_ident(name),
        label: "query".to_owned(),
        estimate: None,
    })
}

/// Check where the file(s) will go before any work is done.
fn check_destination(request: &ExportRequest) -> AppResult<()> {
    let path = Path::new(&request.path);
    if !path.is_absolute() {
        return Err(invalid("Choose where to save the file."));
    }
    match &request.source {
        ExportSource::Tables { tables } => {
            if tables.is_empty() {
                return Err(invalid("Choose at least one table."));
            }
            if !path.is_dir() {
                return Err(invalid(format!("{} is not a folder.", path.display())));
            }
        }
        _ => {
            if path.is_dir() {
                return Err(invalid(format!(
                    "{} is a folder: give the file a name.",
                    path.display()
                )));
            }
            if !path.parent().is_some_and(Path::is_dir) {
                return Err(invalid(format!(
                    "The folder of {} does not exist.",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

/// Export what the request says. Returns when it is done, was cancelled or failed.
pub async fn run(
    session: &Session,
    job: &ExportJob,
    id: &str,
    request: &ExportRequest,
) -> AppResult<()> {
    check_destination(request)?;
    let extension = RowWriter::extension(&request.format);
    let mut work: Vec<(Unit, PathBuf)> = Vec::new();
    {
        let meta = session.meta().await?;
        match &request.source {
            ExportSource::Table(table) => {
                work.push((
                    table_unit(&meta, table).await?,
                    PathBuf::from(&request.path),
                ));
            }
            ExportSource::Query(query) => {
                work.push((query_unit(query)?, PathBuf::from(&request.path)));
            }
            ExportSource::Tables { tables } => {
                for t in tables {
                    let unit = table_unit(
                        &meta,
                        &TableExport {
                            schema: t.schema.clone(),
                            table: t.table.clone(),
                            filters: Vec::new(),
                            raw_where: None,
                            sort: Vec::new(),
                        },
                    )
                    .await?;
                    let file =
                        Path::new(&request.path).join(file_name(&t.schema, &t.table, extension));
                    work.push((unit, file));
                }
            }
        }
    }

    let tab = format!("export:{id}");
    let client = session.tab_client(&tab).await?;
    let mut result = Ok(());
    for (unit, file) in &work {
        if job.cancelled() {
            break;
        }
        job.start_unit(unit.label.clone(), unit.estimate);
        result = write_unit(&client, job, unit, &request.format, file).await;
        if result.is_err() {
            break;
        }
    }
    session.close_tab(&tab).await;
    result
}

/// Write one unit under a `.part` name and give it its name when it is complete.
async fn write_unit(
    client: &Client,
    job: &ExportJob,
    unit: &Unit,
    format: &ExportFormat,
    file: &Path,
) -> AppResult<()> {
    let part = {
        let mut name = file.as_os_str().to_owned();
        name.push(".part");
        PathBuf::from(name)
    };
    let outcome = stream(client, job, unit, format, &part).await;
    // Whatever happened to the transaction, it does not go on.
    let _ = client.batch_execute("ROLLBACK").await;
    match outcome {
        Ok(()) if !job.cancelled() => {
            tokio::fs::rename(&part, file).await.map_err(|e| {
                AppError::Internal(format!("could not save {}: {e}", file.display()))
            })?;
            job.finish_unit(file);
            Ok(())
        }
        other => {
            let _ = tokio::fs::remove_file(&part).await;
            other
        }
    }
}

async fn stream(
    client: &Client,
    job: &ExportJob,
    unit: &Unit,
    format: &ExportFormat,
    part: &Path,
) -> AppResult<()> {
    let types = vec![Type::TEXT; unit.params.len()];
    let values: Vec<(&(dyn ToSql + Sync), Type)> = unit
        .params
        .iter()
        .map(|p| (p as &(dyn ToSql + Sync), Type::TEXT))
        .collect();

    client.batch_execute("BEGIN READ ONLY").await?;
    let statement = client
        .prepare_typed(&unit.sql, &types)
        .await
        .map_err(not_a_query)?;
    let columns: Vec<Column> = statement
        .columns()
        .iter()
        .map(|c| Column {
            name: c.name().to_owned(),
            kind: kind_of(c.type_()),
        })
        .collect();
    let mut writer = RowWriter::new(format, columns, unit.insert_into.clone())?;
    client
        .execute_typed(
            &format!("DECLARE {CURSOR} NO SCROLL CURSOR FOR {}", unit.sql),
            &values,
        )
        .await
        .map_err(not_a_query)?;

    let file = tokio::fs::File::create(part)
        .await
        .map_err(|e| invalid(format!("Can't write {}: {e}.", part.display())))?;
    let mut file = tokio::io::BufWriter::with_capacity(1 << 20, file);
    let mut buffer: Vec<u8> = Vec::with_capacity(1 << 20);
    let fetch = format!("FETCH FORWARD {BATCH_ROWS} FROM {CURSOR}");

    writer.begin(&mut buffer);
    loop {
        if job.cancelled() {
            return Ok(());
        }
        let messages = client.simple_query(&fetch).await?;
        let mut rows = 0;
        for message in &messages {
            if let SimpleQueryMessage::Row(row) = message {
                let cells: Vec<Option<&str>> = (0..row.len()).map(|i| row.get(i)).collect();
                writer.row(&cells, &mut buffer);
                rows += 1;
            }
        }
        if rows == 0 {
            break;
        }
        write_out(&mut file, &mut buffer, job, rows).await?;
    }
    writer.end(&mut buffer);
    write_out(&mut file, &mut buffer, job, 0).await?;
    file.flush().await.map_err(write_error)?;
    file.shutdown().await.map_err(write_error)?;
    Ok(())
}

async fn write_out(
    file: &mut tokio::io::BufWriter<tokio::fs::File>,
    buffer: &mut Vec<u8>,
    job: &ExportJob,
    rows: usize,
) -> AppResult<()> {
    file.write_all(buffer).await.map_err(write_error)?;
    job.add(rows, buffer.len());
    buffer.clear();
    Ok(())
}

fn write_error(e: std::io::Error) -> AppError {
    AppError::Internal(format!("could not write the file: {e}"))
}

/// A statement that is not a query can't be a cursor: say what can be exported.
fn not_a_query(e: tokio_postgres::Error) -> AppError {
    match e.code().map(|c| c.code()) {
        Some("0A000" | "42601") if !e.to_string().contains("syntax") => invalid(
            "Only a query that returns rows can be exported (SELECT, VALUES, TABLE, or WITH … SELECT).",
        ),
        _ => e.into(),
    }
}

/// The jobs of this app run, by id.
#[derive(Default)]
pub struct Exports {
    jobs: StdMutex<Vec<(String, Arc<ExportJob>)>>,
}

impl Exports {
    /// How many finished jobs to remember.
    const KEEP: usize = 20;

    pub fn add(&self, id: String, job: Arc<ExportJob>) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.push((id, job));
        while jobs.len() > Self::KEEP {
            // Forget the oldest that is no longer running.
            match jobs
                .iter()
                .position(|(_, j)| j.snapshot().state != ExportState::Running)
            {
                Some(i) => {
                    jobs.remove(i);
                }
                None => break,
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<ExportJob>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, j)| Arc::clone(j))
    }
}
