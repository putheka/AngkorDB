//! The structure of a table, view or materialized view: columns, indexes, constraints, triggers,
//! size and the DDL that would create it (ANG-36).

use serde::Serialize;

use crate::models::schema::{ColumnIdentity, ForeignKeyRef, ObjectKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Persistence {
    Permanent,
    /// Not written to the write-ahead log: fast, and empty after a crash.
    Unlogged,
    Temporary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GeneratedKind {
    /// `GENERATED ALWAYS AS (…) STORED`
    Stored,
    /// `GENERATED ALWAYS AS (…) VIRTUAL` (PostgreSQL 18)
    Virtual,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StructureColumn {
    /// 1-based position in the table.
    pub position: u16,
    pub name: String,
    /// As Postgres prints it: `numeric(20,6)`, `character varying(100)`, `text[]`.
    pub type_name: String,
    pub nullable: bool,
    /// The `DEFAULT` expression, or for a generated column the expression it is computed from.
    pub default_value: Option<String>,
    pub identity: Option<ColumnIdentity>,
    pub generated: Option<GeneratedKind>,
    /// Only when it differs from the type's own collation.
    pub collation: Option<String>,
    pub comment: Option<String>,
    pub is_primary_key: bool,
    pub foreign_keys: Vec<ForeignKeyRef>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// `CREATE INDEX …` as the server prints it.
    pub definition: String,
    /// The indexed columns or expressions, in order (included columns are not listed).
    pub columns: Vec<String>,
    /// `btree`, `gin`, …
    pub method: String,
    pub unique: bool,
    pub primary: bool,
    /// `false` while a `CREATE INDEX CONCURRENTLY` is unfinished or after it failed.
    pub valid: bool,
    /// Has a `WHERE`.
    pub partial: bool,
    pub size_bytes: f64,
    /// The constraint this index backs (primary key, unique or exclusion), if any.
    pub constraint: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintKind {
    PrimaryKey,
    ForeignKey,
    Unique,
    Check,
    Exclusion,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    pub name: String,
    pub kind: ConstraintKind,
    /// `PRIMARY KEY (id)`, `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`,
    /// `CHECK ((qty > 0))`, … as the server prints it.
    pub definition: String,
    pub columns: Vec<String>,
    /// A foreign key's target, `schema.table`.
    pub references: Option<String>,
    pub deferrable: bool,
    pub initially_deferred: bool,
    /// `false` for a constraint added `NOT VALID`: new rows are checked, old ones are not.
    pub validated: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TriggerState {
    Enabled,
    Disabled,
    /// Fires only while replicating.
    Replica,
    /// Fires always, also while replicating.
    Always,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// `BEFORE`, `AFTER` or `INSTEAD OF`.
    pub timing: String,
    /// `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`.
    pub events: Vec<String>,
    /// `FOR EACH ROW` rather than `FOR EACH STATEMENT`.
    pub per_row: bool,
    /// `schema.function`.
    pub function: String,
    pub state: TriggerState,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub owner: String,
    pub comment: Option<String>,
    pub persistence: Persistence,
    /// The planner's estimate (`pg_class.reltuples`); `None` before the first `ANALYZE`.
    pub row_estimate: Option<f64>,
    /// Table, TOAST and indexes together.
    pub total_bytes: f64,
    /// The table and its TOAST data, without indexes.
    pub table_bytes: f64,
    pub index_bytes: f64,
    pub toast_bytes: f64,
    pub tablespace: Option<String>,
    /// Table access method (`heap`).
    pub access_method: Option<String>,
    /// `RANGE (created_at)`: how a partitioned table is split.
    pub partition_key: Option<String>,
    /// `FOR VALUES FROM (…) TO (…)`: which part of its parent a partition holds.
    pub partition_bound: Option<String>,
    /// The parent of a partition, or the tables a table inherits from.
    pub parents: Vec<String>,
    /// `schema.table` of each partition.
    pub partitions: Vec<String>,
    pub row_security: bool,
    pub options: Vec<String>,
    /// Materialized views: has it been filled?
    pub populated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    pub info: TableInfo,
    pub columns: Vec<StructureColumn>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub triggers: Vec<TriggerInfo>,
    /// The statements that create this table and everything of its own: indexes, foreign keys,
    /// triggers, comments.
    pub ddl: String,
    /// What those statements need to exist first: extensions, types, sequences and the
    /// functions that triggers, defaults and checks call. Empty when there is nothing.
    pub prerequisites: String,
}
