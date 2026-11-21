import { useVirtualizer } from "@tanstack/react-virtual";
import { DatabaseZapIcon, PlusIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { DbObject } from "@/bindings";

import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CreateTableDialog } from "@/features/objects/CreateTableDialog";
import { DatabaseDialog } from "@/features/objects/DatabaseDialog";
import { SchemaDialog, type SchemaMode } from "@/features/objects/SchemaDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnumDialog } from "@/features/objects/EnumDialog";
import { SequenceDialog } from "@/features/objects/SequenceDialog";
import { openSavedQuery } from "@/features/query/history/openSavedQuery";
import { commands } from "@/lib/ipc";
import { ExportDialog } from "@/features/export/ExportDialog";
import { ObjectActionDialog, type ObjectAction } from "@/features/objects/ObjectActionDialog";
import { useTableViews } from "@/features/grid/tableViews";
import { ObjectRow } from "@/features/sidebar/ObjectRow";
import { GroupRow } from "@/features/sidebar/GroupRow";
import { buildRows, isOpenable, type GroupId } from "@/features/sidebar/treeRows";
import {
  refreshSchema,
  useCurrentSchema,
  useDatabases,
  useObjects,
  useSwitchDatabase,
} from "@/features/sidebar/useSchema";
import { errorMessage } from "@/lib/errors";
import { tableTabId, useTabsStore } from "@/stores/tabs";

const ROW_HEIGHT = 26;

/** Database and schema pickers, a filter box, and the virtualized list of objects. */
export function ObjectTree({ connectionId }: { connectionId: string }) {
  const databases = useDatabases(connectionId);
  const { schema, schemas, setSchema } = useCurrentSchema(connectionId);
  const objects = useObjects(connectionId, schema);
  const switchDatabase = useSwitchDatabase(connectionId);

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<GroupId>>(new Set());
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [manage, setManage] = useState<
    { kind: "database"; mode: "create" | "drop" } | { kind: "schema"; mode: SchemaMode } | null
  >(null);
  const [action, setAction] = useState<{ kind: ObjectAction; object: DbObject } | null>(null);
  const [exporting, setExporting] = useState<DbObject | null>(null);
  const [details, setDetails] = useState<DbObject | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** The SQL that defines a function or view, in a query tab to read and edit. */
  const openDefinition = (object: DbObject) => {
    setProblem(null);
    commands
      .objectDefinition(connectionId, object.kind, object.schema, object.name, object.oid)
      .then((definition) => openSavedQuery(definition.sql))
      .catch((error: unknown) => setProblem(errorMessage(error)));
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeId = useTabsStore((s) => s.activeId);
  const openTable = useTabsStore((s) => s.openTable);

  const rows = useMemo(
    () => buildRows(objects.data ?? [], query, collapsed),
    [objects.data, query, collapsed],
  );
  const objectIndexes = useMemo(
    () => rows.flatMap((row, i) => (row.type === "object" ? [i] : [])),
    [rows],
  );

  // While filtering, the best match is always selected so Enter opens it.
  const cursorIndex = (() => {
    const at = rows.findIndex((r) => r.type === "object" && r.key === cursorKey);
    if (at !== -1) return at;
    return query.trim() ? (objectIndexes[0] ?? -1) : -1;
  })();

  // The compiler can't memoize this hook's functions; it just skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const open = (index: number, pin: boolean) => {
    const row = rows[index];
    if (row?.type !== "object") return;
    const { object } = row;
    if (isOpenable(object.kind)) {
      openTable({ schema: object.schema, name: object.name, kind: object.kind }, pin);
    } else if (pin && (object.kind === "function" || object.kind === "procedure")) {
      openDefinition(object);
    } else if (pin && (object.kind === "sequence" || object.kind === "enumType")) {
      setDetails(object);
    }
  };

  const moveCursor = (delta: 1 | -1) => {
    const position = objectIndexes.indexOf(cursorIndex);
    const next =
      objectIndexes[
        position === -1 ? (delta > 0 ? 0 : objectIndexes.length - 1) : position + delta
      ];
    const row = next === undefined ? undefined : rows[next];
    if (next === undefined || row?.type !== "object") return;
    setCursorKey(row.key);
    virtualizer.scrollToIndex(next);
  };

  const onNavKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && cursorIndex !== -1) {
      e.preventDefault();
      open(cursorIndex, true); // Enter is a decision: keep the tab
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      changeQuery("");
    }
  };

  // A new filter is a new list: start at its best match.
  const changeQuery = (next: string) => {
    setQuery(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const toggleGroup = (id: GroupId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const currentDatabase = databases.data?.find((d) => d.isCurrent)?.name;
  const hasFilter = query.trim() !== "";
  const loadError = objects.error ?? databases.error;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // ⌘F while the sidebar has focus jumps to the filter.
        if (e.metaKey && e.key === "f") {
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }
      }}
    >
      <div className="flex flex-col gap-1.5 border-b border-sidebar-border p-2">
        <Select
          value={currentDatabase ?? ""}
          onValueChange={(database) => switchDatabase.mutate(database)}
          disabled={switchDatabase.isPending || !databases.data}
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Database">
            <SelectValue placeholder="Database" />
          </SelectTrigger>
          <SelectContent>
            {databases.data?.map((d) => (
              <SelectItem key={d.name} value={d.name}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1.5">
          <Select value={schema ?? ""} onValueChange={setSchema} disabled={schemas.length === 0}>
            <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Schema">
              <SelectValue placeholder="Schema" />
            </SelectTrigger>
            <SelectContent>
              {schemas.map((s) => (
                <SelectItem key={s.name} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Databases and schemas">
                    <DatabaseZapIcon />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Databases and schemas</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Database</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setManage({ kind: "database", mode: "create" })}>
                New database…
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setManage({ kind: "database", mode: "drop" })}
              >
                Drop a database…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Schema</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setManage({ kind: "schema", mode: "create" })}>
                New schema…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setManage({ kind: "schema", mode: "rename" })}>
                Rename a schema…
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setManage({ kind: "schema", mode: "drop" })}
              >
                Drop a schema…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New table"
                disabled={!schema}
                onClick={() => setCreating(true)}
              >
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New table</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                onClick={() => void refreshSchema(connectionId)}
              >
                <RefreshCwIcon className={objects.isFetching ? "animate-spin" : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh (⌘R)</TooltipContent>
          </Tooltip>
        </div>

        <InputGroup className="h-7">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={onNavKey}
            placeholder="Filter (⌘F)"
            aria-label="Filter objects"
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear filter"
                onClick={() => {
                  changeQuery("");
                  inputRef.current?.focus();
                }}
              >
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        {problem && (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
        {switchDatabase.error && (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage(switchDatabase.error)}
          </p>
        )}
      </div>

      {loadError ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
          <p className="text-destructive">{errorMessage(loadError)}</p>
          <Button variant="outline" size="sm" onClick={() => void refreshSchema(connectionId)}>
            Try again
          </Button>
        </div>
      ) : objects.isPending && schema !== null ? (
        <p className="p-3 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          {hasFilter ? `Nothing matches “${query.trim()}”.` : "This schema is empty."}
        </p>
      ) : (
        <div
          ref={scrollRef}
          role="tree"
          aria-label="Database objects"
          tabIndex={0}
          onKeyDown={onNavKey}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const style = {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: item.size,
                transform: `translateY(${item.start}px)`,
              } as const;
              return row.type === "group" ? (
                <GroupRow
                  key={row.id}
                  row={row}
                  style={style}
                  onToggle={() => toggleGroup(row.id)}
                />
              ) : (
                <ObjectRow
                  key={row.key}
                  row={row}
                  style={style}
                  isActive={activeId === tableTabId(row.object.schema, row.object.name)}
                  isCursor={item.index === cursorIndex}
                  onPin={() => {
                    setCursorKey(row.key);
                    open(item.index, true);
                  }}
                  onOpen={() => {
                    scrollRef.current?.focus(); // keeps ⌘F and the arrow keys working after a click
                    setCursorKey(row.key);
                    open(item.index, false);
                  }}
                  onStructure={() => {
                    setCursorKey(row.key);
                    openTable(
                      { schema: row.object.schema, name: row.object.name, kind: row.object.kind },
                      true,
                    );
                    useTableViews
                      .getState()
                      .update(tableTabId(row.object.schema, row.object.name), {
                        mode: "structure",
                      });
                  }}
                  onAction={(kind) =>
                    kind === "export"
                      ? setExporting(row.object)
                      : setAction({ kind, object: row.object })
                  }
                  onDefinition={() => openDefinition(row.object)}
                  onDetails={() => setDetails(row.object)}
                />
              );
            })}
          </div>
        </div>
      )}

      {manage?.kind === "database" && (
        <DatabaseDialog
          connectionId={connectionId}
          mode={manage.mode}
          onClose={() => setManage(null)}
        />
      )}
      {manage?.kind === "schema" && (
        <SchemaDialog
          connectionId={connectionId}
          mode={manage.mode}
          current={schema}
          onClose={() => setManage(null)}
        />
      )}
      {creating && schema && (
        <CreateTableDialog
          connectionId={connectionId}
          schema={schema}
          onClose={() => setCreating(false)}
        />
      )}
      {details?.kind === "sequence" && (
        <SequenceDialog
          connectionId={connectionId}
          object={details}
          onClose={() => setDetails(null)}
        />
      )}
      {details?.kind === "enumType" && (
        <EnumDialog connectionId={connectionId} object={details} onClose={() => setDetails(null)} />
      )}
      {exporting && (
        <ExportDialog
          connectionId={connectionId}
          seed={{ kind: "tables", schema: exporting.schema, first: exporting.name }}
          onClose={() => setExporting(null)}
        />
      )}
      {action && (
        <ObjectActionDialog
          connectionId={connectionId}
          action={action.kind}
          object={action.object}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}
