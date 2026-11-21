import { PlusIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";

import type { ConstraintInfo, TableStructure, TriggerInfo } from "@/bindings";
import { Button } from "@/components/ui/button";
import type {
  NewConstraint,
  NewIndex,
  StructureEdits,
} from "@/features/structure/edit/structureEdits";
import { Badge, Empty, Table, Th } from "@/features/structure/table";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** What the lists need to let indexes and constraints be added and dropped. */
export interface ObjectsEditing {
  edits: StructureEdits;
  onToggleDropIndex: (name: string) => void;
  onToggleDropConstraint: (name: string) => void;
  onRemoveNewIndex: (id: number) => void;
  onRemoveNewConstraint: (id: number) => void;
  onAddIndex: () => void;
  onAddConstraint: () => void;
}

function Toolbar({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
      Dropping something is staged; nothing is saved until you press Save.
      <Button size="xs" variant="outline" className="ml-auto" onClick={onAdd}>
        <PlusIcon /> {label}
      </Button>
    </div>
  );
}

/** A new index in words, like the existing ones show their definition. */
function describeIndex(i: NewIndex): string {
  const columns = i.columns
    .map((c) => `${c.isExpression ? `(${c.text})` : c.text}${c.descending ? " DESC" : ""}`)
    .join(", ");
  return `${i.unique ? "UNIQUE " : ""}${i.method} (${columns})${i.whereClause.trim() ? ` WHERE ${i.whereClause.trim()}` : ""}${i.concurrently ? " · CONCURRENTLY" : ""}`;
}

function describeConstraint(c: NewConstraint): string {
  switch (c.kind) {
    case "primaryKey":
      return `PRIMARY KEY (${c.columns.join(", ")})`;
    case "unique":
      return `UNIQUE (${c.columns.join(", ")})`;
    case "check":
      return `CHECK (${c.expression})${c.notValid ? " NOT VALID" : ""}`;
    case "foreignKey":
      return `FOREIGN KEY (${c.columns.join(", ")}) REFERENCES ${c.refSchema}.${c.refTable} (${c.refColumns.join(", ")})${c.onDelete === "noAction" ? "" : ` ON DELETE ${c.onDelete}`}${c.onUpdate === "noAction" ? "" : ` ON UPDATE ${c.onUpdate}`}${c.notValid ? " NOT VALID" : ""}`;
  }
}

export function IndexesTable({
  structure,
  editing,
}: {
  structure: TableStructure;
  editing?: ObjectsEditing;
}) {
  const added = editing?.edits.newIndexes ?? [];
  if (structure.indexes.length === 0 && added.length === 0 && !editing) {
    return <Empty>This has no indexes.</Empty>;
  }
  return (
    <div>
      {editing && <Toolbar label="Index" onAdd={editing.onAddIndex} />}
      <Table label="Indexes">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Method</Th>
            <Th>Columns</Th>
            <Th>Definition</Th>
            <Th className="text-right">Size</Th>
            {editing && <Th className="w-10" />}
          </tr>
        </thead>
        <tbody>
          {structure.indexes.map((index) => {
            const dropped = editing?.edits.droppedIndexes.includes(index.name) ?? false;
            return (
              <tr
                key={index.name}
                className={cn(
                  "border-b border-border/50 align-top hover:bg-accent/30",
                  dropped && "bg-destructive/10 line-through opacity-70",
                )}
              >
                <td className="px-2 py-1 font-medium">
                  {index.name}
                  <div className="mt-0.5">
                    {index.primary && <Badge>primary key</Badge>}
                    {index.unique && !index.primary && <Badge>unique</Badge>}
                    {index.partial && <Badge>partial</Badge>}
                    {!index.valid && <Badge tone="warn">invalid</Badge>}
                  </div>
                </td>
                <td className="px-2 py-1">{index.method}</td>
                <td className="px-2 py-1 font-mono">{index.columns.join(", ")}</td>
                <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                  {index.definition}
                  {index.comment && <div className="font-sans">{index.comment}</div>}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {formatBytes(index.sizeBytes)}
                </td>
                {editing && (
                  <td className="px-2 py-1">
                    {/* An index that backs a constraint goes with the constraint. */}
                    {index.constraint === null && (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={
                          dropped ? `Keep index ${index.name}` : `Drop index ${index.name}`
                        }
                        onClick={() => editing.onToggleDropIndex(index.name)}
                      >
                        {dropped ? <Undo2Icon /> : <Trash2Icon />}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {added.map((index) => (
            <tr key={index.id} className="border-b border-border/50 bg-emerald-500/10 align-top">
              <td className="px-2 py-1 font-medium">
                {index.name.trim() || (
                  <span className="text-muted-foreground">named by the server</span>
                )}
                <div className="mt-0.5">
                  <Badge>new</Badge>
                </div>
              </td>
              <td className="px-2 py-1">{index.method}</td>
              <td className="px-2 py-1 font-mono">
                {index.columns.map((c) => (c.isExpression ? `(${c.text})` : c.text)).join(", ")}
              </td>
              <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                {describeIndex(index)}
              </td>
              <td className="px-2 py-1" />
              {editing && (
                <td className="px-2 py-1">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Remove the new index"
                    onClick={() => editing.onRemoveNewIndex(index.id)}
                  >
                    <XIcon />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

const KIND_LABELS: Record<ConstraintInfo["kind"], string> = {
  primaryKey: "Primary key",
  foreignKey: "Foreign key",
  unique: "Unique",
  check: "Check",
  exclusion: "Exclusion",
};

export function ConstraintsTable({
  structure,
  editing,
}: {
  structure: TableStructure;
  editing?: ObjectsEditing;
}) {
  const added = editing?.edits.newConstraints ?? [];
  if (structure.constraints.length === 0 && added.length === 0 && !editing) {
    return <Empty>This has no constraints.</Empty>;
  }
  return (
    <div>
      {editing && <Toolbar label="Constraint" onAdd={editing.onAddConstraint} />}
      <Table label="Constraints">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th>Columns</Th>
            <Th>Definition</Th>
            {editing && <Th className="w-10" />}
          </tr>
        </thead>
        <tbody>
          {structure.constraints.map((c) => {
            const dropped = editing?.edits.droppedConstraints.includes(c.name) ?? false;
            return (
              <tr
                key={c.name}
                className={cn(
                  "border-b border-border/50 align-top hover:bg-accent/30",
                  dropped && "bg-destructive/10 line-through opacity-70",
                )}
              >
                <td className="px-2 py-1 font-medium">
                  {c.name}
                  <div className="mt-0.5">
                    {c.deferrable && (
                      <Badge>{c.initiallyDeferred ? "deferrable, deferred" : "deferrable"}</Badge>
                    )}
                    {!c.validated && <Badge tone="warn">not validated</Badge>}
                  </div>
                </td>
                <td className="px-2 py-1">{KIND_LABELS[c.kind]}</td>
                <td className="px-2 py-1 font-mono">{c.columns.join(", ")}</td>
                <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                  {c.definition}
                  {c.comment && <div className="font-sans">{c.comment}</div>}
                </td>
                {editing && (
                  <td className="px-2 py-1">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={
                        dropped ? `Keep constraint ${c.name}` : `Drop constraint ${c.name}`
                      }
                      onClick={() => editing.onToggleDropConstraint(c.name)}
                    >
                      {dropped ? <Undo2Icon /> : <Trash2Icon />}
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
          {added.map((c) => (
            <tr key={c.id} className="border-b border-border/50 bg-emerald-500/10 align-top">
              <td className="px-2 py-1 font-medium">
                {c.name.trim() || (
                  <span className="text-muted-foreground">named by the server</span>
                )}
                <div className="mt-0.5">
                  <Badge>new</Badge>
                </div>
              </td>
              <td className="px-2 py-1">
                {
                  KIND_LABELS[
                    c.kind === "check"
                      ? "check"
                      : c.kind === "foreignKey"
                        ? "foreignKey"
                        : c.kind === "unique"
                          ? "unique"
                          : "primaryKey"
                  ]
                }
              </td>
              <td className="px-2 py-1 font-mono">
                {c.kind === "check" ? "" : c.columns.join(", ")}
              </td>
              <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                {describeConstraint(c)}
              </td>
              {editing && (
                <td className="px-2 py-1">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Remove the new constraint"
                    onClick={() => editing.onRemoveNewConstraint(c.id)}
                  >
                    <XIcon />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

const STATE_LABELS: Record<TriggerInfo["state"], string | null> = {
  enabled: null,
  disabled: "disabled",
  replica: "replica only",
  always: "always",
};

export function TriggersTable({ structure }: { structure: TableStructure }) {
  if (structure.triggers.length === 0) return <Empty>This has no triggers.</Empty>;
  return (
    <Table label="Triggers">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>When</Th>
          <Th>Function</Th>
          <Th>Definition</Th>
        </tr>
      </thead>
      <tbody>
        {structure.triggers.map((t) => {
          const state = STATE_LABELS[t.state];
          return (
            <tr key={t.name} className="border-b border-border/50 align-top hover:bg-accent/30">
              <td className="px-2 py-1 font-medium">
                {t.name}
                {state && (
                  <div className="mt-0.5">
                    <Badge tone={t.state === "disabled" ? "warn" : undefined}>{state}</Badge>
                  </div>
                )}
              </td>
              <td className="px-2 py-1">
                {t.timing} {t.events.join(" OR ")}
                <div className="text-muted-foreground">
                  {t.perRow ? "for each row" : "for each statement"}
                </div>
              </td>
              <td className="px-2 py-1 font-mono">{t.function}()</td>
              <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                {t.definition}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
