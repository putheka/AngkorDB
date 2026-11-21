import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ObjectKind, PrivilegeChange, PrivilegeMatrix, PrivilegeTarget } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cellValue,
  stageCell,
  stagedChanges,
  targetKey,
  visibleGrantees,
} from "@/features/admin/roles";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { useCurrentSchema, useObjects } from "@/features/sidebar/useSchema";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const RELATIONS: ObjectKind[] = [
  "table",
  "partitionedTable",
  "foreignTable",
  "view",
  "materializedView",
];

const SELECT_CLASS = "h-8 max-w-56 rounded-lg border bg-background px-2 text-sm";

/** Pick a schema, table or sequence and see (and change) who may do what to it. */
export function PrivilegesPanel({ connectionId }: { connectionId: string }) {
  const { schema: current, schemas } = useCurrentSchema(connectionId);
  const [picked, setPicked] = useState<string | null>(null);
  const schema = picked ?? current;
  const [object, setObject] = useState("");
  const objects = useObjects(connectionId, schema);

  const relations = (objects.data ?? []).filter((o) => RELATIONS.includes(o.kind));
  const sequences = (objects.data ?? []).filter((o) => o.kind === "sequence");
  // An object that is gone (another schema was picked) falls back to the schema itself.
  const known = object === "" || (objects.data ?? []).some((o) => `${o.kind}:${o.name}` === object);
  const choice = known ? object : "";

  let target: PrivilegeTarget | null = null;
  if (schema) {
    if (choice === "") target = { kind: "schema", schema: "", name: schema };
    else {
      const found = (objects.data ?? []).find((o) => `${o.kind}:${o.name}` === choice);
      if (found) {
        target = {
          kind: found.kind === "sequence" ? "sequence" : "relation",
          schema,
          name: found.name,
        };
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs">
        <label className="flex items-center gap-2">
          Schema
          <select
            aria-label="Schema"
            className={SELECT_CLASS}
            value={schema ?? ""}
            onChange={(e) => {
              setPicked(e.target.value);
              setObject("");
            }}
          >
            {schemas.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Object
          <select
            aria-label="Object"
            className={SELECT_CLASS}
            value={choice}
            onChange={(e) => setObject(e.target.value)}
          >
            <option value="">The schema itself</option>
            {relations.length > 0 && (
              <optgroup label="Tables and views">
                {relations.map((o) => (
                  <option key={o.oid} value={`${o.kind}:${o.name}`}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            )}
            {sequences.length > 0 && (
              <optgroup label="Sequences">
                {sequences.map((o) => (
                  <option key={o.oid} value={`${o.kind}:${o.name}`}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </div>
      {target ? (
        <MatrixLoader key={targetKey(target)} connectionId={connectionId} target={target} />
      ) : (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">Pick a schema.</p>
      )}
    </div>
  );
}

function MatrixLoader({ connectionId, target }: { connectionId: string; target: PrivilegeTarget }) {
  const matrix = useQuery({
    queryKey: ["privileges", connectionId, targetKey(target)],
    queryFn: () => commands.objectPrivileges(connectionId, target),
    retry: false,
  });
  if (matrix.isError) {
    return (
      <p role="alert" className="px-4 py-6 text-sm font-medium text-destructive">
        {errorMessage(matrix.error)}
      </p>
    );
  }
  if (!matrix.data) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">Reading…</p>;
  }
  return <Matrix connectionId={connectionId} target={target} matrix={matrix.data} />;
}

function Matrix({
  connectionId,
  target,
  matrix,
}: {
  connectionId: string;
  target: PrivilegeTarget;
  matrix: PrivilegeMatrix;
}) {
  const queryClient = useQueryClient();
  const [staged, setStaged] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [onlyWithAccess, setOnlyWithAccess] = useState(true);
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const changes = stagedChanges(matrix, staged, target);
  const rows = visibleGrantees(matrix, staged, onlyWithAccess, text);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          Owner: <span className="font-mono text-foreground">{matrix.owner}</span>
        </span>
        <input
          aria-label="Filter roles"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter roles"
          className="w-36 rounded-md border bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-ring/50"
        />
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={onlyWithAccess}
            onChange={(e) => setOnlyWithAccess(e.target.checked)}
          />
          Only roles with access
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              <th scope="col" className="border-b px-3 py-1.5 text-left font-medium">
                Role
              </th>
              {matrix.privileges.map((p) => (
                <th
                  key={p}
                  scope="col"
                  className="border-b px-2 py-1.5 text-center font-medium text-muted-foreground"
                >
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.grantee ?? "PUBLIC"} className="hover:bg-muted/40">
                <th scope="row" className="px-3 py-1 text-left font-normal">
                  <span className={cn(row.grantee === null ? "italic" : "font-mono")}>
                    {row.grantee ?? "PUBLIC (everyone)"}
                  </span>
                  {row.owner && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      owner
                    </span>
                  )}
                  {row.superuser && (
                    <span
                      className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                      title="A superuser can do everything, whatever is granted."
                    >
                      superuser
                    </span>
                  )}
                </th>
                {matrix.privileges.map((p) => {
                  const value = cellValue(matrix, staged, row.grantee, p);
                  const held = row.granted.includes(p);
                  return (
                    <td
                      key={p}
                      className={cn("px-2 py-1 text-center", value !== held && "bg-amber-500/15")}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${p} for ${row.grantee ?? "PUBLIC"}`}
                        checked={value}
                        onChange={(e) =>
                          setStaged((s) => stageCell(matrix, s, row.grantee, p, e.target.checked))
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No roles match.</p>
        )}
      </div>

      {changes.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t bg-muted/30 px-3 py-2 text-xs">
          <span>
            {changes.length} {changes.length === 1 ? "change" : "changes"} not saved
          </span>
          <Button variant="ghost" size="xs" onClick={() => setStaged(new Map())}>
            Discard
          </Button>
          <Button size="xs" className="ml-auto" onClick={() => setReviewing(true)}>
            Review…
          </Button>
        </div>
      )}

      {reviewing && (
        <ReviewDialog
          connectionId={connectionId}
          changes={changes}
          onClose={() => setReviewing(false)}
          onApplied={async () => {
            setReviewing(false);
            setStaged(new Map());
            await queryClient.invalidateQueries({ queryKey: ["privileges", connectionId] });
          }}
        />
      )}
    </div>
  );
}

function ReviewDialog({
  connectionId,
  changes,
  onClose,
  onApplied,
}: {
  connectionId: string;
  changes: PrivilegeChange[];
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const preview = useQuery({
    queryKey: ["privilege-preview", connectionId, JSON.stringify(changes)],
    queryFn: () => commands.previewPrivilegeChanges(connectionId, changes),
    retry: false,
  });

  const run = async () => {
    if (!preview.data || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `Change privileges on ${connectionName}?`,
        lines: preview.data.statements.map((s) => s.sql),
        reason: `change privileges on ${connectionName}`,
      });
      if (!approved) return;
      await commands.applyPrivilegeChanges(connectionId, changes);
      await onApplied();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review the changes</DialogTitle>
          <DialogDescription>This is exactly what will run.</DialogDescription>
        </DialogHeader>
        {preview.isError && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {errorMessage(preview.error)}
          </p>
        )}
        {preview.data && (
          <pre
            aria-label="SQL"
            className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed select-text"
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
            Back
          </Button>
          <Button type="button" disabled={!preview.data || running} onClick={() => void run()}>
            {running ? "Working…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
