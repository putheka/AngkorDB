//! Edits staged in the UI and sent to the server in one go (ANG-23, ANG-8 D1/D2/D7).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a cell is to become. Text stays text until the server casts it (`$1::text::<type>`),
/// so a bigint above 2^53, a numeric or a jsonb document reaches the table exactly as typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CellValue {
    Value {
        text: String,
    },
    /// SQL `NULL`, sent as a bound `None`.
    Null,
    /// The keyword `DEFAULT`: the column's own default (a serial, `now()`, …).
    Default,
}

/// How a row is found again (ANG-8 D2). Must match what the server reports for the table.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowRef {
    /// The primary key, or a NOT NULL unique index: `columns[i]` has the value `values[i]`.
    Key {
        columns: Vec<String>,
        values: Vec<String>,
    },
    Ctid {
        ctid: String,
    },
}

/// New values for some cells of one existing row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    pub row: RowRef,
    /// Column name → new value. Other columns are left alone.
    pub values: BTreeMap<String, CellValue>,
}

/// A new row. Columns that are not listed get their `DEFAULT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    pub values: BTreeMap<String, CellValue>,
}

/// Everything staged for one table. Applied in one transaction: deletes first (they free keys),
/// then updates, then inserts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableChanges {
    pub updates: Vec<RowUpdate>,
    pub inserts: Vec<RowInsert>,
    pub deletes: Vec<RowRef>,
}

impl TableChanges {
    pub fn is_empty(&self) -> bool {
        self.updates.is_empty() && self.inserts.is_empty() && self.deletes.is_empty()
    }
}

/// What a committed change set did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub updated: u32,
    pub deleted: u32,
    /// The inserted rows as the server stored them (defaults and serials filled in), every cell
    /// as text in table column order, in the order of `TableChanges::inserts`.
    pub inserted: Vec<Vec<Option<String>>>,
}
