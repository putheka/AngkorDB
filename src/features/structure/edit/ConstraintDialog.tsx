import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { RefAction } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ColumnPicker } from "@/features/structure/edit/ColumnPicker";
import { nextEditId } from "@/features/structure/edit/structureEditStore";
import type { NewConstraint } from "@/features/structure/edit/structureEdits";
import { commands } from "@/lib/ipc";

type Kind = NewConstraint["kind"];

const KINDS: { id: Kind; label: string }[] = [
  { id: "foreignKey", label: "Foreign key: points at another table" },
  { id: "unique", label: "Unique: no two rows with the same values" },
  { id: "check", label: "Check: a condition every row must meet" },
  { id: "primaryKey", label: "Primary key" },
];

const ACTIONS: { id: RefAction; label: string }[] = [
  { id: "noAction", label: "No action (refuse if rows point at it)" },
  { id: "restrict", label: "Restrict (refuse, even when deferred)" },
  { id: "cascade", label: "Cascade (delete or update them too)" },
  { id: "setNull", label: "Set null" },
  { id: "setDefault", label: "Set default" },
];

interface Props {
  connectionId: string;
  /** The schema of this table: the first one offered as a target. */
  schema: string;
  /** The columns of this table, as they will be named after saving. */
  columnNames: readonly string[];
  onAdd: (constraint: NewConstraint) => void;
  onClose: () => void;
}

/** A new foreign key, unique, check or primary key constraint. */
export function ConstraintDialog({ connectionId, schema, columnNames, onAdd, onClose }: Props) {
  const [kind, setKind] = useState<Kind>("foreignKey");
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [expression, setExpression] = useState("");
  const [notValid, setNotValid] = useState(false);
  const [refSchema, setRefSchema] = useState(schema);
  const [refTable, setRefTable] = useState("");
  const [refColumns, setRefColumns] = useState<string[]>([]);
  const [onDelete, setOnDelete] = useState<RefAction>("noAction");
  const [onUpdate, setOnUpdate] = useState<RefAction>("noAction");

  const schemas = useQuery({
    queryKey: ["schema", connectionId, "schemas"],
    queryFn: () => commands.listSchemas(connectionId, false),
    enabled: kind === "foreignKey",
  });
  const tables = useQuery({
    queryKey: ["schema", connectionId, "objects", refSchema],
    queryFn: () => commands.listObjects(connectionId, refSchema),
    enabled: kind === "foreignKey",
  });
  const target = useQuery({
    queryKey: ["schema", connectionId, "describe", refSchema, refTable],
    queryFn: () => commands.describeTable(connectionId, refSchema, refTable),
    enabled: kind === "foreignKey" && refTable !== "",
  });
  const tableNames = (tables.data ?? [])
    .filter((o) => o.kind === "table" || o.kind === "partitionedTable")
    .map((o) => o.name);

  const complete =
    kind === "check"
      ? expression.trim() !== ""
      : kind === "foreignKey"
        ? columns.length > 0 && refTable !== "" && refColumns.length === columns.length
        : columns.length > 0;

  const submit = () => {
    if (!complete) return;
    const id = nextEditId();
    if (kind === "check") onAdd({ id, kind, name, expression: expression.trim(), notValid });
    else if (kind === "foreignKey") {
      onAdd({
        id,
        kind,
        name,
        columns,
        refSchema,
        refTable,
        refColumns,
        onDelete,
        onUpdate,
        notValid,
      });
    } else onAdd({ id, kind, name, columns });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New constraint</DialogTitle>
            <DialogDescription>
              It is added to the staged changes; the SQL is shown before anything runs.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="constraint-kind">Type</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as Kind);
                setColumns([]);
              }}
            >
              <SelectTrigger id="constraint-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="constraint-name">Name</Label>
            <Input
              id="constraint-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="let PostgreSQL choose"
            />
          </div>

          {kind === "check" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="constraint-expression">Condition</Label>
              <Input
                id="constraint-expression"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                placeholder="total > 0"
                className="font-mono"
                autoFocus
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>{kind === "foreignKey" ? "Columns of this table" : "Columns"}</Label>
              <ColumnPicker
                label="Columns"
                options={columnNames}
                value={columns}
                onChange={setColumns}
              />
            </div>
          )}

          {kind === "foreignKey" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fk-schema">Points at: schema</Label>
                  <Select
                    value={refSchema}
                    onValueChange={(v) => {
                      setRefSchema(v);
                      setRefTable("");
                      setRefColumns([]);
                    }}
                  >
                    <SelectTrigger id="fk-schema" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(schemas.data ?? [{ name: schema }]).map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fk-table">Table</Label>
                  <Select
                    value={refTable}
                    onValueChange={(v) => {
                      setRefTable(v);
                      setRefColumns([]);
                    }}
                  >
                    <SelectTrigger id="fk-table" className="w-full">
                      <SelectValue placeholder="Pick a table" />
                    </SelectTrigger>
                    <SelectContent>
                      {tableNames.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Columns it points at (as many as on this table, in the same order)</Label>
                <ColumnPicker
                  label="Columns it points at"
                  options={target.data?.columns.map((c) => c.name) ?? []}
                  value={refColumns}
                  onChange={setRefColumns}
                  empty={refTable === "" ? "Pick a table first." : "Loading the columns…"}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fk-delete">On delete</Label>
                  <Select value={onDelete} onValueChange={(v) => setOnDelete(v as RefAction)}>
                    <SelectTrigger id="fk-delete" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTIONS.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fk-update">On update</Label>
                  <Select value={onUpdate} onValueChange={(v) => setOnUpdate(v as RefAction)}>
                    <SelectTrigger id="fk-update" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTIONS.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          {(kind === "check" || kind === "foreignKey") && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={notValid}
                onChange={(e) => setNotValid(e.target.checked)}
              />
              <span>
                Check new rows only (NOT VALID)
                <span className="block text-xs text-muted-foreground">
                  The rows that are there are not looked at, which is quick on a big table. Validate
                  it later with ALTER TABLE … VALIDATE CONSTRAINT.
                </span>
              </span>
            </label>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete}>
              Add constraint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
