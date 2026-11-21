//! Who may do what to a schema, table or sequence, and what a default says (ANG-42).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PrivilegeTargetKind {
    Schema,
    /// A table, view, materialized view, foreign table or partitioned table.
    Relation,
    Sequence,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeTarget {
    pub kind: PrivilegeTargetKind,
    /// Left empty for a schema.
    pub schema: String,
    /// The schema's name, or the relation's.
    pub name: String,
}

/// What one grantee holds on the target.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeRow {
    /// `None`: PUBLIC, everybody.
    pub grantee: Option<String>,
    pub superuser: bool,
    pub owner: bool,
    pub granted: Vec<String>,
    /// The ones it may pass on (`WITH GRANT OPTION`).
    pub grantable: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeMatrix {
    /// The columns, in the order PostgreSQL lists them.
    pub privileges: Vec<String>,
    pub owner: String,
    /// PUBLIC first, then every role that is not predefined.
    pub rows: Vec<PrivilegeRow>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeChange {
    pub target: PrivilegeTarget,
    /// `None`: PUBLIC.
    pub grantee: Option<String>,
    pub privilege: String,
    /// `true`: `GRANT`; `false`: `REVOKE`.
    pub grant: bool,
}

/// One line of `pg_default_acl`: what new objects made by `role` start out with.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DefaultPrivilege {
    pub role: String,
    /// `None`: in every schema.
    pub schema: Option<String>,
    /// `tables`, `sequences`, `functions`, `types` or `schemas`.
    pub object_type: String,
    /// `None`: PUBLIC.
    pub grantee: Option<String>,
    pub privileges: Vec<String>,
}
