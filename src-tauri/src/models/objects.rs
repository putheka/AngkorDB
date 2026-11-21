//! Create, rename, truncate and drop a table or view (ANG-38).

use serde::Deserialize;

use crate::models::schema::{ColumnIdentity, ObjectKind};

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ObjectOperation {
    CreateTable(CreateTable),
    Rename(RenameObject),
    Truncate(TruncateTable),
    Drop(DropObject),
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewTableColumn {
    pub name: String,
    /// As SQL: `text`, `bigint`, `numeric(10,2)`, `timestamp with time zone`.
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    /// `GENERATED … AS IDENTITY`; the type has to be an integer type.
    pub identity: Option<ColumnIdentity>,
    pub primary_key: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTable {
    pub schema: String,
    pub name: String,
    pub comment: Option<String>,
    pub columns: Vec<NewTableColumn>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameObject {
    /// Not `kind`: that is what tells the operations apart.
    pub object_kind: ObjectKind,
    pub schema: String,
    pub name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TruncateTable {
    pub schema: String,
    pub name: String,
    /// Start the sequences of its identity and serial columns over.
    pub restart_identity: bool,
    /// Also empty the tables that have a foreign key to this one.
    pub cascade: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DropObject {
    pub object_kind: ObjectKind,
    pub schema: String,
    pub name: String,
    /// Also drop what depends on it (views, foreign keys of other tables).
    pub cascade: bool,
}
