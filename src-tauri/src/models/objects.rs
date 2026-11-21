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
    RefreshMaterializedView(RefreshMaterializedView),
    SetSequence(SetSequence),
    AddEnumValue(AddEnumValue),
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

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefreshMaterializedView {
    pub schema: String,
    pub name: String,
    /// Keeps the old rows readable while it refreshes; needs a unique index on the view.
    pub concurrently: bool,
    /// Empties it instead of filling it again (it can't be read until the next refresh).
    pub with_no_data: bool,
}

/// `setval`: the next value handed out depends on `is_called`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetSequence {
    pub schema: String,
    pub name: String,
    /// A whole number, as text (a sequence can go past what a JS number holds).
    pub value: String,
    /// `true`: `value` was already handed out, so the next is the one after it. `false`: the
    /// next value is `value` itself.
    pub is_called: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EnumPosition {
    /// `true`: before `existing`; `false`: after it.
    pub before: bool,
    pub existing: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddEnumValue {
    pub schema: String,
    pub name: String,
    pub value: String,
    /// `None`: at the end.
    pub position: Option<EnumPosition>,
    pub if_not_exists: bool,
}
