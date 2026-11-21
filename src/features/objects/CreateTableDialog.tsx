import { useQuery } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
import {
  blankColumn,
  formProblems,
  presetColumn,
  PRESETS,
  toOperation,
  type ColumnDraft,
  type IdentityChoice,
} from "@/features/objects/createTable";
import { runObjectOperation } from "@/features/objects/runObjectOperation";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { nextEditId } from "@/features/structure/edit/structureEditStore";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

interface Props {
  connectionId: string;
  schema: string;
  onClose: () => void;
}

/** A new table: name, columns (with presets for the usual ones), key, and the SQL it will run. */
export function CreateTableDialog({ connectionId, schema, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>(() => [presetColumn("id", nextEditId())]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const problems = useMemo(() => formProblems(name, columns), [name, columns]);
  const operation = useMemo(
    () => toOperation(schema, name, comment, columns),
    [schema, name, comment, columns],
  );
  const preview = useQuery({
    queryKey: ["object-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewObjectOperation(connectionId, operation),
    enabled: problems.length === 0,
    retry: false,
  });

  const change = (id: number, patch: Partial<ColumnDraft>) =>
    setColumns((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const create = async () => {
    if (problems.length > 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const approved = await approve({
        title: `Create ${schema}.${name.trim()} on ${connectionName}?`,
        lines: [`${columns.length} ${columns.length === 1 ? "column" : "columns"}`],
        reason: `create the table ${name.trim()} on ${connectionName}`,
      });
      if (!approved) return;
      await runObjectOperation(connectionId, operation);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  };

  const used = new Set(columns.map((c) => c.name));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle>New table in {schema}</DialogTitle>
            <DialogDescription>
              Nothing is created until you press Create. The SQL below is exactly what runs.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="table-name">Name</Label>
              <Input
                id="table-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="orders"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="table-comment">Comment</Label>
              <Input
                id="table-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>

          <div className="min-h-0 overflow-auto rounded-md border">
            <table aria-label="Columns" className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Name</th>
                  <th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Null</th>
                  <th className="px-2 py-1 font-medium">Default</th>
                  <th className="px-2 py-1 font-medium">Identity</th>
                  <th className="px-2 py-1 font-medium">Key</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {columns.map((c, i) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-1 py-1">
                      <Input
                        aria-label={`Name of column ${i + 1}`}
                        value={c.name}
                        onChange={(e) => change(c.id, { name: e.target.value })}
                        className="h-7 text-xs"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        aria-label={`Type of column ${i + 1}`}
                        value={c.typeName}
                        onChange={(e) => change(c.id, { typeName: e.target.value })}
                        className="h-7 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Column ${i + 1} allows null`}
                        checked={c.nullable && !c.primaryKey}
                        disabled={c.primaryKey}
                        onChange={(e) => change(c.id, { nullable: e.target.checked })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Input
                        aria-label={`Default of column ${i + 1}`}
                        value={c.identity === "none" ? c.defaultValue : ""}
                        disabled={c.identity !== "none"}
                        onChange={(e) => change(c.id, { defaultValue: e.target.value })}
                        placeholder="none"
                        className="h-7 font-mono text-xs"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Select
                        value={c.identity}
                        onValueChange={(v) => change(c.id, { identity: v as IdentityChoice })}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={`Identity of column ${i + 1}`}
                          className="h-7 w-28 text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">no</SelectItem>
                          <SelectItem value="always">always</SelectItem>
                          <SelectItem value="byDefault">by default</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Column ${i + 1} is part of the key`}
                        checked={c.primaryKey}
                        onChange={(e) => change(c.id, { primaryKey: e.target.checked })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove column ${i + 1}`}
                        onClick={() => setColumns((list) => list.filter((x) => x.id !== c.id))}
                      >
                        <XIcon />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setColumns((l) => [...l, blankColumn(nextEditId())])}
            >
              <PlusIcon /> Column
            </Button>
            {PRESETS.filter((p) => !used.has(p.id)).map((p) => (
              <Button
                key={p.id}
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setColumns((l) => [...l, presetColumn(p.id, nextEditId())])}
              >
                <PlusIcon /> {p.label}
              </Button>
            ))}
          </div>

          {problems.length > 0 && (
            <ul role="status" className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {preview.isError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {errorMessage(preview.error)}
            </p>
          )}
          {preview.data && (
            <pre
              aria-label="SQL"
              className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed select-text"
            >
              <SqlText code={preview.data.sql} />
            </pre>
          )}
          {error !== null && (
            <div role="alert" className="text-xs">
              <p className="font-medium text-destructive">{errorMessage(error)}</p>
              {errorDetails(error).map((line) => (
                <p key={line} className="text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={problems.length > 0 || creating || !preview.data}>
              {creating ? "Creating…" : "Create table"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
