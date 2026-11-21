import { BookmarkIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import type { SavedQuery } from "@/bindings";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SaveQueryDialog } from "@/features/query/history/SaveQueryDialog";
import { draftFromSaved, type SaveQueryDraft } from "@/features/query/history/saveDraft";
import { openSavedQuery } from "@/features/query/history/openSavedQuery";
import { groupByFolder, oneLine } from "@/features/query/history/historyText";
import { useDeleteSavedQuery, useSavedQueries } from "@/features/query/history/useHistory";
import { cn } from "@/lib/utils";

/** The saved queries of the open connection, in folders. */
export function SavedQueries({
  connectionId,
  connectionName,
}: {
  connectionId: string;
  connectionName: string;
}) {
  const saved = useSavedQueries(connectionId);
  const remove = useDeleteSavedQuery();
  const [collapsed, setCollapsed] = useState(false);
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<SaveQueryDraft | null>(null);

  const queries = saved.data ?? [];
  const groups = groupByFolder(queries);
  const folders = groups.map((g) => g.folder).filter(Boolean);
  const toggleFolder = (folder: string) =>
    setClosedFolders((open) => {
      const next = new Set(open);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });

  return (
    <section
      aria-label="Saved queries"
      className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-sidebar-border"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
        />
        Saved queries
        <span className="ml-auto tabular-nums">{queries.length || ""}</span>
      </button>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-1">
          {queries.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Press ⌘⇧S in a query tab to save what you wrote.
            </p>
          )}
          {groups.map((group) => {
            const open = group.folder === "" || !closedFolders.has(group.folder);
            return (
              <div key={group.folder}>
                {group.folder !== "" && (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleFolder(group.folder)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-sidebar-accent"
                  >
                    <ChevronRightIcon
                      className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
                    />
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{group.folder}</span>
                  </button>
                )}
                {open &&
                  group.items.map((query) => (
                    <SavedRow
                      key={query.id}
                      query={query}
                      indented={group.folder !== ""}
                      onEdit={() => setEditing(draftFromSaved(query))}
                      onDelete={() => remove.mutate(query.id)}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <SaveQueryDialog
          key={editing.id}
          draft={editing}
          connectionId={connectionId}
          connectionName={connectionName}
          folders={folders}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function SavedRow({
  query,
  indented,
  onEdit,
  onDelete,
}: {
  query: SavedQuery;
  indented: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={oneLine(query.sql, 400)}
          onClick={() => openSavedQuery(query.sql)}
          className={cn(
            "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:outline-none",
            indented ? "pl-8" : "pl-3",
          )}
        >
          <BookmarkIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{query.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openSavedQuery(query.sql)}>
          Open in a new tab
        </ContextMenuItem>
        <ContextMenuItem onSelect={onEdit}>Rename or move…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
