import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import type { Role } from "@/bindings";
import { Button } from "@/components/ui/button";
import { DefaultsPanel } from "@/features/admin/DefaultsPanel";
import { DropRoleDialog } from "@/features/admin/DropRoleDialog";
import { PrivilegesPanel } from "@/features/admin/PrivilegesPanel";
import { RoleDialog } from "@/features/admin/RoleDialog";
import { formatValidUntil, roleBadges, visibleRoles } from "@/features/admin/roles";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";

type Section = "roles" | "privileges" | "defaults";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "roles", label: "Roles" },
  { id: "privileges", label: "Privileges" },
  { id: "defaults", label: "Default privileges" },
];

/** Kept while another tab is in front. */
const usePrefs = create<{
  section: Section;
  showBuiltIn: boolean;
  text: string;
  set: (patch: Partial<{ section: Section; showBuiltIn: boolean; text: string }>) => void;
}>()((set) => ({ section: "roles", showBuiltIn: false, text: "", set: (patch) => set(patch) }));

type Editing = { kind: "new" } | { kind: "edit"; role: Role } | { kind: "drop"; role: Role };

/** Roles of the server, who may do what to an object, and the default privileges. */
export function RolesView({ connectionId }: { connectionId: string }) {
  const { section, showBuiltIn, text, set } = usePrefs();
  const [editing, setEditing] = useState<Editing | null>(null);

  const roles = useQuery({
    queryKey: ["roles", connectionId],
    queryFn: () => commands.listRoles(connectionId),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const all = roles.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-xs">
        <div role="tablist" className="flex rounded-md border p-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              onClick={() => set({ section: s.id })}
              className={cn(
                "rounded px-2.5 py-1 font-medium",
                section === s.id ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {section === "roles" && (
          <>
            <label className="flex items-center gap-1.5 rounded-md border px-2 py-1 focus-within:ring-2 focus-within:ring-ring/50">
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <input
                aria-label="Filter roles"
                value={text}
                onChange={(e) => set({ text: e.target.value })}
                placeholder="Filter"
                className="w-36 bg-transparent outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showBuiltIn}
                onChange={(e) => set({ showBuiltIn: e.target.checked })}
              />
              Show built-in roles
            </label>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                onClick={() => void roles.refetch()}
              >
                <RefreshCwIcon className={cn(roles.isFetching && "animate-spin")} />
              </Button>
              <Button size="sm" onClick={() => setEditing({ kind: "new" })}>
                <PlusIcon /> New role
              </Button>
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {section === "roles" && (
          <RoleTable
            roles={visibleRoles(all, showBuiltIn, text)}
            loading={roles.isPending}
            error={roles.isError ? errorMessage(roles.error) : null}
            onEdit={(role) => setEditing({ kind: "edit", role })}
            onDrop={(role) => setEditing({ kind: "drop", role })}
          />
        )}
        {section === "privileges" && <PrivilegesPanel connectionId={connectionId} />}
        {section === "defaults" && <DefaultsPanel connectionId={connectionId} />}
      </div>

      {editing?.kind === "new" && (
        <RoleDialog
          connectionId={connectionId}
          role={null}
          roles={all}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "edit" && (
        <RoleDialog
          key={editing.role.name}
          connectionId={connectionId}
          role={editing.role}
          roles={all}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "drop" && (
        <DropRoleDialog
          connectionId={connectionId}
          role={editing.role}
          roles={all}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RoleTable({
  roles,
  loading,
  error,
  onEdit,
  onDrop,
}: {
  roles: Role[];
  loading: boolean;
  error: string | null;
  onEdit: (role: Role) => void;
  onDrop: (role: Role) => void;
}) {
  if (error) {
    return (
      <p role="alert" className="px-4 py-6 text-sm font-medium text-destructive">
        {error}
      </p>
    );
  }
  if (loading) {
    return (
      <p className="px-4 py-10 text-center text-sm text-muted-foreground">Reading the roles…</p>
    );
  }
  if (roles.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">No roles match.</p>;
  }
  return (
    <table className="w-full border-separate border-spacing-0 text-xs">
      <thead className="sticky top-0 z-10 bg-background">
        <tr>
          {["Role", "Can", "Member of", "Connections", "Valid until", ""].map((h, i) => (
            <th
              key={i}
              scope="col"
              className="border-b px-3 py-1.5 text-left font-medium text-muted-foreground"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {roles.map((r) => (
          <tr
            key={r.name}
            className="align-top hover:bg-muted/40"
            onDoubleClick={() => !r.predefined && onEdit(r)}
          >
            <td className="px-3 py-1.5 font-mono">
              {r.name}
              {r.isCurrent && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-sans text-muted-foreground">
                  you
                </span>
              )}
            </td>
            <td className="px-3 py-1.5">
              <span className="flex flex-wrap gap-1">
                {roleBadges(r).map((b) => (
                  <span
                    key={b}
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      b === "Superuser"
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {b}
                  </span>
                ))}
              </span>
            </td>
            <td className="px-3 py-1.5 text-muted-foreground">{r.memberOf.join(", ") || "—"}</td>
            <td className="px-3 py-1.5 tabular-nums">{r.connectionLimit ?? "no limit"}</td>
            <td className="px-3 py-1.5">{formatValidUntil(r.validUntil)}</td>
            <td className="px-3 py-1 text-right whitespace-nowrap">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit ${r.name}`}
                title={r.predefined ? "Built-in roles can't be changed" : "Edit"}
                disabled={r.predefined}
                onClick={() => onEdit(r)}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Drop ${r.name}`}
                title={
                  r.predefined
                    ? "Built-in roles can't be dropped"
                    : r.isCurrent
                      ? "You are connected as this role"
                      : "Drop"
                }
                disabled={r.predefined || r.isCurrent}
                onClick={() => onDrop(r)}
              >
                <Trash2Icon className="text-destructive" />
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
