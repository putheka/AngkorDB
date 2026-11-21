import type { ReactNode } from "react";

import type { ObjectKind, TableStructure } from "@/bindings";
import { formatBytes, formatRowCount } from "@/lib/format";

const KIND_LABELS: Partial<Record<ObjectKind, string>> = {
  table: "Table",
  partitionedTable: "Partitioned table",
  foreignTable: "Foreign table",
  view: "View",
  materializedView: "Materialized view",
};

const PERSISTENCE_LABELS = {
  permanent: "Permanent",
  unlogged: "Unlogged (not crash-safe)",
  temporary: "Temporary",
} as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words select-text">{children}</dd>
    </>
  );
}

/** Owner, size, estimated rows, partitioning and the rest of what the catalog says about the table. */
export function InfoPanel({ structure }: { structure: TableStructure }) {
  const { info, kind } = structure;
  const isView = kind === "view";
  return (
    <dl className="grid max-w-3xl grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 p-4 text-xs">
      <Row label="Name">
        <span className="font-mono">
          {structure.schema}.{structure.name}
        </span>
      </Row>
      <Row label="Kind">{KIND_LABELS[kind] ?? kind}</Row>
      <Row label="Owner">{info.owner}</Row>
      {info.comment && <Row label="Comment">{info.comment}</Row>}
      {!isView && (
        <Row label="Rows (estimate)">
          {info.rowEstimate === null ? (
            <span className="text-muted-foreground">unknown: run ANALYZE</span>
          ) : (
            formatRowCount(info.rowEstimate, false)
          )}
        </Row>
      )}
      {!isView && kind !== "partitionedTable" && (
        <>
          <Row label="Total size">{formatBytes(info.totalBytes)}</Row>
          <Row label="Table">{formatBytes(info.tableBytes)} (with TOAST)</Row>
          <Row label="Indexes">{formatBytes(info.indexBytes)}</Row>
          <Row label="TOAST">{formatBytes(info.toastBytes)}</Row>
        </>
      )}
      <Row label="Persistence">{PERSISTENCE_LABELS[info.persistence]}</Row>
      {info.accessMethod && <Row label="Access method">{info.accessMethod}</Row>}
      {info.tablespace && <Row label="Tablespace">{info.tablespace}</Row>}
      {info.populated !== null && (
        <Row label="Filled">
          {info.populated ? "Yes" : "No: REFRESH MATERIALIZED VIEW to fill it"}
        </Row>
      )}
      {info.partitionKey && (
        <Row label="Partitioned by">
          <span className="font-mono">{info.partitionKey}</span>
        </Row>
      )}
      {info.partitionBound && (
        <Row label="Partition">
          <span className="font-mono">{info.partitionBound}</span>
        </Row>
      )}
      {info.parents.length > 0 && (
        <Row label={info.partitionBound ? "Partition of" : "Inherits from"}>
          <span className="font-mono">{info.parents.join(", ")}</span>
        </Row>
      )}
      {info.partitions.length > 0 && (
        <Row label="Partitions">
          <span className="font-mono">{info.partitions.join(", ")}</span>
        </Row>
      )}
      <Row label="Row security">{info.rowSecurity ? "On" : "Off"}</Row>
      {info.options.length > 0 && (
        <Row label="Options">
          <span className="font-mono">{info.options.join(", ")}</span>
        </Row>
      )}
    </dl>
  );
}
