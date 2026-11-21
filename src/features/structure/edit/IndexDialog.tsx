import { useState } from "react";

import type { IndexMethod } from "@/bindings";
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
import { nextEditId } from "@/features/structure/edit/structureEditStore";
import { parseIndexColumns, type NewIndex } from "@/features/structure/edit/structureEdits";

const METHODS: { id: IndexMethod; label: string }[] = [
  { id: "btree", label: "btree: equality and ranges (the default)" },
  { id: "hash", label: "hash: equality only" },
  { id: "gin", label: "gin: arrays, jsonb, full text" },
  { id: "gist", label: "gist: geometry, ranges, nearest neighbour" },
  { id: "spgist", label: "spgist: partitioned search trees" },
  { id: "brin", label: "brin: huge tables in natural order" },
];

interface Props {
  /** The columns the index can use, as they will be named after saving. */
  columnNames: readonly string[];
  onAdd: (index: NewIndex) => void;
  onClose: () => void;
}

/** A new index: method, columns or expressions, unique, partial, built without locking writes. */
export function IndexDialog({ columnNames, onAdd, onClose }: Props) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState<IndexMethod>("btree");
  const [columns, setColumns] = useState("");
  const [unique, setUnique] = useState(false);
  const [whereClause, setWhereClause] = useState("");
  const [concurrently, setConcurrently] = useState(false);

  const parsed = parseIndexColumns(columns);
  const addColumn = (column: string) =>
    setColumns((text) =>
      text.trim() === "" ? column : `${text.trim().replace(/,$/, "")}, ${column}`,
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed.length === 0) return;
            onAdd({
              id: nextEditId(),
              name,
              method,
              columns: parsed,
              unique,
              whereClause,
              concurrently,
            });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>New index</DialogTitle>
            <DialogDescription>
              It is added to the staged changes; the SQL is shown before anything runs.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="index-name">Name</Label>
            <Input
              id="index-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="let PostgreSQL choose"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="index-method">Method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as IndexMethod)}>
              <SelectTrigger id="index-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="index-columns">Columns or expressions</Label>
            <Input
              id="index-columns"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
              placeholder="user_id, lower(email) DESC"
              className="font-mono"
            />
            <div className="flex flex-wrap gap-1.5">
              {columnNames.map((column) => (
                <button
                  key={column}
                  type="button"
                  onClick={() => addColumn(column)}
                  className="rounded-md border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent/50"
                >
                  {column}
                </button>
              ))}
            </div>
            {parsed.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {parsed
                  .map(
                    (c) =>
                      `${c.isExpression ? "expression" : "column"} ${c.text}${c.descending ? " (descending)" : ""}`,
                  )
                  .join(" · ")}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="index-where">Only rows where (a partial index)</Label>
            <Input
              id="index-where"
              value={whereClause}
              onChange={(e) => setWhereClause(e.target.value)}
              placeholder="status <> 'cancelled'"
              className="font-mono"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
            Unique
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={concurrently}
              onChange={(e) => setConcurrently(e.target.checked)}
            />
            <span>
              Build it without blocking writes (CONCURRENTLY)
              <span className="block text-xs text-muted-foreground">
                It can't run inside the transaction, so it is built on its own after the other
                changes are saved. If it fails, those stay saved and a half-built index may be left.
              </span>
            </span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={parsed.length === 0}>
              Add index
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
