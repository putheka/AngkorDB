import { useMemo, useState } from "react";

import type { DbObject } from "@/bindings";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useConnections } from "@/features/connections/useConnections";
import {
  defaultObjects,
  matchLabels,
  matchObjects,
  resolveRecents,
  type Match,
} from "@/features/palette/items";
import { openObject } from "@/features/palette/openObject";
import { useRecents } from "@/features/palette/recents";
import { useAllObjects } from "@/features/palette/useAllObjects";
import { refreshData } from "@/features/grid/useTableData";
import { Highlighted } from "@/features/sidebar/Highlighted";
import { OBJECT_ICONS } from "@/features/sidebar/objectIcons";
import {
  refreshSchema,
  useCurrentSchema,
  useDatabases,
  useSwitchDatabase,
} from "@/features/sidebar/useSchema";
import { errorMessage } from "@/lib/errors";
import { useBrowserStore } from "@/stores/browser";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore, type PaletteMode } from "@/stores/palette";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";

const NO_RECENTS: never[] = [];

const KIND_LABEL: Partial<Record<DbObject["kind"], string>> = {
  view: "view",
  materializedView: "materialized view",
  foreignTable: "foreign table",
  partitionedTable: "partitioned table",
  function: "function",
  procedure: "procedure",
  sequence: "sequence",
  enumType: "type",
};

/** ⌘P finds an object, ⌘K runs a command or switches database, schema or connection. */
export function CommandPalette({ connectionId }: { connectionId: string }) {
  const mode = usePaletteStore((s) => s.mode);
  const close = usePaletteStore((s) => s.close);

  return (
    <CommandDialog
      open={mode !== null}
      onOpenChange={(open) => !open && close()}
      title={mode === "commands" ? "Commands" : "Open"}
      description={
        mode === "commands"
          ? "Switch database, schema or connection, or run a command."
          : "Search for a table, view, function or other object."
      }
      className="sm:max-w-xl"
    >
      {/* Mounted only while open and re-created per mode, so each opening starts with an empty search. */}
      {mode && <PaletteBody key={mode} mode={mode} connectionId={connectionId} />}
    </CommandDialog>
  );
}

function PaletteBody({ mode, connectionId }: { mode: PaletteMode; connectionId: string }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Command shouldFilter={false} loop>
      <CommandInput
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          setError(null);
        }}
        placeholder={
          mode === "objects" ? "Find a table, view, function…" : "Type a command, database, schema…"
        }
        autoFocus
      />
      <CommandList className="max-h-96">
        {mode === "objects" ? (
          <ObjectResults connectionId={connectionId} query={query} />
        ) : (
          <CommandResults connectionId={connectionId} query={query} onError={setError} />
        )}
      </CommandList>
      {error && (
        <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>↑↓ move</span>
        <span>↵ {mode === "objects" ? "open" : "run"}</span>
        <span>esc close</span>
        <span className="ml-auto">{mode === "objects" ? "⌘K commands" : "⌘P objects"}</span>
      </div>
    </Command>
  );
}

function ObjectResults({ connectionId, query }: { connectionId: string; query: string }) {
  const close = usePaletteStore((s) => s.close);
  const { objects, pending } = useAllObjects(connectionId);
  const recents = useRecents((s) => s.byConnection[connectionId]) ?? NO_RECENTS;
  const manySchemas = useMemo(() => new Set(objects.map((o) => o.schema)).size > 1, [objects]);

  const matches = useMemo(() => matchObjects(objects, query), [objects, query]);
  const recent = useMemo(() => resolveRecents(recents, objects), [recents, objects]);
  const all = useMemo(() => defaultObjects(objects), [objects]);

  const choose = (object: DbObject) => {
    close();
    openObject(object);
  };
  const row = (group: string, match: Match<DbObject>) => (
    <ObjectRow
      key={`${group}:${match.item.kind}:${match.item.oid}`}
      value={`${group}:${match.item.kind}:${match.item.oid}`}
      match={match}
      showSchema={manySchemas}
      onChoose={choose}
    />
  );
  const plain = (object: DbObject): Match<DbObject> => ({ item: object, indices: [], score: 0 });

  if (query.trim() === "") {
    return (
      <>
        {pending && objects.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {recent.length > 0 && (
          <CommandGroup heading="Recent">{recent.map((o) => row("recent", plain(o)))}</CommandGroup>
        )}
        {all.length > 0 && (
          <CommandGroup heading="Objects">{all.map((o) => row("all", plain(o)))}</CommandGroup>
        )}
      </>
    );
  }
  return (
    <>
      {matches.length === 0 && (
        <CommandEmpty>{pending ? "Searching…" : "Nothing matches."}</CommandEmpty>
      )}
      {matches.length > 0 && (
        <CommandGroup heading="Results">{matches.map((m) => row("hit", m))}</CommandGroup>
      )}
    </>
  );
}

function ObjectRow({
  value,
  match,
  showSchema,
  onChoose,
}: {
  value: string;
  match: Match<DbObject>;
  showSchema: boolean;
  onChoose: (object: DbObject) => void;
}) {
  const { item } = match;
  const Icon = OBJECT_ICONS[item.kind];
  const kind = KIND_LABEL[item.kind];
  return (
    <CommandItem value={value} onSelect={() => onChoose(item)}>
      <Icon className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={item.name} indices={match.indices} />
        {item.detail && <span className="ml-1 text-xs text-muted-foreground">{item.detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {kind && <span>{kind}</span>}
        {showSchema && <span>{item.schema}</span>}
      </span>
    </CommandItem>
  );
}

type Entry = {
  id: string;
  group: "Commands" | "Databases" | "Schemas" | "Connections";
  label: string;
  hint?: string;
  shortcut?: string;
  current?: boolean;
  run: () => void;
};

const GROUP_ORDER: Entry["group"][] = ["Commands", "Databases", "Schemas", "Connections"];

/** What to call an entry in the one-list view. */
const KIND_OF_ENTRY: Record<Entry["group"], string> = {
  Commands: "command",
  Databases: "database",
  Schemas: "schema",
  Connections: "connection",
};

function CommandResults({
  connectionId,
  query,
  onError,
}: {
  connectionId: string;
  query: string;
  onError: (message: string | null) => void;
}) {
  const close = usePaletteStore((s) => s.close);
  const databases = useDatabases(connectionId);
  const { schema: currentSchema, schemas } = useCurrentSchema(connectionId);
  const { data: connections = [] } = useConnections();
  const switchDatabase = useSwitchDatabase(connectionId);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);

  const entries: Entry[] = [
    {
      id: "new-query",
      group: "Commands",
      label: "New query tab",
      shortcut: "⌘T",
      run: () => useTabsStore.getState().newQuery(),
    },
    {
      id: "reload",
      group: "Commands",
      label: "Reload schema and rows",
      shortcut: "⌘R",
      run: () => {
        void refreshSchema(connectionId);
        void refreshData(connectionId);
      },
    },
    {
      id: "sidebar",
      group: "Commands",
      label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
      shortcut: "⌘0",
      run: () => useLayoutStore.getState().toggleSidebar(),
    },
    {
      id: "disconnect",
      group: "Commands",
      label: "Disconnect",
      run: () => void useSessionStore.getState().disconnect(),
    },
    ...(databases.data ?? []).map((d): Entry => ({
      id: `db:${d.name}`,
      group: "Databases",
      label: d.name,
      current: d.isCurrent,
      run: () => {
        if (d.isCurrent) return;
        // Stay open until the switch works, so a failure can be shown here.
        switchDatabase.mutate(d.name, {
          onSuccess: () => close(),
          onError: (e) => onError(errorMessage(e)),
        });
      },
    })),
    ...schemas.map((s): Entry => ({
      id: `schema:${s.name}`,
      group: "Schemas",
      label: s.name,
      current: s.name === currentSchema,
      run: () => useBrowserStore.getState().setSchema(s.name),
    })),
    ...connections
      .filter((c) => c.id !== connectionId)
      .map((c): Entry => ({
        id: `connection:${c.id}`,
        group: "Connections",
        label: c.name,
        hint: `${c.user}@${c.host}`,
        run: () => {
          const { disconnect, connect } = useSessionStore.getState();
          void disconnect().then((done) => {
            if (done) return connect(c);
          });
        },
      })),
  ];

  const matches = matchLabels(entries, (e) => e.label, query);
  // Nothing typed: grouped. Typing: one list, best match first, whatever kind it is (the
  // database `postgres` also matches "stres", but the schema `stress` must come first).
  const searching = query.trim() !== "";
  const shown = searching
    ? [{ group: "Results", items: matches }]
    : GROUP_ORDER.map((group) => ({
        group,
        items: matches.filter((m) => m.item.group === group),
      }));

  // Choosing closes the palette, except a database switch, which closes itself when it is done.
  const choose = (entry: Entry) => {
    onError(null);
    entry.run();
    if (!entry.id.startsWith("db:") || entry.current) close();
  };

  return (
    <>
      {matches.length === 0 && <CommandEmpty>Nothing matches.</CommandEmpty>}
      {shown
        .filter(({ items }) => items.length > 0)
        .map(({ group, items }) => (
          <CommandGroup key={group} heading={group}>
            {items.map((m) => (
              <CommandItem key={m.item.id} value={m.item.id} onSelect={() => choose(m.item)}>
                <span className="min-w-0 flex-1 truncate">
                  <Highlighted text={m.item.label} indices={m.indices} />
                </span>
                {m.item.current && <span className="text-xs text-muted-foreground">current</span>}
                {(m.item.hint || searching) && (
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {m.item.hint}
                    {searching && <span>{KIND_OF_ENTRY[m.item.group]}</span>}
                  </span>
                )}
                {m.item.shortcut && <CommandShortcut>{m.item.shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
    </>
  );
}
