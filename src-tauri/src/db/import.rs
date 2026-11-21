//! Reading a CSV or JSON file and writing it into a table (ANG-46).
//!
//! A thread reads and parses the file in batches of 10,000 rows and hands them over through a
//! channel that holds only a few (so memory stays flat however big the file is). Each batch goes
//! to the server with `COPY … FROM STDIN`, inside one transaction for the whole import, behind a
//! savepoint: if a batch has a row the server refuses, the error says which line it was and the
//! import either stops (nothing is kept) or, when asked to skip bad rows, writes that batch row
//! by row and lists the rows it could not write.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use bytes::Bytes;
use futures_util::SinkExt;
use tokio_postgres::Client;
use tokio_postgres::types::{ToSql, Type};

use crate::db::alter::check_type;
use crate::db::import_sniff::suggest_type;
use crate::db::introspect;
use crate::db::rows::quote_ident;
use crate::db::session::Session;
use crate::error::{AppError, AppResult};
use crate::models::import::{
    ColumnMap, ImportFormat, ImportPreview, ImportRequest, ImportState, ImportStatus, ImportTarget,
    NewColumn, OnError, PreviewRequest, RowError,
};

const BATCH_ROWS: usize = 10_000;
const PREVIEW_ROWS: usize = 50;
const SNIFF_ROWS: usize = 1_000;
/// Failed rows kept in the report.
const MAX_ERRORS: usize = 200;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

// ---- reading ---------------------------------------------------------------------------------

/// One row of the file, with the columns that were asked for. `at` is its line (CSV, NDJSON) or
/// its place in the array (JSON).
#[derive(Debug, Clone)]
struct Row {
    at: u64,
    cells: Vec<Option<String>>,
}

struct Counting<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

struct Outcome {
    /// The file's columns.
    names: Vec<String>,
    /// There were more rows than `max_rows`.
    more: bool,
}

fn open(path: &str) -> AppResult<(File, u64)> {
    let file = File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            invalid(format!("There is no file at {path}."))
        } else {
            invalid(format!("Can't read {path}: {e}."))
        }
    })?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((file, size))
}

fn ascii_byte(text: &str, what: &str) -> AppResult<u8> {
    match text.as_bytes() {
        [b] if b.is_ascii() && *b != b'\n' && *b != b'\r' => Ok(*b),
        _ => Err(invalid(format!(
            "The {what} is one ASCII character (not a line break)."
        ))),
    }
}

/// Column names that are unique and never empty: a second `id` becomes `id_2`, a blank one
/// `column_3`.
fn unique_names(raw: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    raw.into_iter()
        .enumerate()
        .map(|(i, name)| {
            let base = if name.trim().is_empty() {
                format!("column_{}", i + 1)
            } else {
                name.trim().to_owned()
            };
            let mut candidate = base.clone();
            let mut n = 1;
            while seen.contains(&candidate) {
                n += 1;
                candidate = format!("{base}_{n}");
            }
            seen.push(candidate.clone());
            candidate
        })
        .collect()
}

/// Read the file in batches. `wanted`: the columns to hand over, in this order (a column the
/// file doesn't have is `NULL`); `None`: all of them. `emit` gets each batch and says whether to
/// go on.
#[allow(clippy::too_many_arguments)]
fn read_file(
    path: &str,
    format: &ImportFormat,
    wanted: Option<&[String]>,
    max_rows: usize,
    batch: usize,
    cancel: &AtomicBool,
    bytes: &Arc<AtomicU64>,
    emit: &mut dyn FnMut(Vec<Row>) -> bool,
) -> AppResult<Outcome> {
    let (file, _) = open(path)?;
    let mut reader = BufReader::with_capacity(
        1 << 20,
        Counting {
            inner: file,
            count: Arc::clone(bytes),
        },
    );
    // A byte order mark is not part of the first name.
    if reader
        .fill_buf()
        .is_ok_and(|b| b.starts_with(&[0xEF, 0xBB, 0xBF]))
    {
        reader.consume(3);
    }
    match format {
        ImportFormat::Csv {
            delimiter,
            quote,
            header,
            null_text,
        } => read_csv(
            reader,
            ascii_byte(delimiter, "delimiter")?,
            ascii_byte(quote, "quote character")?,
            *header,
            null_text,
            wanted,
            max_rows,
            batch,
            cancel,
            emit,
        ),
        ImportFormat::Json => read_json(reader, wanted, max_rows, batch, cancel, emit),
    }
}

#[allow(clippy::too_many_arguments)]
fn read_csv(
    reader: impl Read,
    delimiter: u8,
    quote: u8,
    header: bool,
    null_text: &str,
    wanted: Option<&[String]>,
    max_rows: usize,
    batch: usize,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Vec<Row>) -> bool,
) -> AppResult<Outcome> {
    let mut csv = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .quote(quote)
        .has_headers(false)
        .flexible(true)
        .from_reader(reader);
    let mut record = csv::StringRecord::new();
    let fail = |e: csv::Error| {
        let line = e.position().map(|p| p.line());
        invalid(match (line, e.kind()) {
            (Some(l), csv::ErrorKind::Utf8 { .. }) => {
                format!("Line {l} is not valid UTF-8. Save the file as UTF-8 and try again.")
            }
            (Some(l), _) => format!("Line {l}: {e}"),
            _ => e.to_string(),
        })
    };

    let mut names: Vec<String> = Vec::new();
    let mut first_data: Option<(u64, Vec<String>)> = None;
    if csv.read_record(&mut record).map_err(fail)? {
        let fields: Vec<String> = record.iter().map(str::to_owned).collect();
        if header {
            names = unique_names(fields);
        } else {
            names = (1..=fields.len()).map(|i| format!("column_{i}")).collect();
            first_data = Some((record.position().map_or(1, csv::Position::line), fields));
        }
    }
    let project = |names: &[String]| -> Vec<Option<usize>> {
        match wanted {
            Some(w) => w
                .iter()
                .map(|n| names.iter().position(|x| x == n))
                .collect(),
            None => (0..names.len()).map(Some).collect(),
        }
    };
    let indexes = project(&names);
    let cell = |value: &str| -> Option<String> {
        if null_text.is_empty() {
            (!value.is_empty()).then(|| value.to_owned())
        } else {
            (value != null_text).then(|| value.to_owned())
        }
    };
    let row_of = |at: u64, fields: &[&str]| Row {
        at,
        cells: indexes
            .iter()
            .map(|i| i.and_then(|i| fields.get(i).copied()).and_then(&cell))
            .collect(),
    };

    let mut rows: Vec<Row> = Vec::new();
    let mut total = 0usize;
    let mut more = false;
    if let Some((at, fields)) = first_data {
        let refs: Vec<&str> = fields.iter().map(String::as_str).collect();
        rows.push(row_of(at, &refs));
        total += 1;
    }
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(Outcome { names, more });
        }
        if total >= max_rows {
            // Is there another record after the last one wanted?
            more = csv.read_record(&mut record).map_err(fail)?;
            break;
        }
        if !csv.read_record(&mut record).map_err(fail)? {
            break;
        }
        let at = record.position().map_or(0, csv::Position::line);
        let fields: Vec<&str> = record.iter().collect();
        rows.push(row_of(at, &fields));
        total += 1;
        if rows.len() >= batch && !emit(std::mem::take(&mut rows)) {
            return Ok(Outcome { names, more });
        }
    }
    if !rows.is_empty() {
        emit(rows);
    }
    Ok(Outcome { names, more })
}

/// What a JSON value is as a cell: a string as it is, a number or boolean as it reads, nested
/// JSON as compact JSON text (for a `json`/`jsonb` column), `null` as `NULL`.
fn json_cell(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn read_json(
    mut reader: impl BufRead,
    wanted: Option<&[String]>,
    max_rows: usize,
    batch: usize,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Vec<Row>) -> bool,
) -> AppResult<Outcome> {
    let first = loop {
        let buf = reader.fill_buf().map_err(|e| invalid(e.to_string()))?;
        match buf.iter().position(|b| !b.is_ascii_whitespace()) {
            Some(i) => break buf[i],
            None if buf.is_empty() => return Err(invalid("The file is empty.")),
            None => {
                let n = buf.len();
                reader.consume(n);
            }
        }
    };
    let (array, unit) = match first {
        b'[' => (true, "item"),
        b'{' => (false, "line"),
        _ => {
            return Err(invalid(
                "This is not JSON data: it should be an array of objects, or one object per line.",
            ));
        }
    };

    // The objects, as they come: (place, object).
    let mut objects: Vec<(u64, serde_json::Map<String, serde_json::Value>)> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut indexes: Vec<String> = wanted.map(<[String]>::to_vec).unwrap_or_default();
    let mut more = false;
    let mut total = 0usize;
    let mut stopped = false;

    // Hand the objects over as rows of the wanted columns. Without a list of columns (a
    // preview) the columns are the keys seen, in order of appearance.
    let mut flush = |objects: &mut Vec<(u64, serde_json::Map<String, serde_json::Value>)>,
                     indexes: &[String]|
     -> bool {
        let rows = objects
            .drain(..)
            .map(|(at, object)| Row {
                at,
                cells: indexes
                    .iter()
                    .map(|k| object.get(k).and_then(json_cell))
                    .collect(),
            })
            .collect();
        emit(rows)
    };

    let mut take = |at: u64,
                    value: serde_json::Value,
                    objects: &mut Vec<(u64, serde_json::Map<String, serde_json::Value>)>,
                    names: &mut Vec<String>,
                    indexes: &mut Vec<String>|
     -> AppResult<bool> {
        let serde_json::Value::Object(object) = value else {
            return Err(invalid(format!(
                "The {unit} {at} is not an object: every entry should be one."
            )));
        };
        for key in object.keys() {
            if !names.contains(key) {
                names.push(key.clone());
                if wanted.is_none() {
                    indexes.push(key.clone());
                }
            }
        }
        if total >= max_rows {
            more = true;
            return Ok(false);
        }
        objects.push((at, object));
        total += 1;
        if wanted.is_some() && objects.len() >= batch && !flush(objects, indexes) {
            return Ok(false);
        }
        Ok(!cancel.load(Ordering::Relaxed))
    };

    if array {
        struct Items<'a> {
            each: &'a mut dyn FnMut(u64, serde_json::Value) -> AppResult<bool>,
            failure: &'a mut Option<AppError>,
            stopped: &'a mut bool,
        }
        impl<'de> serde::de::Visitor<'de> for Items<'_> {
            type Value = ();
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an array of objects")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
                let mut at = 0;
                while let Some(value) = seq.next_element::<serde_json::Value>()? {
                    at += 1;
                    match (self.each)(at, value) {
                        Ok(true) => {}
                        Ok(false) => {
                            *self.stopped = true;
                            return Ok(());
                        }
                        Err(e) => {
                            *self.failure = Some(e);
                            *self.stopped = true;
                            return Ok(());
                        }
                    }
                }
                Ok(())
            }
        }
        use serde::Deserializer as _;
        let mut failure = None;
        let mut deserializer = serde_json::Deserializer::from_reader(reader);
        let result = deserializer.deserialize_seq(Items {
            each: &mut |at, value| take(at, value, &mut objects, &mut names, &mut indexes),
            failure: &mut failure,
            stopped: &mut stopped,
        });
        if let Some(e) = failure {
            return Err(e);
        }
        // Stopping early leaves the array unfinished: that is not an error.
        if let Err(e) = result
            && !stopped
        {
            return Err(invalid(format!("The JSON is not valid: {e}")));
        }
    } else {
        let mut line = String::new();
        let mut at = 0u64;
        loop {
            line.clear();
            if reader
                .read_line(&mut line)
                .map_err(|e| invalid(e.to_string()))?
                == 0
            {
                break;
            }
            at += 1;
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(line.trim())
                .map_err(|e| invalid(format!("Line {at}: {e}")))?;
            if !take(at, value, &mut objects, &mut names, &mut indexes)? {
                break;
            }
        }
    }
    if !objects.is_empty() {
        flush(&mut objects, &indexes);
    }
    Ok(Outcome { names, more })
}

/// The start of a file: its columns, the first rows, and a type for each column.
pub fn preview(request: &PreviewRequest) -> AppResult<ImportPreview> {
    let (_, size) = open(&request.path)?;
    let mut rows: Vec<Row> = Vec::new();
    let outcome = read_file(
        &request.path,
        &request.format,
        None,
        SNIFF_ROWS,
        SNIFF_ROWS,
        &AtomicBool::new(false),
        &Arc::new(AtomicU64::new(0)),
        &mut |batch| {
            rows.extend(batch);
            true
        },
    )?;
    let width = outcome.names.len();
    let suggested_types = (0..width)
        .map(|i| {
            suggest_type(
                rows.iter()
                    .filter_map(|r| r.cells.get(i).and_then(|c| c.as_deref())),
            )
            .to_owned()
        })
        .collect();
    let more_rows = outcome.more || rows.len() > PREVIEW_ROWS;
    Ok(ImportPreview {
        columns: outcome.names,
        rows: rows
            .into_iter()
            .take(PREVIEW_ROWS)
            .map(|r| r.cells)
            .collect(),
        suggested_types,
        file_bytes: size as f64,
        more_rows,
    })
}

// ---- the job ---------------------------------------------------------------------------------

/// A running (or finished) import, shared between the task that does it and whoever asks.
pub struct ImportJob {
    status: StdMutex<ImportStatus>,
    cancel: AtomicBool,
    bytes: Arc<AtomicU64>,
}

impl ImportJob {
    pub fn new() -> Self {
        Self {
            status: StdMutex::new(ImportStatus {
                state: ImportState::Running,
                rows_read: 0.0,
                rows_written: 0.0,
                rows_skipped: 0.0,
                bytes_read: 0.0,
                bytes_total: 0.0,
                errors: Vec::new(),
                more_errors: false,
                error: None,
                table: None,
            }),
            cancel: AtomicBool::new(false),
            bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ImportStatus> {
        self.status.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> ImportStatus {
        let mut status = self.lock().clone();
        status.bytes_read =
            (self.bytes.load(Ordering::Relaxed) as f64).min(status.bytes_total.max(0.0));
        if status.state == ImportState::Done {
            status.bytes_read = status.bytes_total;
        }
        status
    }

    /// Stop after the batch it is on; nothing is kept.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn error_at(&self, at: String, message: String) {
        let mut status = self.lock();
        if status.errors.len() < MAX_ERRORS {
            status.errors.push(RowError { at, message });
        } else {
            status.more_errors = true;
        }
    }

    pub fn finish(&self, result: AppResult<()>) {
        let mut status = self.lock();
        match result {
            Ok(()) if self.cancelled() => {
                status.state = ImportState::Cancelled;
                status.rows_written = 0.0;
            }
            Ok(()) => status.state = ImportState::Done,
            Err(e) => {
                status.state = ImportState::Failed;
                status.rows_written = 0.0;
                status.error = Some((&e).into());
            }
        }
    }
}

impl Default for ImportJob {
    fn default() -> Self {
        Self::new()
    }
}

/// The imports of this run, by id.
#[derive(Default)]
pub struct Imports {
    jobs: StdMutex<Vec<(String, Arc<ImportJob>)>>,
}

impl Imports {
    const KEEP: usize = 20;

    pub fn add(&self, id: String, job: Arc<ImportJob>) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.push((id, job));
        while jobs.len() > Self::KEEP {
            match jobs
                .iter()
                .position(|(_, j)| j.snapshot().state != ImportState::Running)
            {
                Some(i) => {
                    jobs.remove(i);
                }
                None => break,
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<ImportJob>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, j)| Arc::clone(j))
    }
}

// ---- writing ---------------------------------------------------------------------------------

/// Where the rows go.
struct Plan {
    /// `"schema"."table"`, quoted.
    relation: String,
    /// `schema.table`, for the report.
    label: String,
    /// `CREATE TABLE …` first, for a new table.
    create: Option<String>,
    truncate: bool,
    /// The file's columns to read, and the table's columns to write them to, in the same order.
    sources: Vec<String>,
    columns: Vec<String>,
    /// How to cast each column's text when it is inserted row by row.
    types: Vec<String>,
}

async fn plan(client: &Client, target: &ImportTarget) -> AppResult<Plan> {
    match target {
        ImportTarget::Existing {
            schema,
            table,
            mapping,
            truncate,
        } => {
            if mapping.is_empty() {
                return Err(invalid(
                    "Map at least one column of the file to a column of the table.",
                ));
            }
            let desc = introspect::describe_table(client, schema, table).await?;
            let mut columns = Vec::new();
            let mut types = Vec::new();
            for ColumnMap { source, column } in mapping {
                let info = desc
                    .columns
                    .iter()
                    .find(|c| &c.name == column)
                    .ok_or_else(|| invalid(format!("{table} has no column \"{column}\".")))?;
                if info.generated {
                    return Err(invalid(format!(
                        "\"{column}\" is generated: it can't be written."
                    )));
                }
                if columns.contains(&info.name) {
                    return Err(invalid(format!(
                        "\"{column}\" is mapped from two columns of the file."
                    )));
                }
                columns.push(info.name.clone());
                types.push(info.type_name.clone());
                let _ = source;
            }
            Ok(Plan {
                relation: format!("{}.{}", quote_ident(schema), quote_ident(table)),
                label: format!("{schema}.{table}"),
                create: None,
                truncate: *truncate,
                sources: mapping.iter().map(|m| m.source.clone()).collect(),
                columns,
                types,
            })
        }
        ImportTarget::New {
            schema,
            table,
            columns,
        } => {
            if table.trim().is_empty() {
                return Err(invalid("Give the table a name."));
            }
            if columns.is_empty() {
                return Err(invalid("The new table needs at least one column."));
            }
            let mut names: Vec<&str> = Vec::new();
            for NewColumn {
                name, type_name, ..
            } in columns
            {
                if name.trim().is_empty() {
                    return Err(invalid("A column has no name."));
                }
                if names.contains(&name.as_str()) {
                    return Err(invalid(format!("Two columns are called \"{name}\".")));
                }
                names.push(name);
                check_type(type_name)?;
            }
            let relation = format!("{}.{}", quote_ident(schema), quote_ident(table));
            let definitions: Vec<String> = columns
                .iter()
                .map(|c| format!("{} {}", quote_ident(&c.name), c.type_name.trim()))
                .collect();
            Ok(Plan {
                create: Some(format!(
                    "CREATE TABLE {relation} (\n  {}\n)",
                    definitions.join(",\n  ")
                )),
                relation,
                label: format!("{schema}.{table}"),
                truncate: false,
                sources: columns.iter().map(|c| c.source.clone()).collect(),
                columns: columns.iter().map(|c| c.name.clone()).collect(),
                types: columns
                    .iter()
                    .map(|c| c.type_name.trim().to_owned())
                    .collect(),
            })
        }
    }
}

/// The batch as CSV for `COPY … FORMAT csv`: `NULL` is an empty field, an empty text `""`.
/// Returns the bytes and, for each row, how many lines it takes (a value can hold line breaks).
fn to_copy_bytes(rows: &[Row]) -> (Bytes, Vec<u32>) {
    let mut out: Vec<u8> = Vec::with_capacity(rows.len() * 64);
    let mut lines = Vec::with_capacity(rows.len());
    for row in rows {
        let start = out.len();
        for (i, cell) in row.cells.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            if let Some(value) = cell {
                if value.is_empty() || value.contains([',', '"', '\n', '\r']) {
                    out.push(b'"');
                    for b in value.bytes() {
                        if b == b'"' {
                            out.push(b'"');
                        }
                        out.push(b);
                    }
                    out.push(b'"');
                } else {
                    out.extend_from_slice(value.as_bytes());
                }
            }
        }
        out.push(b'\n');
        lines.push(out[start..].iter().filter(|b| **b == b'\n').count() as u32);
    }
    (Bytes::from(out), lines)
}

/// The row of a batch that a `COPY` line number points into.
fn row_of_line(lines: &[u32], line: u32) -> Option<usize> {
    let mut seen = 0;
    for (i, n) in lines.iter().enumerate() {
        seen += n;
        if line <= seen {
            return Some(i);
        }
    }
    None
}

/// `COPY t, line 3, column qty: "abc"` → (3, Some("qty"))
fn copy_position(context: &str) -> Option<(u32, Option<String>)> {
    let after = context.split(", line ").nth(1)?;
    let line = after
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    let column = after
        .split(", column ")
        .nth(1)
        .and_then(|c| c.split(':').next())
        .map(str::to_owned);
    Some((line, column))
}

fn message_of(error: &tokio_postgres::Error, column: Option<&str>) -> String {
    let base = match error.as_db_error() {
        Some(db) => db.message().to_owned(),
        None => error.to_string(),
    };
    match column {
        Some(c) => format!("{base} (column {c})"),
        None => base,
    }
}

/// Run the import. Returns when it is done, was cancelled or failed.
pub async fn run(
    session: &Session,
    job: &ImportJob,
    id: &str,
    request: &ImportRequest,
) -> AppResult<()> {
    let (_, size) = open(&request.path)?;
    job.lock().bytes_total = size as f64;

    let tab = format!("import:{id}");
    let client = session.tab_client(&tab).await?;
    let result = write_all(&client, job, request).await;
    // Whatever happened, the transaction does not go on.
    let _ = client.batch_execute("ROLLBACK").await;
    session.close_tab(&tab).await;
    result
}

async fn write_all(client: &Client, job: &ImportJob, request: &ImportRequest) -> AppResult<()> {
    let plan = plan(client, &request.target).await?;
    job.lock().table = Some(plan.label.clone());

    // The file is read on a thread of its own and handed over a few batches at a time.
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Vec<Row>>(3);
    let (path, format, sources) = (
        request.path.clone(),
        request.format.clone(),
        plan.sources.clone(),
    );
    let bytes = Arc::clone(&job.bytes);
    let cancel = Arc::new(AtomicBool::new(false));
    let reading = {
        let cancel = Arc::clone(&cancel);
        tokio::task::spawn_blocking(move || {
            read_file(
                &path,
                &format,
                Some(&sources),
                usize::MAX,
                BATCH_ROWS,
                &cancel,
                &bytes,
                &mut |batch| sender.blocking_send(batch).is_ok(),
            )
        })
    };

    client.batch_execute("BEGIN").await?;
    if let Some(create) = &plan.create {
        client.batch_execute(create).await?;
    }
    if plan.truncate {
        client
            .batch_execute(&format!("TRUNCATE TABLE {}", plan.relation))
            .await?;
    }

    let columns = plan
        .columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let copy = format!(
        "COPY {} ({columns}) FROM STDIN WITH (FORMAT csv)",
        plan.relation
    );
    let insert = format!(
        "INSERT INTO {} ({columns}) VALUES ({})",
        plan.relation,
        plan.types
            .iter()
            .enumerate()
            .map(|(i, t)| format!("${}::text::{t}", i + 1))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let unit = unit_of(&request.path, &request.format);
    let mut failure: Option<AppError> = None;

    while let Some(rows) = receiver.recv().await {
        if job.cancelled() {
            break;
        }
        job.lock().rows_read += rows.len() as f64;
        match write_batch(client, job, &copy, &insert, &rows, request.on_error, unit).await {
            Ok(()) => {}
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    // Stop the reader (it may be waiting to hand over a batch) and learn how it ended.
    cancel.store(true, Ordering::SeqCst);
    drop(receiver);
    let read = reading
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if let Some(e) = failure {
        return Err(e);
    }
    if job.cancelled() {
        return Ok(());
    }
    // A file that can't be read to the end (bad UTF-8, a broken record) fails the whole import.
    read?;
    client.batch_execute("COMMIT").await?;
    Ok(())
}

async fn write_batch(
    client: &Client,
    job: &ImportJob,
    copy: &str,
    insert: &str,
    rows: &[Row],
    on_error: OnError,
    unit: &'static str,
) -> AppResult<()> {
    let unit = if rows.first().is_some_and(|_| unit == "item") {
        "item"
    } else {
        "line"
    };
    client.batch_execute("SAVEPOINT batch").await?;
    let (bytes, lines) = to_copy_bytes(rows);
    let attempt = async {
        let sink = client.copy_in::<_, Bytes>(copy).await?;
        let mut sink = std::pin::pin!(sink);
        sink.send(bytes).await?;
        sink.finish().await
    }
    .await;
    match attempt {
        Ok(written) => {
            client.batch_execute("RELEASE SAVEPOINT batch").await?;
            job.lock().rows_written += written as f64;
            Ok(())
        }
        Err(e) => {
            client.batch_execute("ROLLBACK TO SAVEPOINT batch").await?;
            client.batch_execute("RELEASE SAVEPOINT batch").await?;
            let position = e
                .as_db_error()
                .and_then(|db| db.where_())
                .and_then(copy_position);
            let Some((line, column)) = position else {
                return Err(e.into()); // nothing to do with one row: permissions, a missing table…
            };
            let message = message_of(&e, column.as_deref());
            match on_error {
                OnError::Abort => {
                    let at = row_of_line(&lines, line).map_or(0, |i| rows[i].at);
                    job.error_at(format!("{unit} {at}"), message.clone());
                    Err(invalid(format!("{} {at}: {message}", capitalise(unit))))
                }
                OnError::Skip => write_rows_one_by_one(client, job, insert, rows, unit).await,
            }
        }
    }
}

/// What a place in the file is called: a line, or (a JSON array) an item.
fn unit_of(path: &str, format: &ImportFormat) -> &'static str {
    if matches!(format, ImportFormat::Json)
        && let Ok(mut file) = File::open(path)
    {
        let mut head = [0u8; 4096];
        let n = file.read(&mut head).unwrap_or(0);
        let text = head[..n]
            .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
            .unwrap_or(&head[..n]);
        if text.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'[') {
            return "item";
        }
    }
    "line"
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// A batch that had a bad row, written row by row: each in its own savepoint, so the bad ones
/// can be listed and the rest kept.
async fn write_rows_one_by_one(
    client: &Client,
    job: &ImportJob,
    insert: &str,
    rows: &[Row],
    unit: &'static str,
) -> AppResult<()> {
    let width = rows.first().map_or(0, |r| r.cells.len());
    let statement = client
        .prepare_typed(insert, &vec![Type::TEXT; width])
        .await?;
    for row in rows {
        if job.cancelled() {
            return Ok(());
        }
        client.batch_execute("SAVEPOINT one_row").await?;
        let params: Vec<&(dyn ToSql + Sync)> =
            row.cells.iter().map(|c| c as &(dyn ToSql + Sync)).collect();
        match client.execute(&statement, &params).await {
            Ok(_) => {
                client.batch_execute("RELEASE SAVEPOINT one_row").await?;
                job.lock().rows_written += 1.0;
            }
            Err(e) => {
                client
                    .batch_execute("ROLLBACK TO SAVEPOINT one_row")
                    .await?;
                client.batch_execute("RELEASE SAVEPOINT one_row").await?;
                if e.as_db_error().is_none() {
                    return Err(e.into()); // the connection, not the row
                }
                job.error_at(format!("{unit} {}", row.at), message_of(&e, None));
                job.lock().rows_skipped += 1.0;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(cells: &[&[Option<&str>]]) -> Vec<Row> {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| Row {
                at: i as u64 + 2,
                cells: c.iter().map(|v| v.map(str::to_owned)).collect(),
            })
            .collect()
    }

    #[test]
    fn copy_bytes_quote_what_needs_it_and_keep_null_apart_from_empty() {
        let batch = rows(&[
            &[Some("plain"), Some("a,b"), None],
            &[Some("say \"hi\""), Some(""), Some("two\nlines")],
        ]);
        let (bytes, lines) = to_copy_bytes(&batch);
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            "plain,\"a,b\",\n\"say \"\"hi\"\"\",\"\",\"two\nlines\"\n"
        );
        assert_eq!(lines, [1, 2]);
    }

    #[test]
    fn a_copy_line_number_points_at_the_row_it_is_in() {
        // Row 0 takes a line, row 1 takes three (line breaks in a value), row 2 takes one.
        let lines = [1, 3, 1];
        assert_eq!(row_of_line(&lines, 1), Some(0));
        assert_eq!(row_of_line(&lines, 2), Some(1));
        assert_eq!(row_of_line(&lines, 4), Some(1));
        assert_eq!(row_of_line(&lines, 5), Some(2));
        assert_eq!(row_of_line(&lines, 6), None);
    }

    #[test]
    fn the_position_in_a_copy_error_is_read() {
        assert_eq!(
            copy_position("COPY users, line 3, column qty: \"abc\""),
            Some((3, Some("qty".to_owned())))
        );
        assert_eq!(copy_position("COPY users, line 12"), Some((12, None)));
        assert_eq!(copy_position("something else"), None);
    }

    #[test]
    fn names_are_unique_and_never_empty() {
        let names = unique_names(vec![
            "id".into(),
            " ".into(),
            "id".into(),
            "name ".into(),
            "id".into(),
        ]);
        assert_eq!(names, ["id", "column_2", "id_2", "name", "id_3"]);
    }

    #[test]
    fn json_values_become_cells() {
        use serde_json::json;
        assert_eq!(json_cell(&json!(null)), None);
        assert_eq!(json_cell(&json!("text")), Some("text".into()));
        assert_eq!(json_cell(&json!(12.5)), Some("12.5".into()));
        assert_eq!(json_cell(&json!(true)), Some("true".into()));
        assert_eq!(
            json_cell(&json!({"a": [1, 2]})),
            Some("{\"a\":[1,2]}".into())
        );
    }
}
