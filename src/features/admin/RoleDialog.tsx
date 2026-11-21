import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Role, RoleAttributes } from "@/bindings";
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
  buildRoleOperation,
  emptyForm,
  formOf,
  formProblem,
  type RoleForm,
} from "@/features/admin/roles";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

const FLAGS: { key: keyof RoleAttributes; label: string; hint: string }[] = [
  { key: "canLogin", label: "Can log in", hint: "A user. Without it the role is a group." },
  { key: "superuser", label: "Superuser", hint: "Skips every permission check. Be careful." },
  { key: "createDb", label: "Can create databases", hint: "" },
  { key: "createRole", label: "Can create roles", hint: "" },
  {
    key: "inherit",
    label: "Inherits privileges",
    hint: "Uses the privileges of the roles it is a member of.",
  },
  { key: "replication", label: "Replication", hint: "May start streaming replication." },
  { key: "bypassRls", label: "Bypasses row security", hint: "" },
];

interface Props {
  connectionId: string;
  /** `null`: a new role. */
  role: Role | null;
  roles: Role[];
  onClose: () => void;
}

/** Make a role, or change one: its attributes, password, expiry and memberships. */
export function RoleDialog({ connectionId, role, roles, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RoleForm>(() => (role ? formOf(role) : emptyForm()));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const problem = formProblem(form, role);
  // The preview only needs to know that there is a password, so the real one stays out of
  // the query key (and the cache): it lives in the form and goes to `apply` once.
  const previewOperation = buildRoleOperation(form, role, { maskPassword: true });
  const preview = useQuery({
    queryKey: ["role-preview", connectionId, JSON.stringify(previewOperation)],
    queryFn: () => commands.previewRoleOperation(connectionId, previewOperation),
    enabled: problem === null,
    retry: false,
  });

  const set = (patch: Partial<RoleForm>) => setForm((f) => ({ ...f, ...patch }));
  const setAttribute = (patch: Partial<RoleAttributes>) =>
    setForm((f) => ({ ...f, attributes: { ...f.attributes, ...patch } }));
  const toggleGroup = (group: string, on: boolean) =>
    set({
      memberOf: on ? [...form.memberOf, group] : form.memberOf.filter((g) => g !== group),
    });

  const groups = roles.filter((r) => r.name !== role?.name);
  const renamed = role !== null && form.name.trim() !== role.name;
  const ready = problem === null && !!preview.data && !running;

  const run = async () => {
    if (!ready || !preview.data) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `${role ? "Change" : "Create"} role ${form.name.trim()} on ${connectionName}?`,
        lines: preview.data.statements.map((s) => s.sql),
        reason: `${role ? "change" : "create"} role ${form.name.trim()} on ${connectionName}`,
      });
      if (!approved) return;
      await commands.applyRoleOperation(connectionId, buildRoleOperation(form, role));
      set({ password: "" });
      await queryClient.invalidateQueries({ queryKey: ["roles", connectionId] });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <DialogHeader>
            <DialogTitle>{role ? `Edit ${role.name}` : "New role"}</DialogTitle>
            <DialogDescription>
              A user or a group. The password is turned into a hash here: the server never gets it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              autoFocus={!role}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            {renamed && (
              <p className="text-xs text-muted-foreground">
                Renaming clears an MD5 password; a SCRAM password is kept.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role-password">Password</Label>
            <Input
              id="role-password"
              type="password"
              value={form.password}
              onChange={(e) => set({ password: e.target.value, clearPassword: false })}
              placeholder={role ? "Leave empty to keep the password" : "None"}
              autoComplete="new-password"
              spellCheck={false}
            />
            {role && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.clearPassword}
                  disabled={form.password !== ""}
                  onChange={(e) => set({ clearPassword: e.target.checked })}
                />
                Remove the password (it can't log in with one)
              </label>
            )}
          </div>

          <fieldset className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium">Attributes</legend>
            {FLAGS.map(({ key, label, hint }) => (
              <label key={key} className="flex items-start gap-2 text-sm" title={hint}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.attributes[key] as boolean}
                  onChange={(e) => setAttribute({ [key]: e.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-limit">Connection limit</Label>
              <Input
                id="role-limit"
                inputMode="numeric"
                value={form.attributes.connectionLimit ?? ""}
                placeholder="No limit"
                onChange={(e) => {
                  const text = e.target.value.trim();
                  setAttribute({ connectionLimit: text === "" ? null : Number(text) });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-until">Password valid until</Label>
              <Input
                id="role-until"
                value={form.attributes.validUntil ?? ""}
                placeholder="Never (2031-02-03)"
                onChange={(e) => setAttribute({ validUntil: e.target.value })}
                autoComplete="off"
              />
            </div>
          </div>

          {groups.length > 0 && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">Member of</legend>
              <div className="grid max-h-36 gap-x-4 gap-y-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                {groups.map((g) => (
                  <label key={g.name} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={form.memberOf.includes(g.name)}
                      onChange={(e) => toggleGroup(g.name, e.target.checked)}
                    />
                    <span className="truncate">{g.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {problem && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {problem}
            </p>
          )}
          {!problem && preview.isError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {errorMessage(preview.error)}
            </p>
          )}
          {!problem && preview.data && (
            <pre
              aria-label="SQL"
              className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap select-text"
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
            <Button type="submit" disabled={!ready}>
              {running ? "Working…" : role ? "Save" : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
