//! How rows are written in each export format (ANG-45). Pure: bytes in a buffer, no I/O.
//!
//! Cells arrive as the server prints them (text), `None` for `NULL`. The column's type decides
//! whether JSON and SQL write a number, a boolean, nested JSON or a string.

use tokio_postgres::types::Type;

use crate::db::rows::quote_ident;
use crate::db::structure::literal;
use crate::error::{AppError, AppResult};
use crate::models::export::{CsvOptions, ExportFormat};

/// How a value of a column is written where types matter (JSON, SQL).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Number,
    Bool,
    Json,
    Text,
}

pub fn kind_of(ty: &Type) -> Kind {
    match *ty {
        Type::INT2
        | Type::INT4
        | Type::INT8
        | Type::OID
        | Type::FLOAT4
        | Type::FLOAT8
        | Type::NUMERIC => Kind::Number,
        Type::BOOL => Kind::Bool,
        Type::JSON | Type::JSONB => Kind::Json,
        _ => Kind::Text,
    }
}

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    pub kind: Kind,
}

pub enum RowWriter {
    Csv(Csv),
    Json(Json),
    Sql(Sql),
    Markdown(Markdown),
}

impl RowWriter {
    /// `table` is what `INSERT` statements insert into (already quoted).
    pub fn new(format: &ExportFormat, columns: Vec<Column>, table: String) -> AppResult<Self> {
        Ok(match format {
            ExportFormat::Csv(options) => Self::Csv(Csv::new(options, columns)?),
            ExportFormat::Json { ndjson } => Self::Json(Json::new(*ndjson, columns)),
            ExportFormat::Sql { batch_size } => Self::Sql(Sql::new(*batch_size, columns, table)),
            ExportFormat::Markdown => Self::Markdown(Markdown { columns }),
        })
    }

    /// What comes before the first row.
    pub fn begin(&mut self, out: &mut Vec<u8>) {
        match self {
            Self::Csv(w) => w.begin(out),
            Self::Json(w) => w.begin(out),
            Self::Sql(_) => {}
            Self::Markdown(w) => w.begin(out),
        }
    }

    pub fn row(&mut self, cells: &[Option<&str>], out: &mut Vec<u8>) {
        match self {
            Self::Csv(w) => w.row(cells, out),
            Self::Json(w) => w.row(cells, out),
            Self::Sql(w) => w.row(cells, out),
            Self::Markdown(w) => w.row(cells, out),
        }
    }

    /// What comes after the last row.
    pub fn end(&mut self, out: &mut Vec<u8>) {
        match self {
            Self::Csv(_) | Self::Markdown(_) => {}
            Self::Json(w) => w.end(out),
            Self::Sql(w) => w.end(out),
        }
    }

    /// The file extension for the format.
    pub fn extension(format: &ExportFormat) -> &'static str {
        match format {
            ExportFormat::Csv(o) if o.delimiter == "\t" => "tsv",
            ExportFormat::Csv(_) => "csv",
            ExportFormat::Json { ndjson: true } => "ndjson",
            ExportFormat::Json { ndjson: false } => "json",
            ExportFormat::Sql { .. } => "sql",
            ExportFormat::Markdown => "md",
        }
    }
}

// ---- CSV -------------------------------------------------------------------------------------

pub struct Csv {
    delimiter: char,
    quote: char,
    header: bool,
    null_text: String,
    columns: Vec<Column>,
}

fn one_char(text: &str, what: &str) -> AppResult<char> {
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c != '\n' && c != '\r' => Ok(c),
        _ => Err(AppError::Validation(format!(
            "The {what} is one character (not a line break)."
        ))),
    }
}

impl Csv {
    fn new(options: &CsvOptions, columns: Vec<Column>) -> AppResult<Self> {
        let delimiter = one_char(&options.delimiter, "delimiter")?;
        let quote = one_char(&options.quote, "quote character")?;
        if delimiter == quote {
            return Err(AppError::Validation(
                "The delimiter and the quote character must differ.".into(),
            ));
        }
        Ok(Self {
            delimiter,
            quote,
            header: options.header,
            null_text: options.null_text.clone(),
            columns,
        })
    }

    fn push(&self, value: &str, out: &mut Vec<u8>, force_quote: bool) {
        let needs = force_quote
            || value
                .chars()
                .any(|c| c == self.delimiter || c == self.quote || c == '\n' || c == '\r');
        if !needs {
            out.extend_from_slice(value.as_bytes());
            return;
        }
        let mut buf = [0u8; 4];
        let quote = self.quote.encode_utf8(&mut buf).as_bytes().to_vec();
        out.extend_from_slice(&quote);
        for c in value.chars() {
            if c == self.quote {
                out.extend_from_slice(&quote);
            }
            let mut b = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
        }
        out.extend_from_slice(&quote);
    }

    fn line<'a>(&self, cells: impl Iterator<Item = Option<&'a str>>, out: &mut Vec<u8>) {
        let mut delimiter = [0u8; 4];
        let delimiter = self
            .delimiter
            .encode_utf8(&mut delimiter)
            .as_bytes()
            .to_vec();
        for (i, cell) in cells.enumerate() {
            if i > 0 {
                out.extend_from_slice(&delimiter);
            }
            match cell {
                None => out.extend_from_slice(self.null_text.as_bytes()),
                // Nothing for NULL means an empty text has to be told apart by its quotes.
                Some(value) => self.push(value, out, value.is_empty() && self.null_text.is_empty()),
            }
        }
        out.push(b'\n');
    }

    fn begin(&self, out: &mut Vec<u8>) {
        if self.header {
            self.line(self.columns.iter().map(|c| Some(c.name.as_str())), out);
        }
    }

    fn row(&self, cells: &[Option<&str>], out: &mut Vec<u8>) {
        self.line(cells.iter().copied(), out);
    }
}

// ---- JSON ------------------------------------------------------------------------------------

pub struct Json {
    ndjson: bool,
    keys: Vec<String>,
    kinds: Vec<Kind>,
    first: bool,
}

/// Column names that are unique: a second `id` becomes `id_2`.
fn unique_names(columns: &[Column]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    columns
        .iter()
        .map(|c| {
            let mut name = c.name.clone();
            let mut n = 1;
            while seen.contains(&name) {
                n += 1;
                name = format!("{}_{n}", c.name);
            }
            seen.push(name.clone());
            name
        })
        .collect()
}

/// `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`: what JSON accepts as a number, and also plain SQL.
fn is_plain_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'-') {
        i += 1;
    }
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int = digits(i);
    if int == 0 || (int > 1 && bytes[i] == b'0') {
        return false;
    }
    i += int;
    if bytes.get(i) == Some(&b'.') {
        let frac = digits(i + 1);
        if frac == 0 {
            return false;
        }
        i += 1 + frac;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == bytes.len()
}

fn json_string(text: &str, out: &mut Vec<u8>) {
    // A `&str` always serialises.
    out.extend_from_slice(
        serde_json::to_string(text)
            .unwrap_or_else(|_| "\"\"".into())
            .as_bytes(),
    );
}

fn json_value(kind: Kind, cell: Option<&str>, out: &mut Vec<u8>) {
    let Some(text) = cell else {
        out.extend_from_slice(b"null");
        return;
    };
    match kind {
        Kind::Number if is_plain_number(text) => out.extend_from_slice(text.as_bytes()),
        Kind::Bool if text == "t" => out.extend_from_slice(b"true"),
        Kind::Bool if text == "f" => out.extend_from_slice(b"false"),
        Kind::Json => {
            // A line break inside would break a line of NDJSON: write it compactly then.
            if text.contains(['\n', '\r']) {
                match serde_json::from_str::<serde_json::Value>(text) {
                    Ok(value) => out.extend_from_slice(value.to_string().as_bytes()),
                    Err(_) => json_string(text, out),
                }
            } else if text.is_empty() {
                json_string(text, out);
            } else {
                out.extend_from_slice(text.as_bytes());
            }
        }
        // `NaN`, `Infinity`, an unknown boolean, anything else: as text, so no value is lost.
        _ => json_string(text, out),
    }
}

impl Json {
    fn new(ndjson: bool, columns: Vec<Column>) -> Self {
        Self {
            ndjson,
            keys: unique_names(&columns),
            kinds: columns.iter().map(|c| c.kind).collect(),
            first: true,
        }
    }

    fn begin(&self, out: &mut Vec<u8>) {
        if !self.ndjson {
            out.extend_from_slice(b"[");
        }
    }

    fn row(&mut self, cells: &[Option<&str>], out: &mut Vec<u8>) {
        if self.ndjson {
            self.object(cells, out);
            out.push(b'\n');
        } else {
            out.extend_from_slice(if self.first { b"\n  " } else { b",\n  " });
            self.object(cells, out);
        }
        self.first = false;
    }

    fn object(&self, cells: &[Option<&str>], out: &mut Vec<u8>) {
        out.push(b'{');
        for (i, key) in self.keys.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            json_string(key, out);
            out.push(b':');
            json_value(self.kinds[i], cells.get(i).copied().flatten(), out);
        }
        out.push(b'}');
    }

    fn end(&self, out: &mut Vec<u8>) {
        if !self.ndjson {
            out.extend_from_slice(if self.first { b"]\n" } else { b"\n]\n" });
        }
    }
}

// ---- SQL INSERT ------------------------------------------------------------------------------

pub struct Sql {
    batch: u32,
    table: String,
    names: String,
    kinds: Vec<Kind>,
    in_batch: u32,
}

fn sql_value(kind: Kind, cell: Option<&str>, out: &mut Vec<u8>) {
    let Some(text) = cell else {
        out.extend_from_slice(b"NULL");
        return;
    };
    match kind {
        Kind::Number if is_plain_number(text) => out.extend_from_slice(text.as_bytes()),
        Kind::Bool if text == "t" => out.extend_from_slice(b"true"),
        Kind::Bool if text == "f" => out.extend_from_slice(b"false"),
        // `'NaN'` and `'Infinity'` are accepted by the numeric types, in quotes.
        _ => out.extend_from_slice(literal(text).as_bytes()),
    }
}

impl Sql {
    fn new(batch: u32, columns: Vec<Column>, table: String) -> Self {
        Self {
            batch: batch.clamp(1, 10_000),
            table,
            names: columns
                .iter()
                .map(|c| quote_ident(&c.name))
                .collect::<Vec<_>>()
                .join(", "),
            kinds: columns.iter().map(|c| c.kind).collect(),
            in_batch: 0,
        }
    }

    fn row(&mut self, cells: &[Option<&str>], out: &mut Vec<u8>) {
        if self.in_batch == 0 {
            out.extend_from_slice(
                format!("INSERT INTO {} ({}) VALUES\n  (", self.table, self.names).as_bytes(),
            );
        } else {
            out.extend_from_slice(b",\n  (");
        }
        for (i, kind) in self.kinds.iter().enumerate() {
            if i > 0 {
                out.extend_from_slice(b", ");
            }
            sql_value(*kind, cells.get(i).copied().flatten(), out);
        }
        out.push(b')');
        self.in_batch += 1;
        if self.in_batch >= self.batch {
            out.extend_from_slice(b";\n");
            self.in_batch = 0;
        }
    }

    fn end(&mut self, out: &mut Vec<u8>) {
        if self.in_batch > 0 {
            out.extend_from_slice(b";\n");
            self.in_batch = 0;
        }
    }
}

// ---- Markdown --------------------------------------------------------------------------------

pub struct Markdown {
    columns: Vec<Column>,
}

fn markdown_cell(text: &str, out: &mut Vec<u8>) {
    for c in text.chars() {
        match c {
            '|' => out.extend_from_slice(b"\\|"),
            '\n' => out.extend_from_slice(b"<br>"),
            '\r' => {}
            other => {
                let mut b = [0u8; 4];
                out.extend_from_slice(other.encode_utf8(&mut b).as_bytes());
            }
        }
    }
}

impl Markdown {
    fn begin(&self, out: &mut Vec<u8>) {
        out.push(b'|');
        for c in &self.columns {
            out.push(b' ');
            markdown_cell(&c.name, out);
            out.extend_from_slice(b" |");
        }
        out.extend_from_slice(b"\n|");
        for _ in &self.columns {
            out.extend_from_slice(b" --- |");
        }
        out.push(b'\n');
    }

    fn row(&self, cells: &[Option<&str>], out: &mut Vec<u8>) {
        out.push(b'|');
        for i in 0..self.columns.len() {
            out.push(b' ');
            if let Some(Some(text)) = cells.get(i) {
                markdown_cell(text, out);
            }
            out.extend_from_slice(b" |");
        }
        out.push(b'\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(spec: &[(&str, Kind)]) -> Vec<Column> {
        spec.iter()
            .map(|(name, kind)| Column {
                name: (*name).into(),
                kind: *kind,
            })
            .collect()
    }

    fn render(format: &ExportFormat, columns: Vec<Column>, rows: &[&[Option<&str>]]) -> String {
        let mut writer = RowWriter::new(format, columns, "\"public\".\"t\"".into()).unwrap();
        let mut out = Vec::new();
        writer.begin(&mut out);
        for row in rows {
            writer.row(row, &mut out);
        }
        writer.end(&mut out);
        String::from_utf8(out).unwrap()
    }

    fn csv(delimiter: &str, quote: &str, header: bool, null_text: &str) -> ExportFormat {
        ExportFormat::Csv(CsvOptions {
            delimiter: delimiter.into(),
            quote: quote.into(),
            header,
            null_text: null_text.into(),
        })
    }

    #[test]
    fn csv_quotes_what_needs_it_and_tells_null_from_empty() {
        let columns = cols(&[("a", Kind::Text), ("b", Kind::Text)]);
        let out = render(
            &csv(",", "\"", true, ""),
            columns.clone(),
            &[
                &[Some("plain"), Some("with, comma")],
                &[Some("say \"hi\""), Some("two\nlines")],
                &[None, Some("")],
                &[Some(" padded "), Some("é ü 日本")],
            ],
        );
        assert_eq!(
            out,
            "a,b\nplain,\"with, comma\"\n\"say \"\"hi\"\"\",\"two\nlines\"\n,\"\"\n padded ,é ü 日本\n"
        );
        // With a text for NULL the empty text needs no quotes.
        let marked = render(
            &csv(";", "'", false, "\\N"),
            columns,
            &[&[None, Some("")], &[Some("it's"), Some("a;b")]],
        );
        assert_eq!(marked, "\\N;\n'it''s';'a;b'\n");
    }

    #[test]
    fn csv_options_are_checked() {
        let columns = || cols(&[("a", Kind::Text)]);
        for (d, q) in [
            ("", "\""),
            (",,", "\""),
            (",", ""),
            (",", ","),
            ("\n", "\""),
        ] {
            assert!(
                RowWriter::new(&csv(d, q, true, ""), columns(), String::new()).is_err(),
                "{d:?} {q:?}"
            );
        }
        assert!(RowWriter::new(&csv("\t", "\"", true, ""), columns(), String::new()).is_ok());
    }

    #[test]
    fn json_writes_numbers_booleans_nested_json_and_everything_else_as_strings() {
        let columns = cols(&[
            ("id", Kind::Number),
            ("ok", Kind::Bool),
            ("meta", Kind::Json),
            ("note", Kind::Text),
            ("score", Kind::Number),
        ]);
        let rows: &[&[Option<&str>]] = &[
            &[
                Some("1"),
                Some("t"),
                Some("{\"a\": [1, 2]}"),
                Some("say \"hi\"\n\\"),
                Some("-1.50"),
            ],
            &[Some("2"), Some("f"), None, None, Some("NaN")],
            &[
                Some("3"),
                Some("x"),
                Some("{\n \"k\": 1\n}"),
                Some("é"),
                Some("1e+20"),
            ],
        ];
        let array = render(&ExportFormat::Json { ndjson: false }, columns.clone(), rows);
        let parsed: serde_json::Value = serde_json::from_str(&array).unwrap();
        assert_eq!(parsed[0]["id"], 1);
        assert_eq!(parsed[0]["ok"], true);
        assert_eq!(parsed[0]["meta"]["a"][1], 2);
        assert_eq!(parsed[0]["note"], "say \"hi\"\n\\");
        assert_eq!(parsed[0]["score"], -1.5);
        assert_eq!(parsed[1]["ok"], false);
        assert!(parsed[1]["meta"].is_null() && parsed[1]["note"].is_null());
        assert_eq!(parsed[1]["score"], "NaN"); // not a JSON number
        assert_eq!(parsed[2]["ok"], "x");
        assert_eq!(parsed[2]["meta"]["k"], 1);
        assert_eq!(parsed[2]["score"], 1e20);

        let lines = render(&ExportFormat::Json { ndjson: true }, columns, rows);
        assert_eq!(lines.lines().count(), 3, "one line per row: {lines}");
        for (i, line) in lines.lines().enumerate() {
            let one: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(one, parsed[i]);
        }
    }

    #[test]
    fn json_with_no_rows_is_an_empty_array_and_duplicate_columns_get_suffixes() {
        let columns = cols(&[
            ("id", Kind::Number),
            ("id", Kind::Number),
            ("id", Kind::Text),
        ]);
        assert_eq!(
            render(&ExportFormat::Json { ndjson: false }, columns.clone(), &[]),
            "[]\n"
        );
        assert_eq!(
            render(&ExportFormat::Json { ndjson: true }, columns.clone(), &[]),
            ""
        );
        let one = render(
            &ExportFormat::Json { ndjson: true },
            columns,
            &[&[Some("1"), Some("2"), Some("3")]],
        );
        assert_eq!(one, "{\"id\":1,\"id_2\":2,\"id_3\":\"3\"}\n");
    }

    #[test]
    fn json_numbers_follow_the_json_grammar() {
        for good in ["0", "-0", "12", "-1.5", "0.001", "1e5", "1E+5", "2.5e-10"] {
            assert!(is_plain_number(good), "{good}");
        }
        for bad in [
            "",
            "-",
            "+1",
            "01",
            "1.",
            ".5",
            "1e",
            "1e+",
            "NaN",
            "Infinity",
            "-Infinity",
            "1 ",
            "0x10",
        ] {
            assert!(!is_plain_number(bad), "{bad}");
        }
    }

    #[test]
    fn sql_inserts_are_batched_and_quoted() {
        let columns = cols(&[
            ("id", Kind::Number),
            ("name", Kind::Text),
            ("ok", Kind::Bool),
            ("v", Kind::Number),
        ]);
        let rows: &[&[Option<&str>]] = &[
            &[Some("1"), Some("O'Brien"), Some("t"), Some("1.5")],
            &[Some("2"), Some("back\\slash"), Some("f"), Some("NaN")],
            &[Some("3"), None, None, None],
        ];
        let out = render(&ExportFormat::Sql { batch_size: 2 }, columns, rows);
        let head = "INSERT INTO \"public\".\"t\" (\"id\", \"name\", \"ok\", \"v\") VALUES\n";
        assert_eq!(
            out,
            format!(
                "{head}  (1, 'O''Brien', true, 1.5),\n  (2, E'back\\\\slash', false, 'NaN');\n\
                 {head}  (3, NULL, NULL, NULL);\n"
            )
        );
    }

    #[test]
    fn markdown_escapes_pipes_and_line_breaks() {
        let columns = cols(&[("a|b", Kind::Text), ("c", Kind::Text)]);
        let out = render(
            &ExportFormat::Markdown,
            columns,
            &[&[Some("x|y"), Some("l1\nl2")], &[None, Some("ok")]],
        );
        assert_eq!(
            out,
            "| a\\|b | c |\n| --- | --- |\n| x\\|y | l1<br>l2 |\n|  | ok |\n"
        );
    }

    #[test]
    fn extensions_follow_the_format() {
        assert_eq!(RowWriter::extension(&csv(",", "\"", true, "")), "csv");
        assert_eq!(RowWriter::extension(&csv("\t", "\"", true, "")), "tsv");
        assert_eq!(
            RowWriter::extension(&ExportFormat::Json { ndjson: true }),
            "ndjson"
        );
        assert_eq!(
            RowWriter::extension(&ExportFormat::Json { ndjson: false }),
            "json"
        );
        assert_eq!(
            RowWriter::extension(&ExportFormat::Sql { batch_size: 1 }),
            "sql"
        );
        assert_eq!(RowWriter::extension(&ExportFormat::Markdown), "md");
    }
}
