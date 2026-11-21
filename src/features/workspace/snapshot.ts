/**
 * The workspace of one connection as it is kept between launches (ANG-50): which tabs are open
 * and which is in front, the text of each query editor and how each table is sorted, filtered
 * and laid out. Pure: the stores read and write it elsewhere.
 *
 * Whatever comes back from disk is checked piece by piece: a file from an older or damaged run
 * loses what it can't prove is valid and still opens.
 */
import type { FilterOp, ObjectKind, SortSpec } from "../../bindings.ts";
import type { Tab } from "../../stores/tabs.ts";
import type { ColumnLayout } from "../grid/columns.ts";
import type { FilterDraft, FilterState } from "../grid/filters.ts";
import type { Section, TableMode } from "../structure/sections.ts";

export const WORKSPACE_VERSION = 1;

/** What of a query tab is kept (not its results, nor whether it is running). */
export interface SavedQuery {
  text: string;
  selection: { anchor: number; head: number };
  editorHeight: number;
  layout: "below" | "right";
  editorWidth: number;
  historyOpen: boolean;
}

/** What of a table tab is kept: how it was sorted, paged, filtered and laid out. */
export interface SavedTable {
  sort: SortSpec[];
  page: number;
  pageSize: number;
  layout: ColumnLayout;
  filter: FilterState;
  mode: TableMode;
  section: Section;
}

export interface Workspace {
  version: typeof WORKSPACE_VERSION;
  tabs: Tab[];
  activeId: string | null;
  nextQueryNumber: number;
  /** The schema chosen in the sidebar. */
  schema: string | null;
  queries: Record<string, SavedQuery>;
  tables: Record<string, SavedTable>;
}

export interface WorkspaceInput {
  tabs: readonly Tab[];
  activeId: string | null;
  nextQueryNumber: number;
  schema: string | null;
  queryViews: Readonly<Record<string, SavedQuery>>;
  tableViews: Readonly<Record<string, SavedTable>>;
}

/** The workspace to keep: the open tabs and the views of those tabs, nothing of closed ones. */
export function captureWorkspace(input: WorkspaceInput): Workspace {
  const queries: Record<string, SavedQuery> = {};
  const tables: Record<string, SavedTable> = {};
  for (const tab of input.tabs) {
    if (tab.kind === "query") {
      const view = input.queryViews[tab.id];
      if (view) queries[tab.id] = pickQuery(view);
    } else if (tab.kind === "table") {
      const view = input.tableViews[tab.id];
      if (view) tables[tab.id] = pickTable(view);
    }
  }
  return {
    version: WORKSPACE_VERSION,
    tabs: input.tabs.map((tab) => ({ ...tab })),
    activeId: input.activeId,
    nextQueryNumber: input.nextQueryNumber,
    schema: input.schema,
    queries,
    tables,
  };
}

/** Only the kept fields, whatever else the view holds (results, timers). */
function pickQuery(view: SavedQuery): SavedQuery {
  return {
    text: view.text,
    selection: { anchor: view.selection.anchor, head: view.selection.head },
    editorHeight: view.editorHeight,
    layout: view.layout,
    editorWidth: view.editorWidth,
    historyOpen: view.historyOpen,
  };
}

function pickTable(view: SavedTable): SavedTable {
  return {
    sort: view.sort,
    page: view.page,
    pageSize: view.pageSize,
    layout: view.layout,
    filter: view.filter,
    mode: view.mode,
    section: view.section,
  };
}

export const serializeWorkspace = (workspace: Workspace): string => JSON.stringify(workspace);

// ---- reading it back --------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
const int = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), min), max)
    : fallback;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

// If a union grows, these stop compiling until the new member is listed.
const OBJECT_KINDS: Record<ObjectKind, true> = {
  table: true,
  partitionedTable: true,
  foreignTable: true,
  view: true,
  materializedView: true,
  sequence: true,
  function: true,
  procedure: true,
  enumType: true,
};
const SECTIONS: Record<Section, true> = {
  columns: true,
  indexes: true,
  constraints: true,
  triggers: true,
  info: true,
  ddl: true,
};
const FILTER_OPS: Record<FilterOp, true> = {
  eq: true,
  ne: true,
  lt: true,
  gt: true,
  le: true,
  ge: true,
  like: true,
  iLike: true,
  in: true,
  isNull: true,
  isNotNull: true,
  between: true,
};
const isKey = <K extends string>(set: Record<K, true>, value: unknown): value is K =>
  typeof value === "string" && Object.hasOwn(set, value);

/** The largest text of one editor that is restored (the file as a whole has its own limit). */
const MAX_TEXT = 2_000_000;

function readTab(value: unknown): Tab | null {
  if (!isObj(value)) return null;
  const id = str(value["id"]);
  if (!id) return null;
  const preview = bool(value["preview"], false);
  switch (value["kind"]) {
    case "query": {
      const number = int(value["number"], 1, 1_000_000, 0);
      return number > 0 && id === `query:${number}`
        ? { id, kind: "query", number, preview: false }
        : null;
    }
    case "activity":
      return id === "activity" ? { id, kind: "activity", preview: false } : null;
    case "roles":
      return id === "roles" ? { id, kind: "roles", preview: false } : null;
    case "table": {
      const schema = str(value["schema"]);
      const name = str(value["name"]);
      const kind = value["objectKind"];
      if (!schema || !name || !isKey(OBJECT_KINDS, kind)) return null;
      return id === `table:${schema}.${name}`
        ? { id, kind: "table", schema, name, objectKind: kind, preview }
        : null;
    }
    default:
      return null;
  }
}

function readQuery(value: unknown): SavedQuery | null {
  if (!isObj(value) || typeof value["text"] !== "string") return null;
  const text = value["text"].slice(0, MAX_TEXT);
  const selection = isObj(value["selection"]) ? value["selection"] : {};
  return {
    text,
    // A cursor past the end of the text would make the editor refuse to open.
    selection: {
      anchor: int(selection["anchor"], 0, text.length, 0),
      head: int(selection["head"], 0, text.length, 0),
    },
    editorHeight: int(value["editorHeight"], 96, 4000, 240),
    layout: value["layout"] === "right" ? "right" : "below",
    editorWidth: int(value["editorWidth"], 240, 4000, 560),
    historyOpen: bool(value["historyOpen"], false),
  };
}

function readSort(value: unknown): SortSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) =>
    isObj(entry) &&
    typeof entry["column"] === "string" &&
    (entry["dir"] === "asc" || entry["dir"] === "desc")
      ? [{ column: entry["column"], dir: entry["dir"] }]
      : [],
  );
}

function readLayout(value: unknown): ColumnLayout {
  const layout = isObj(value) ? value : {};
  const widths: Record<string, number> = {};
  if (isObj(layout["widths"])) {
    for (const [column, width] of Object.entries(layout["widths"])) {
      if (typeof width === "number" && Number.isFinite(width)) {
        widths[column] = int(width, 20, 4000, 120);
      }
    }
  }
  return { order: strings(layout["order"]), hidden: strings(layout["hidden"]), widths };
}

function readFilter(value: unknown): FilterState {
  const filter = isObj(value) ? value : {};
  const drafts: FilterDraft[] = Array.isArray(filter["drafts"])
    ? filter["drafts"].flatMap((d: unknown) =>
        isObj(d) && isKey(FILTER_OPS, d["op"]) && typeof d["column"] === "string"
          ? [
              {
                id: str(d["id"], d["column"]),
                column: d["column"],
                op: d["op"],
                values: strings(d["values"]),
              },
            ]
          : [],
      )
    : [];
  const applied = isObj(filter["applied"]) ? filter["applied"] : {};
  const filters = Array.isArray(applied["filters"])
    ? applied["filters"].flatMap((f: unknown) =>
        isObj(f) && isKey(FILTER_OPS, f["op"]) && typeof f["column"] === "string"
          ? [{ column: f["column"], op: f["op"], values: strings(f["values"]) }]
          : [],
      )
    : [];
  return {
    open: bool(filter["open"], false),
    mode: filter["mode"] === "raw" ? "raw" : "conditions",
    drafts,
    rawText: str(filter["rawText"]),
    applied: {
      filters,
      rawWhere: typeof applied["rawWhere"] === "string" ? applied["rawWhere"] : null,
    },
  };
}

function readTable(value: unknown): SavedTable | null {
  if (!isObj(value)) return null;
  return {
    sort: readSort(value["sort"]),
    page: int(value["page"], 0, 1_000_000, 0),
    pageSize: int(value["pageSize"], 1, 10_000, 500),
    layout: readLayout(value["layout"]),
    filter: readFilter(value["filter"]),
    mode: value["mode"] === "structure" ? "structure" : "data",
    section: isKey(SECTIONS, value["section"]) ? value["section"] : "columns",
  };
}

/**
 * The workspace in `text`, reduced to what is valid; `null` when it is not a workspace of this
 * version at all (then nothing is restored, and the app opens as usual).
 */
export function parseWorkspace(text: string): Workspace | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw["version"] !== WORKSPACE_VERSION || !Array.isArray(raw["tabs"])) {
    return null;
  }

  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const entry of raw["tabs"]) {
    const tab = readTab(entry);
    if (tab && !seen.has(tab.id)) {
      seen.add(tab.id);
      tabs.push(tab);
    }
  }

  const queries: Record<string, SavedQuery> = {};
  const tables: Record<string, SavedTable> = {};
  const savedQueries = isObj(raw["queries"]) ? raw["queries"] : {};
  const savedTables = isObj(raw["tables"]) ? raw["tables"] : {};
  for (const tab of tabs) {
    if (tab.kind === "query") {
      const view = readQuery(savedQueries[tab.id]);
      if (view) queries[tab.id] = view;
    } else if (tab.kind === "table") {
      const view = readTable(savedTables[tab.id]);
      if (view) tables[tab.id] = view;
    }
  }

  const highest = tabs.reduce((n, tab) => (tab.kind === "query" ? Math.max(n, tab.number) : n), 0);
  const activeId =
    typeof raw["activeId"] === "string" && seen.has(raw["activeId"])
      ? raw["activeId"]
      : (tabs[0]?.id ?? null);
  return {
    version: WORKSPACE_VERSION,
    tabs,
    activeId,
    // The next new query must not reuse the number of one that is back.
    nextQueryNumber: Math.max(int(raw["nextQueryNumber"], 1, 1_000_000, 1), highest + 1),
    schema: typeof raw["schema"] === "string" && raw["schema"] !== "" ? raw["schema"] : null,
    queries,
    tables,
  };
}
