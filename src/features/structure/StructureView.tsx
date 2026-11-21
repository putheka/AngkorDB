import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import type { StructureColumn, TableStructure } from "@/bindings";
import { Button } from "@/components/ui/button";
import { useWriteApproval } from "@/features/safety/approval";
import { ColumnsTable, type ColumnsEditing } from "@/features/structure/ColumnsTable";
import { DdlPanel } from "@/features/structure/DdlPanel";
import { ConstraintDialog } from "@/features/structure/edit/ConstraintDialog";
import { IndexDialog } from "@/features/structure/edit/IndexDialog";
import { saveStructureStaged } from "@/features/structure/edit/saveStructure";
import {
  nextEditId,
  useStructureEditStore,
  useTabStructureEdits,
} from "@/features/structure/edit/structureEditStore";
import {
  addNewColumn,
  addNewConstraint,
  addNewIndex,
  describeEdits,
  editColumn,
  editCount,
  finalColumnNames,
  problems as findProblems,
  removeNewColumn,
  removeNewConstraint,
  removeNewIndex,
  revertColumn,
  toChanges,
  toggleDropColumn,
  toggleDropConstraint,
  toggleDropIndex,
  updateNewColumn,
} from "@/features/structure/edit/structureEdits";
import { SaveNoticeBar, StructurePendingBar } from "@/features/structure/edit/StructurePendingBar";
import { StructurePreviewDialog } from "@/features/structure/edit/StructurePreviewDialog";
import { UsingDialog } from "@/features/structure/edit/UsingDialog";
import { InfoPanel } from "@/features/structure/InfoPanel";
import {
  ConstraintsTable,
  IndexesTable,
  TriggersTable,
  type ObjectsEditing,
} from "@/features/structure/ObjectTables";
import { SECTION_LABELS, SECTIONS, type Section } from "@/features/structure/sections";
import { errorMessage } from "@/lib/errors";
import { useShortcut } from "@/features/shortcuts/registry";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { TableTab } from "@/stores/tabs";

/** How many things each section has, for the number next to its name. */
function counts(s: TableStructure): Partial<Record<Section, number>> {
  return {
    columns: s.columns.length,
    indexes: s.indexes.length,
    constraints: s.constraints.length,
    triggers: s.triggers.length,
  };
}

type Dialog =
  | { kind: "using"; column: StructureColumn; to: string }
  | { kind: "index" }
  | { kind: "constraint" };

interface Props {
  connectionId: string;
  tab: TableTab;
  section: Section;
  onSection: (section: Section) => void;
}

/** How a table, view or materialized view is built: columns, indexes, constraints, triggers, info, DDL. */
export function StructureView({ connectionId, tab, section, onSection }: Props) {
  const { schema, name: table } = tab;
  // Under "schema" so that ⌘R (reload the schema) refreshes it too.
  const structure = useQuery({
    queryKey: ["schema", connectionId, "structure", schema, table],
    queryFn: () => commands.tableStructure(connectionId, schema, table),
  });

  const { mode: safeMode, name: connectionName, approve } = useWriteApproval(connectionId);
  const edits = useTabStructureEdits(tab.id);
  const notice = useStructureEditStore((s) => s.notices[tab.id]);
  const update = useStructureEditStore((s) => s.update);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const data = structure.data;
  const editable =
    data !== undefined &&
    (data.kind === "table" || data.kind === "partitionedTable" || data.kind === "foreignTable") &&
    safeMode !== "read-only";

  const staged = editCount(edits);
  const found = useMemo(() => (data ? findProblems(edits, data.columns) : []), [data, edits]);
  const changes = useMemo(() => toChanges(edits), [edits]);

  const stage = useCallback(
    (change: Parameters<typeof update>[1]) => update(tab.id, change),
    [update, tab.id],
  );

  const save = useCallback(async () => {
    if (!data || staged === 0 || saving || found.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const approved = await approve({
        title: `Change the structure of ${schema}.${table} on ${connectionName}?`,
        lines: [describeEdits(edits)],
        reason: `change the structure of ${table} on ${connectionName}`,
      });
      if (!approved) return;
      await saveStructureStaged(connectionId, tab);
      setPreviewOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }, [
    data,
    staged,
    saving,
    found.length,
    approve,
    schema,
    table,
    connectionName,
    edits,
    connectionId,
    tab,
  ]);

  // Saves what is staged.
  useShortcut(
    "structure.save",
    () => {
      // An open cell editor holds an edit that is not staged yet: closing it stages it.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement) active.blur();
      void save();
    },
    { enabled: editable && staged > 0 },
  );

  if (structure.isPending) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (structure.isError || !data) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center text-sm">
        <p className="font-medium text-destructive">{errorMessage(structure.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void structure.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const number = counts(data);
  const columnNames = finalColumnNames(data.columns, edits);

  const columnsEditing: ColumnsEditing | undefined = editable
    ? {
        edits,
        onEdit: (column, patch) => stage((e) => editColumn(e, column, patch)),
        onType: (column, typeName) => {
          const next = typeName.trim();
          if (next === "" || next === column.typeName) {
            // Back to the type it has: take the staged change away.
            stage((e) => editColumn(e, column, { typeName: column.typeName }));
          } else setDialog({ kind: "using", column, to: next });
        },
        onRevert: (n) => stage((e) => revertColumn(e, n)),
        onToggleDrop: (n) => stage((e) => toggleDropColumn(e, n)),
        onAdd: () =>
          stage((e) =>
            addNewColumn(e, {
              id: nextEditId(),
              name: "",
              typeName: "text",
              nullable: true,
              defaultValue: "",
              comment: "",
            }),
          ),
        onUpdateNew: (id, patch) => stage((e) => updateNewColumn(e, id, patch)),
        onRemoveNew: (id) => stage((e) => removeNewColumn(e, id)),
      }
    : undefined;

  const objectsEditing: ObjectsEditing | undefined = editable
    ? {
        edits,
        onToggleDropIndex: (n) => stage((e) => toggleDropIndex(e, n)),
        onToggleDropConstraint: (n) => stage((e) => toggleDropConstraint(e, n)),
        onRemoveNewIndex: (id) => stage((e) => removeNewIndex(e, id)),
        onRemoveNewConstraint: (id) => stage((e) => removeNewConstraint(e, id)),
        onAddIndex: () => setDialog({ kind: "index" }),
        onAddConstraint: () => setDialog({ kind: "constraint" }),
      }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Structure" className="flex shrink-0 gap-1 border-b px-2 py-1">
        {SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            onClick={() => onSection(id)}
            className={cn(
              "flex items-center rounded-md border px-2 py-0.5 text-xs",
              section === id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {SECTION_LABELS[id]}
            {number[id] !== undefined && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                {number[id]}
              </span>
            )}
          </button>
        ))}
        {safeMode === "read-only" && (
          <span className="ml-auto self-center text-[11px] text-muted-foreground">
            Read-only connection: the structure can be looked at, not changed.
          </span>
        )}
      </div>

      {notice && (
        <SaveNoticeBar
          notice={notice}
          onDismiss={() => useStructureEditStore.getState().setNotice(tab.id, null)}
        />
      )}
      {staged > 0 && (
        <StructurePendingBar
          summary={describeEdits(edits)}
          problems={found}
          saving={saving}
          error={error}
          onPreview={() => setPreviewOpen(true)}
          onSave={() => void save()}
          onDiscard={() => {
            useStructureEditStore.getState().discard(tab.id);
            setError(null);
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {section === "columns" && <ColumnsTable structure={data} editing={columnsEditing} />}
        {section === "indexes" && <IndexesTable structure={data} editing={objectsEditing} />}
        {section === "constraints" && (
          <ConstraintsTable structure={data} editing={objectsEditing} />
        )}
        {section === "triggers" && <TriggersTable structure={data} />}
        {section === "info" && <InfoPanel structure={data} />}
        {section === "ddl" && <DdlPanel structure={data} />}
      </div>

      {dialog?.kind === "using" && (
        <UsingDialog
          column={dialog.column.name}
          from={dialog.column.typeName}
          to={dialog.to}
          onCancel={() => setDialog(null)}
          onConfirm={(using) => {
            stage((e) => editColumn(e, dialog.column, { typeName: dialog.to, using }));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "index" && (
        <IndexDialog
          columnNames={columnNames}
          onAdd={(index) => stage((e) => addNewIndex(e, index))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "constraint" && (
        <ConstraintDialog
          connectionId={connectionId}
          schema={schema}
          columnNames={columnNames}
          onAdd={(constraint) => stage((e) => addNewConstraint(e, constraint))}
          onClose={() => setDialog(null)}
        />
      )}
      {previewOpen && (
        <StructurePreviewDialog
          connectionId={connectionId}
          schema={schema}
          table={table}
          changes={changes}
          saving={saving}
          onSave={() => void save()}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
