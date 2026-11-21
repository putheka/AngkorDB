//! Read the rows of a table or view: paging, sorting, filtering, counting (ANG-16, ANG-8 D4/D5).
//!
//! The SQL is built here and nowhere else, under one rule: **nothing from the user is ever
//! pasted into it as a value.**
//!
//! - Identifiers (schema, table, columns) are looked up in the catalog first (`describe_table`),
//!   so an unknown name is rejected, then quoted with `"…"` (a `"` inside is doubled).
//! - Filter values are bound parameters sent as `text` and cast on the server:
//!   `$1::text::numeric`. The cast type comes from the catalog, never from the caller.
//! - `LIMIT` / `OFFSET` are integers.
//! - The one exception is `raw_where`, SQL the user typed on purpose. It runs inside a read-only
//!   transaction, and the extended protocol refuses a second statement.
//!
//! Every column is selected as `"col"::text` and decoded as `Option<String>`: one code path
//! for every type, and values such as `bigint` above 2^53 or `numeric` reach the UI exactly.

use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{Client, Row};

use crate::db::introspect;
use crate::error::{AppError, AppResult};
use crate::models::rows::{
    Filter, FilterOp, LimitedCount, ResultColumn, RowCount, RowPage, RowQuery, SortDir, SortSpec,
};
use crate::models::schema::{ColumnInfo, ObjectKind, RowIdentity, TableDescription};

pub const MAX_LIMIT: u32 = 10_000;

/// A statement and the values bound to `$1`, `$2`, … (all sent as `text`).
#[derive(Debug, PartialEq, Eq)]
pub struct BuiltSql {
    pub sql: String,
    pub params: Vec<String>,
    /// The statement contains user-typed SQL, so it must run in a read-only transaction.
    pub has_raw_sql: bool,
}

/// `"name"` with any `"` doubled.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn relation(desc: &TableDescription) -> String {
    format!("{}.{}", quote_ident(&desc.schema), quote_ident(&desc.name))
}

pub fn find_column<'a>(desc: &'a TableDescription, name: &str) -> AppResult<&'a ColumnInfo> {
    desc.columns
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| AppError::Validation(format!("{} has no column \"{name}\"", desc.name)))
}

/// Bind `value` and return its placeholder cast to the column's type.
fn bind(params: &mut Vec<String>, value: &str, column: &ColumnInfo) -> String {
    params.push(value.to_owned());
    format!("${}::text::{}", params.len(), column.base_type)
}

fn condition(
    desc: &TableDescription,
    filter: &Filter,
    params: &mut Vec<String>,
) -> AppResult<String> {
    let column = find_column(desc, &filter.column)?;
    let name = quote_ident(&column.name);
    let values = &filter.values;

    let (min, max) = match filter.op {
        FilterOp::IsNull | FilterOp::IsNotNull => (0, 0),
        FilterOp::Between => (2, 2),
        FilterOp::In => (1, usize::MAX),
        _ => (1, 1),
    };
    if values.len() < min || values.len() > max {
        return Err(AppError::Validation(format!(
            "filter on \"{}\" needs {} value(s), got {}",
            column.name,
            if min == max {
                min.to_string()
            } else {
                format!("at least {min}")
            },
            values.len()
        )));
    }

    let compare = |params: &mut Vec<String>, operator: &str| {
        format!("{name} {operator} {}", bind(params, &values[0], column))
    };
    Ok(match filter.op {
        FilterOp::Eq => compare(params, "="),
        FilterOp::Ne => compare(params, "<>"),
        FilterOp::Lt => compare(params, "<"),
        FilterOp::Gt => compare(params, ">"),
        FilterOp::Le => compare(params, "<="),
        FilterOp::Ge => compare(params, ">="),
        // Pattern matching works on text, whatever the column's type.
        FilterOp::Like | FilterOp::ILike => {
            params.push(values[0].clone());
            let keyword = if filter.op == FilterOp::Like {
                "LIKE"
            } else {
                "ILIKE"
            };
            format!("{name}::text {keyword} ${}::text", params.len())
        }
        FilterOp::In => {
            let list: Vec<String> = values.iter().map(|v| bind(params, v, column)).collect();
            format!("{name} IN ({})", list.join(", "))
        }
        FilterOp::Between => {
            let low = bind(params, &values[0], column);
            let high = bind(params, &values[1], column);
            format!("{name} BETWEEN {low} AND {high}")
        }
        FilterOp::IsNull => format!("{name} IS NULL"),
        FilterOp::IsNotNull => format!("{name} IS NOT NULL"),
    })
}

/// The user's `WHERE` text, without a leading `WHERE` or trailing `;`. `None` when blank.
fn clean_raw_where(raw: Option<&str>) -> Option<String> {
    let mut text = raw?.trim().trim_end_matches(';').trim();
    if text.len() >= 5
        && text.is_char_boundary(5)
        && text[..5].eq_ignore_ascii_case("where")
        && text[5..].starts_with(char::is_whitespace)
    {
        text = text[5..].trim();
    }
    (!text.is_empty()).then(|| text.to_owned())
}

/// `""` or `" WHERE a AND b"`.
fn where_clause(
    desc: &TableDescription,
    filters: &[Filter],
    raw_where: Option<&str>,
    params: &mut Vec<String>,
) -> AppResult<(String, bool)> {
    let mut parts = Vec::new();
    for filter in filters {
        parts.push(condition(desc, filter, params)?);
    }
    let raw = clean_raw_where(raw_where);
    if let Some(raw) = &raw {
        // The newline keeps a trailing `-- comment` from swallowing the closing parenthesis.
        parts.push(format!("({raw}\n)"));
    }
    let clause = if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    };
    Ok((clause, raw.is_some()))
}

/// Alias for the table in `SELECT`. `ORDER BY "id"` alone would sort by the *output* column
/// `"id"::text` (text order: 1, 10, 100…); `ORDER BY "_t"."id"` sorts by the real column.
const ALIAS: &str = "\"_t\"";

/// User sort first, then the identity columns so that paging stays stable. Tables identified by
/// `ctid` get no tiebreaker: sorting 1M rows by `ctid` costs more than it is worth.
fn order_by(desc: &TableDescription, sort: &[SortSpec]) -> AppResult<String> {
    let mut parts = Vec::new();
    for spec in sort {
        let column = find_column(desc, &spec.column)?;
        let dir = match spec.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        parts.push(format!("{ALIAS}.{} {dir}", quote_ident(&column.name)));
    }
    if let RowIdentity::PrimaryKey { columns } | RowIdentity::UniqueIndex { columns } =
        &desc.identity
    {
        for name in columns {
            if !sort.iter().any(|s| &s.column == name) {
                parts.push(format!("{ALIAS}.{}", quote_ident(name)));
            }
        }
    }
    Ok(if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    })
}

/// The `SELECT` for one page. Asks for one row more than `limit` to learn whether there is
/// another page.
pub fn build_select(desc: &TableDescription, query: &RowQuery) -> AppResult<BuiltSql> {
    let mut params = Vec::new();
    let mut select: Vec<String> = desc
        .columns
        .iter()
        .map(|c| format!("{}::text", quote_ident(&c.name)))
        .collect();
    if desc.identity == RowIdentity::Ctid {
        select.push("ctid::text".to_owned());
    }
    let (where_sql, has_raw_sql) = where_clause(
        desc,
        &query.filters,
        query.raw_where.as_deref(),
        &mut params,
    )?;
    let limit = query.limit.clamp(1, MAX_LIMIT);
    Ok(BuiltSql {
        sql: format!(
            "SELECT {} FROM {} AS {ALIAS}{where_sql}{} LIMIT {} OFFSET {}",
            select.join(", "),
            relation(desc),
            order_by(desc, &query.sort)?,
            limit + 1,
            query.offset
        ),
        params,
        has_raw_sql,
    })
}

/// The `SELECT` of an export: every column, the filters and the sort the person chose, no
/// paging. Without a sort the rows come as the table has them (no key order: it would make a
/// big table slower for nothing).
pub fn build_export_select(
    desc: &TableDescription,
    filters: &[Filter],
    raw_where: Option<&str>,
    sort: &[SortSpec],
) -> AppResult<BuiltSql> {
    let mut params = Vec::new();
    let select: Vec<String> = desc.columns.iter().map(|c| quote_ident(&c.name)).collect();
    let (where_sql, has_raw_sql) = where_clause(desc, filters, raw_where, &mut params)?;
    let mut order = Vec::new();
    for spec in sort {
        let column = find_column(desc, &spec.column)?;
        let dir = match spec.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        order.push(format!("{ALIAS}.{} {dir}", quote_ident(&column.name)));
    }
    let order_sql = if order.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order.join(", "))
    };
    Ok(BuiltSql {
        sql: format!(
            "SELECT {} FROM {} AS {ALIAS}{where_sql}{order_sql}",
            select.join(", "),
            relation(desc)
        ),
        params,
        has_raw_sql,
    })
}

pub fn build_count(
    desc: &TableDescription,
    filters: &[Filter],
    raw_where: Option<&str>,
) -> AppResult<BuiltSql> {
    let mut params = Vec::new();
    let (where_sql, has_raw_sql) = where_clause(desc, filters, raw_where, &mut params)?;
    Ok(BuiltSql {
        sql: format!("SELECT count(*) FROM {}{where_sql}", relation(desc)),
        params,
        has_raw_sql,
    })
}

async fn run(client: &Client, built: &BuiltSql) -> AppResult<Vec<Row>> {
    let params: Vec<(&(dyn ToSql + Sync), Type)> = built
        .params
        .iter()
        .map(|value| (value as &(dyn ToSql + Sync), Type::TEXT))
        .collect();
    if built.has_raw_sql {
        client.batch_execute("BEGIN READ ONLY").await?;
    }
    let result = client.query_typed(&built.sql, &params).await;
    if built.has_raw_sql {
        // Also after an error: a failed transaction must not leak back into the pool.
        let _ = client.batch_execute("ROLLBACK").await;
    }
    Ok(result?)
}

/// One page of rows, with the column types and how rows are identified.
pub async fn fetch_rows(client: &Client, query: &RowQuery) -> AppResult<RowPage> {
    let desc = introspect::describe_table(client, &query.schema, &query.table).await?;
    let built = build_select(&desc, query)?;
    let mut rows = run(client, &built).await?;

    let limit = query.limit.clamp(1, MAX_LIMIT) as usize;
    let has_more = rows.len() > limit;
    rows.truncate(limit);

    let width = desc.columns.len();
    let uses_ctid = desc.identity == RowIdentity::Ctid;
    let mut cells = Vec::with_capacity(rows.len());
    let mut ctids = Vec::new();
    for row in &rows {
        cells.push(
            (0..width)
                .map(|i| row.try_get::<_, Option<String>>(i))
                .collect::<Result<Vec<_>, _>>()?,
        );
        if uses_ctid {
            ctids.push(row.try_get::<_, String>(width)?);
        }
    }

    Ok(RowPage {
        columns: desc
            .columns
            .iter()
            .map(|c| ResultColumn {
                name: c.name.clone(),
                type_oid: c.type_oid,
                type_name: c.type_name.clone(),
            })
            .collect(),
        rows: cells,
        identity: desc.identity,
        ctids,
        has_more,
    })
}

/// Row count of a table. Without filters and when `exact` is `false`, this is the planner's
/// estimate and costs nothing, even on a huge table; in every other case it is `count(*)`,
/// which scans the table.
pub async fn count_rows(
    client: &Client,
    schema: &str,
    table: &str,
    filters: &[Filter],
    raw_where: Option<&str>,
    exact: bool,
) -> AppResult<RowCount> {
    let desc = introspect::describe_table(client, schema, table).await?;
    let built = build_count(&desc, filters, raw_where)?;

    let unfiltered = filters.is_empty() && !built.has_raw_sql;
    if unfiltered
        && !exact
        && !matches!(desc.kind, ObjectKind::View | ObjectKind::MaterializedView)
        && let Some(estimate) = estimate(client, schema, table).await?
    {
        return Ok(RowCount {
            count: estimate,
            exact: false,
        });
    }

    let rows = run(client, &built).await?;
    let count: i64 = rows
        .first()
        .ok_or_else(|| AppError::Internal("count(*) returned no row".into()))?
        .try_get(0)?;
    Ok(RowCount {
        count: count as f64,
        exact: true,
    })
}

/// How many rows match `filters`, counting at most `cap`: `SELECT count(*) FROM (… LIMIT cap+1)`.
/// "Referenced by" uses it for every referencing table of a row, so it must stay cheap even when
/// a table has no index on the key.
pub async fn count_matching(
    client: &Client,
    schema: &str,
    table: &str,
    filters: &[Filter],
    cap: u32,
) -> AppResult<LimitedCount> {
    let desc = introspect::describe_table(client, schema, table).await?;
    let mut params = Vec::new();
    let (where_sql, _) = where_clause(&desc, filters, None, &mut params)?;
    let cap = cap.clamp(1, MAX_LIMIT);
    let built = BuiltSql {
        sql: format!(
            "SELECT count(*) FROM (SELECT 1 FROM {}{where_sql} LIMIT {}) AS _t",
            relation(&desc),
            cap + 1
        ),
        params,
        has_raw_sql: false,
    };
    let rows = run(client, &built).await?;
    let found: i64 = rows
        .first()
        .ok_or_else(|| AppError::Internal("count(*) returned no row".into()))?
        .try_get(0)?;
    let found = u32::try_from(found).unwrap_or(u32::MAX);
    Ok(LimitedCount {
        count: found.min(cap),
        capped: found > cap,
    })
}

/// `reltuples`, unless it says "never analyzed" (`-1`) or "empty" (`0`, which is cheap to
/// confirm with a real count).
async fn estimate(client: &Client, schema: &str, table: &str) -> AppResult<Option<f64>> {
    let row = client
        .query_opt(
            "SELECT c.reltuples::float8
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await?;
    Ok(row
        .map(|r| r.get::<_, f64>(0))
        .filter(|estimate| *estimate > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, base_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            position: 1,
            type_name: base_type.into(),
            base_type: base_type.into(),
            type_oid: 0,
            nullable: true,
            default_value: None,
            identity: None,
            generated: false,
            is_primary_key: false,
            comment: None,
            foreign_keys: Vec::new(),
        }
    }

    fn table(identity: RowIdentity) -> TableDescription {
        TableDescription {
            schema: "public".into(),
            name: "users".into(),
            kind: ObjectKind::Table,
            comment: None,
            columns: vec![
                column("id", "bigint"),
                column("na\"me", "text"),
                column("born", "date"),
            ],
            identity,
        }
    }

    fn pk() -> RowIdentity {
        RowIdentity::PrimaryKey {
            columns: vec!["id".into()],
        }
    }

    fn query() -> RowQuery {
        RowQuery {
            schema: "public".into(),
            table: "users".into(),
            limit: 100,
            offset: 0,
            sort: vec![],
            filters: vec![],
            raw_where: None,
        }
    }

    fn filter(column: &str, op: FilterOp, values: &[&str]) -> Filter {
        Filter {
            column: column.into(),
            op,
            values: values.iter().map(|v| (*v).to_owned()).collect(),
        }
    }

    #[test]
    fn identifiers_are_quoted_and_quotes_are_doubled() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(
            quote_ident("x\"; DROP TABLE y; --"),
            "\"x\"\"; DROP TABLE y; --\""
        );
    }

    #[test]
    fn a_plain_page_selects_every_column_as_text_ordered_by_the_key() {
        let built = build_select(&table(pk()), &query()).unwrap();
        assert_eq!(
            built.sql,
            "SELECT \"id\"::text, \"na\"\"me\"::text, \"born\"::text FROM \"public\".\"users\" AS \"_t\" \
             ORDER BY \"_t\".\"id\" LIMIT 101 OFFSET 0"
        );
        assert!(built.params.is_empty());
        assert!(!built.has_raw_sql);
    }

    #[test]
    fn user_sort_comes_first_and_the_key_breaks_ties() {
        let mut q = query();
        q.sort = vec![SortSpec {
            column: "born".into(),
            dir: SortDir::Desc,
        }];
        let sql = build_select(&table(pk()), &q).unwrap().sql;
        assert!(
            sql.contains(" ORDER BY \"_t\".\"born\" DESC, \"_t\".\"id\" LIMIT"),
            "{sql}"
        );

        // Sorting by the key itself doesn't repeat it.
        q.sort = vec![SortSpec {
            column: "id".into(),
            dir: SortDir::Asc,
        }];
        let sql = build_select(&table(pk()), &q).unwrap().sql;
        assert!(sql.contains(" ORDER BY \"_t\".\"id\" ASC LIMIT"), "{sql}");
    }

    #[test]
    fn ctid_tables_select_ctid_and_skip_the_tiebreaker() {
        let built = build_select(&table(RowIdentity::Ctid), &query()).unwrap();
        assert!(built.sql.contains(", ctid::text FROM"), "{}", built.sql);
        assert!(!built.sql.contains("ORDER BY"), "{}", built.sql);
    }

    #[test]
    fn limit_is_clamped_and_one_extra_row_is_requested() {
        let mut q = query();
        q.limit = 0;
        assert!(
            build_select(&table(pk()), &q)
                .unwrap()
                .sql
                .ends_with("LIMIT 2 OFFSET 0")
        );
        q.limit = u32::MAX;
        q.offset = 20_000;
        assert!(
            build_select(&table(pk()), &q)
                .unwrap()
                .sql
                .ends_with("LIMIT 10001 OFFSET 20000")
        );
    }

    #[test]
    fn values_are_bound_never_pasted_into_the_sql() {
        let mut q = query();
        q.filters = vec![
            filter("na\"me", FilterOp::Eq, &["'; DROP TABLE users; --"]),
            filter("id", FilterOp::Between, &["5", "9"]),
        ];
        let built = build_select(&table(pk()), &q).unwrap();
        assert!(!built.sql.contains("DROP"), "{}", built.sql);
        assert!(
            built.sql.contains(
                " WHERE \"na\"\"me\" = $1::text::text AND \"id\" BETWEEN $2::text::bigint \
                 AND $3::text::bigint ORDER BY"
            ),
            "{}",
            built.sql
        );
        assert_eq!(built.params, ["'; DROP TABLE users; --", "5", "9"]);
    }

    #[test]
    fn every_operator_builds_its_condition() {
        let cases: [(FilterOp, &[&str], &str); 12] = [
            (FilterOp::Eq, &["1"], "\"id\" = $1::text::bigint"),
            (FilterOp::Ne, &["1"], "\"id\" <> $1::text::bigint"),
            (FilterOp::Lt, &["1"], "\"id\" < $1::text::bigint"),
            (FilterOp::Gt, &["1"], "\"id\" > $1::text::bigint"),
            (FilterOp::Le, &["1"], "\"id\" <= $1::text::bigint"),
            (FilterOp::Ge, &["1"], "\"id\" >= $1::text::bigint"),
            (FilterOp::Like, &["1%"], "\"id\"::text LIKE $1::text"),
            (FilterOp::ILike, &["1%"], "\"id\"::text ILIKE $1::text"),
            (
                FilterOp::In,
                &["1", "2"],
                "\"id\" IN ($1::text::bigint, $2::text::bigint)",
            ),
            (FilterOp::IsNull, &[], "\"id\" IS NULL"),
            (FilterOp::IsNotNull, &[], "\"id\" IS NOT NULL"),
            (
                FilterOp::Between,
                &["1", "2"],
                "\"id\" BETWEEN $1::text::bigint AND $2::text::bigint",
            ),
        ];
        for (op, values, expected) in cases {
            let mut params = Vec::new();
            let sql = condition(&table(pk()), &filter("id", op, values), &mut params).unwrap();
            assert_eq!(sql, expected, "{op:?}");
            assert_eq!(params.len(), values.len(), "{op:?}");
        }
    }

    #[test]
    fn unknown_columns_and_wrong_value_counts_are_rejected() {
        let mut params = Vec::new();
        let desc = table(pk());
        for bad in [
            filter("nope", FilterOp::Eq, &["1"]),
            filter("id\" = 1 OR \"1", FilterOp::IsNull, &[]),
            filter("id", FilterOp::Eq, &[]),
            filter("id", FilterOp::Eq, &["1", "2"]),
            filter("id", FilterOp::Between, &["1"]),
            filter("id", FilterOp::In, &[]),
            filter("id", FilterOp::IsNull, &["1"]),
        ] {
            let err = condition(&desc, &bad, &mut params).unwrap_err();
            assert_eq!(err.code(), "VALIDATION", "{bad:?}");
        }
        assert!(params.is_empty());

        let mut q = query();
        q.sort = vec![SortSpec {
            column: "nope".into(),
            dir: SortDir::Asc,
        }];
        assert_eq!(build_select(&desc, &q).unwrap_err().code(), "VALIDATION");
    }

    #[test]
    fn raw_where_is_cleaned_and_wrapped() {
        assert_eq!(clean_raw_where(None), None);
        assert_eq!(clean_raw_where(Some("  ;  ")), None);
        assert_eq!(clean_raw_where(Some("WHERE id > 5;")).unwrap(), "id > 5");
        assert_eq!(clean_raw_where(Some("where\nid > 5")).unwrap(), "id > 5");
        // A column that merely starts with "where" is not the keyword.
        assert_eq!(
            clean_raw_where(Some("whereabouts = 1")).unwrap(),
            "whereabouts = 1"
        );

        let mut q = query();
        q.filters = vec![filter("id", FilterOp::Gt, &["1"])];
        q.raw_where = Some("born < '2000-01-01' -- old".into());
        let built = build_select(&table(pk()), &q).unwrap();
        assert!(built.has_raw_sql);
        assert!(
            built
                .sql
                .contains("\"id\" > $1::text::bigint AND (born < '2000-01-01' -- old\n) ORDER BY"),
            "{}",
            built.sql
        );
    }

    #[test]
    fn count_sql_has_the_same_where_and_no_paging() {
        let built =
            build_count(&table(pk()), &[filter("born", FilterOp::IsNull, &[])], None).unwrap();
        assert_eq!(
            built.sql,
            "SELECT count(*) FROM \"public\".\"users\" WHERE \"born\" IS NULL"
        );
    }
}
