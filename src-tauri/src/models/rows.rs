//! Requests and results of browsing a table's rows (ANG-16).

use serde::{Deserialize, Serialize};

use crate::models::schema::RowIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub dir: SortDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Like,
    ILike,
    In,
    IsNull,
    IsNotNull,
    Between,
}

/// One condition of the filter bar. `values` holds what the operator needs: none for
/// `isNull` / `isNotNull`, two for `between`, one or more for `in`, exactly one otherwise.
/// Values are always text; the server casts them to the column's type.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    pub values: Vec<String>,
}

/// What to read from one table.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowQuery {
    pub schema: String,
    pub table: String,
    /// Clamped to `1..=10000`.
    pub limit: u32,
    pub offset: u32,
    /// Without any sort the rows come in primary key / unique index order.
    pub sort: Vec<SortSpec>,
    pub filters: Vec<Filter>,
    /// A `WHERE` fragment typed by the user, combined with the filters by `AND`. It is SQL, not
    /// a value: it runs inside a read-only transaction so it can't change anything.
    pub raw_where: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub type_oid: u32,
    /// As Postgres prints it: `numeric(20,6)`, `text[]`.
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowPage {
    pub columns: Vec<ResultColumn>,
    /// Every cell as text, `None` for SQL `NULL`. One entry per column.
    pub rows: Vec<Vec<Option<String>>>,
    /// How rows of this table are told apart when editing.
    pub identity: RowIdentity,
    /// When `identity` is `ctid`: each row's `ctid`, in the same order as `rows`. Empty otherwise.
    pub ctids: Vec<String>,
    /// There are more rows after this page.
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowCount {
    pub count: f64,
    /// `false`: the planner's estimate (`pg_class.reltuples`). Prefix it with `~`.
    pub exact: bool,
}

/// How many rows match, counting at most `cap` of them (so a huge table can't make it slow).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LimitedCount {
    /// Never more than the cap.
    pub count: u32,
    /// There are more rows than `count`.
    pub capped: bool,
}
