//! Changing the structure of a table: what the person staged, and what it turns into (ANG-37).
//!
//! Names are plain text here and get quoted when the SQL is written. Expressions (a default, a
//! `USING` cast, a `CHECK`, an index `WHERE`) and type names are SQL the person typed: they go
//! into the statement as written, after a check that they are one piece of SQL (no `;`, no
//! comment that could swallow the rest). The preview shows exactly what will run.

use serde::{Deserialize, Serialize};

use crate::error::AppErrorPayload;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StructureChange {
    AddColumn(AddColumn),
    AlterColumn(AlterColumn),
    DropColumn(DropColumn),
    CreateIndex(CreateIndex),
    DropIndex(DropIndex),
    AddPrimaryKey(KeySpec),
    AddUnique(KeySpec),
    AddCheck(CheckSpec),
    AddForeignKey(ForeignKeySpec),
    DropConstraint(DropConstraint),
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddColumn {
    pub name: String,
    /// As SQL: `text`, `numeric(10,2)`, `timestamp with time zone`, `public.my_enum`, `int[]`.
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DefaultChange {
    /// `SET DEFAULT expression`
    Set { expression: String },
    /// `DROP DEFAULT`
    Drop,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommentChange {
    Set {
        text: String,
    },
    /// `COMMENT … IS NULL`
    Clear,
}

/// Everything about one existing column that is to change; `None` leaves it as it is.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlterColumn {
    pub column: String,
    pub new_name: Option<String>,
    pub type_name: Option<String>,
    /// How to turn the old values into the new type: `col::integer`. Only with `type_name`.
    pub using: Option<String>,
    pub nullable: Option<bool>,
    pub default_value: Option<DefaultChange>,
    pub comment: Option<CommentChange>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DropColumn {
    pub column: String,
    pub cascade: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexMethod {
    Btree,
    Hash,
    Gin,
    Gist,
    Spgist,
    Brin,
}

impl IndexMethod {
    pub fn sql(self) -> &'static str {
        match self {
            Self::Btree => "btree",
            Self::Hash => "hash",
            Self::Gin => "gin",
            Self::Gist => "gist",
            Self::Spgist => "spgist",
            Self::Brin => "brin",
        }
    }
}

/// One thing an index is on: a column, or an expression like `lower(email)`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub text: String,
    pub is_expression: bool,
    pub descending: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateIndex {
    /// `None`: the server picks one.
    pub name: Option<String>,
    pub method: IndexMethod,
    pub columns: Vec<IndexColumn>,
    pub unique: bool,
    /// A partial index: only rows where this is true are in it.
    pub where_clause: Option<String>,
    /// Does not lock writes while it builds, but can't run inside the transaction.
    pub concurrently: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DropIndex {
    pub name: String,
    pub concurrently: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeySpec {
    pub name: Option<String>,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckSpec {
    pub name: Option<String>,
    pub expression: String,
    /// Check new rows only; the old ones are not looked at (and can be validated later).
    pub not_valid: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RefAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

impl RefAction {
    pub fn sql(self) -> &'static str {
        match self {
            Self::NoAction => "NO ACTION",
            Self::Restrict => "RESTRICT",
            Self::Cascade => "CASCADE",
            Self::SetNull => "SET NULL",
            Self::SetDefault => "SET DEFAULT",
        }
    }
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeySpec {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: RefAction,
    pub on_update: RefAction,
    pub not_valid: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DropConstraint {
    pub name: String,
    pub cascade: bool,
}

/// One statement of the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStatement {
    pub sql: String,
    /// "alter column status": what to call it when it fails.
    pub label: String,
    /// 1-based: which of the staged changes it comes from.
    pub change: u32,
    /// `CONCURRENTLY`: runs after the transaction, on its own.
    pub concurrent: bool,
    /// Throws something away: a column, an index, a constraint.
    pub destructive: bool,
}

/// What the staged changes would run, for the preview.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StructurePreview {
    pub statements: Vec<PlannedStatement>,
    /// The same, as text to read: the transaction first, then what runs outside it.
    pub sql: String,
}

/// A `CONCURRENTLY` statement that failed after the rest was already saved.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConcurrentFailure {
    pub label: String,
    pub sql: String,
    pub error: AppErrorPayload,
}

#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StructureApplyResult {
    /// How many statements ran.
    pub statements: u32,
    /// Set when a statement that runs outside the transaction failed. The transaction's changes
    /// were saved; this one and the ones after it were not run.
    pub failed_concurrent: Option<ConcurrentFailure>,
}
