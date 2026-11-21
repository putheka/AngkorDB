import {
  KeyRoundIcon,
  Link2Icon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";

import type { StructureColumn, TableStructure } from "@/bindings";
import { Button } from "@/components/ui/button";
import { EditableCell } from "@/features/structure/edit/EditableCell";
import type {
  ColumnEdit,
  NewColumn,
  StructureEdits,
} from "@/features/structure/edit/structureEdits";
import { Empty, Table, Th } from "@/features/structure/table";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";

/** Open the table a foreign key points at. */
function follow(schema: string, table: string) {
  useTabsStore.getState().openTable({ schema, name: table, kind: "table" }, true);
}

function Extras({ column }: { column: StructureColumn }) {
  const badges: string[] = [];
  if (column.identity === "always") badges.push("identity always");
  if (column.identity === "byDefault") badges.push("identity by default");
  if (column.generated === "stored") badges.push("generated, stored");
  if (column.generated === "virtual") badges.push("generated, virtual");
  if (column.collation) badges.push(`collate ${column.collation}`);
  return badges.map((b) => (
    <span key={b} className="mr-1 rounded-full bg-muted px-1.5 py-px text-[10px]">
      {b}
    </span>
  ));
}

/** What the table needs to let the columns be edited in place. */
export interface ColumnsEditing {
  edits: StructureEdits;
  onEdit: (column: StructureColumn, patch: ColumnEdit) => void;
  /** The type cell was edited: the parent may ask how to convert before staging it. */
  onType: (column: StructureColumn, typeName: string) => void;
  onRevert: (name: string) => void;
  onToggleDrop: (name: string) => void;
  onAdd: () => void;
  onUpdateNew: (id: number, patch: Partial<Omit<NewColumn, "id">>) => void;
  onRemoveNew: (id: number) => void;
}

/** Name, type, nullability, default and comment of every column; editable when `editing` is given. */
export function ColumnsTable({
  structure,
  editing,
}: {
  structure: TableStructure;
  editing?: ColumnsEditing;
}) {
  if (structure.columns.length === 0 && !editing) return <Empty>This has no columns.</Empty>;
  return (
    <div>
      {editing && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
          Click a cell to change it. Nothing is saved until you press Save.
          <Button size="xs" variant="outline" className="ml-auto" onClick={editing.onAdd}>
            <PlusIcon /> Column
          </Button>
        </div>
      )}
      <Table label="Columns">
        <thead>
          <tr>
            <Th className="w-10 text-right">#</Th>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th className="w-16">Null</Th>
            <Th>Default</Th>
            <Th>Extra</Th>
            <Th>Comment</Th>
            {editing && <Th className="w-16" />}
          </tr>
        </thead>
        <tbody>
          {structure.columns.map((column) => (
            <ColumnRow key={column.name} column={column} editing={editing} />
          ))}
          {editing?.edits.newColumns.map((column) => (
            <NewColumnRow key={column.id} column={column} editing={editing} />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function ColumnRow({ column, editing }: { column: StructureColumn; editing?: ColumnsEditing }) {
  const edit = editing?.edits.columns[column.name];
  const dropped = editing?.edits.droppedColumns.includes(column.name) ?? false;
  const canEdit = editing !== undefined && !dropped;

  const name = edit?.name ?? column.name;
  const typeName = edit?.typeName ?? column.typeName;
  const nullable = edit?.nullable ?? column.nullable;
  const defaultValue =
    edit?.defaultValue !== undefined ? (edit.defaultValue ?? "") : (column.defaultValue ?? "");
  const comment = edit?.comment !== undefined ? (edit.comment ?? "") : (column.comment ?? "");
  // The default of a generated column is its expression: not a thing to set.
  const generated = column.generated !== null;

  return (
    <tr
      className={cn(
        "border-b border-border/50 align-top hover:bg-accent/30",
        dropped && "bg-destructive/10 line-through opacity-70",
      )}
    >
      <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{column.position}</td>
      <td className="px-2 py-1 font-medium">
        <span className="flex items-center gap-1.5">
          {editing ? (
            <EditableCell
              label={`Name of ${column.name}`}
              value={name}
              changed={edit?.name !== undefined}
              disabled={!canEdit}
              onCommit={(text) => editing.onEdit(column, { name: text })}
            />
          ) : (
            column.name
          )}
          {column.isPrimaryKey && (
            <KeyRoundIcon
              aria-label="Primary key"
              className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
            />
          )}
          {column.foreignKeys.map((fk) => (
            <button
              key={`${fk.constraint}.${fk.column}`}
              type="button"
              title={`References ${fk.schema}.${fk.table}(${fk.column}): open it`}
              aria-label={`References ${fk.schema}.${fk.table}`}
              onClick={() => follow(fk.schema, fk.table)}
              className="flex items-center gap-0.5 rounded px-1 text-[10px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Link2Icon className="size-3" />
              {fk.table}
            </button>
          ))}
        </span>
      </td>
      <td className="px-2 py-1 font-mono">
        {editing ? (
          <EditableCell
            label={`Type of ${column.name}`}
            value={typeName}
            mono
            changed={edit?.typeName !== undefined}
            disabled={!canEdit || generated}
            onCommit={(text) => editing.onType(column, text)}
          />
        ) : (
          column.typeName
        )}
      </td>
      <td className="px-2 py-1">
        {editing ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={nullable}
            aria-label={`${column.name} allows null`}
            disabled={!canEdit}
            onClick={() => editing.onEdit(column, { nullable: !nullable })}
            className={cn(
              "rounded px-1.5 py-0.5 enabled:hover:bg-accent/60",
              edit?.nullable !== undefined && "bg-amber-500/15",
            )}
          >
            {nullable ? "yes" : "NO"}
          </button>
        ) : nullable ? (
          "yes"
        ) : (
          "NO"
        )}
      </td>
      <td className="px-2 py-1 font-mono break-all">
        {editing && !generated ? (
          <EditableCell
            label={`Default of ${column.name}`}
            value={defaultValue}
            placeholder="none"
            mono
            changed={edit?.defaultValue !== undefined}
            disabled={!canEdit || column.identity !== null}
            onCommit={(text) => editing.onEdit(column, { defaultValue: text })}
          />
        ) : generated ? (
          <span className="text-muted-foreground">= {column.defaultValue}</span>
        ) : (
          (column.defaultValue ?? "")
        )}
      </td>
      <td className="px-2 py-1">
        <Extras column={column} />
      </td>
      <td className="px-2 py-1 text-muted-foreground">
        {editing ? (
          <EditableCell
            label={`Comment of ${column.name}`}
            value={comment}
            placeholder="none"
            changed={edit?.comment !== undefined}
            disabled={!canEdit}
            onCommit={(text) => editing.onEdit(column, { comment: text })}
          />
        ) : (
          (column.comment ?? "")
        )}
      </td>
      {editing && (
        <td className="px-2 py-1 whitespace-nowrap">
          {edit && !dropped && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Undo the changes to ${column.name}`}
              onClick={() => editing.onRevert(column.name)}
            >
              <RotateCcwIcon />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={dropped ? `Keep ${column.name}` : `Drop ${column.name}`}
            onClick={() => editing.onToggleDrop(column.name)}
          >
            {dropped ? <Undo2Icon /> : <Trash2Icon />}
          </Button>
        </td>
      )}
    </tr>
  );
}

function NewColumnRow({ column, editing }: { column: NewColumn; editing: ColumnsEditing }) {
  return (
    <tr className="border-b border-border/50 bg-emerald-500/10 align-top">
      <td className="px-2 py-1 text-right text-emerald-700 dark:text-emerald-400">new</td>
      <td className="px-2 py-1">
        <input
          aria-label="Name of the new column"
          value={column.name}
          autoFocus={column.name === ""}
          placeholder="name"
          onChange={(e) => editing.onUpdateNew(column.id, { name: e.target.value })}
          className="w-full min-w-24 rounded border bg-background px-1.5 py-0.5 font-medium"
        />
      </td>
      <td className="px-2 py-1">
        <input
          aria-label="Type of the new column"
          value={column.typeName}
          placeholder="text, integer, numeric(10,2), …"
          onChange={(e) => editing.onUpdateNew(column.id, { typeName: e.target.value })}
          className="w-full min-w-24 rounded border bg-background px-1.5 py-0.5 font-mono"
        />
      </td>
      <td className="px-2 py-1">
        <button
          type="button"
          role="checkbox"
          aria-checked={column.nullable}
          aria-label="The new column allows null"
          onClick={() => editing.onUpdateNew(column.id, { nullable: !column.nullable })}
          className="rounded px-1.5 py-0.5 hover:bg-accent/60"
        >
          {column.nullable ? "yes" : "NO"}
        </button>
      </td>
      <td className="px-2 py-1">
        <input
          aria-label="Default of the new column"
          value={column.defaultValue}
          placeholder="none"
          onChange={(e) => editing.onUpdateNew(column.id, { defaultValue: e.target.value })}
          className="w-full min-w-24 rounded border bg-background px-1.5 py-0.5 font-mono"
        />
      </td>
      <td className="px-2 py-1" />
      <td className="px-2 py-1">
        <input
          aria-label="Comment of the new column"
          value={column.comment}
          placeholder="none"
          onChange={(e) => editing.onUpdateNew(column.id, { comment: e.target.value })}
          className="w-full min-w-24 rounded border bg-background px-1.5 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Remove the new column"
          onClick={() => editing.onRemoveNew(column.id)}
        >
          <XIcon />
        </Button>
      </td>
    </tr>
  );
}
