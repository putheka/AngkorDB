/**
 * Every command that has a keyboard shortcut (ANG-52): its name, where it works and its default
 * keys. The handlers are not here; the screen that does the work registers one while it is open
 * (`useShortcut`). Pure; no alias imports (unit-tested in Node).
 */

/**
 * Where a command works. A shortcut can be shared by commands of different scopes (⌘F filters
 * the table, or the sidebar when the focus is there); not by two commands that can be active at
 * the same time, and `app` is active with everything.
 */
export type Scope = "app" | "sidebar" | "table" | "structure" | "query" | "editor";

export type Group =
  "General" | "File" | "View" | "Tabs" | "Tables" | "Structure" | "Queries" | "SQL editor";

export interface CommandDef {
  id: string;
  title: string;
  group: Group;
  scope: Scope;
  /** Chords, as `formatChordId` writes them. */
  keys: readonly string[];
  /** The native menu owns the key: it shows but can't be changed. */
  fixed?: boolean;
  /** Left out of the command palette (it only makes sense with the key). */
  hidden?: boolean;
}

const COPY_TITLES = {
  csv: "CSV",
  json: "JSON",
  markdown: "a Markdown table",
  insert: "INSERT statements",
  update: "UPDATE statements",
} as const;

const goto = (n: number): CommandDef => ({
  id: `tabs.goto.${n}`,
  title: n === 9 ? "Go to the last tab" : `Go to tab ${n}`,
  group: "Tabs",
  scope: "app",
  keys: [`Cmd+Digit${n}`],
  hidden: true,
});

export const COMMANDS: readonly CommandDef[] = [
  { id: "app.find", title: "Find an object", group: "General", scope: "app", keys: ["Cmd+KeyP"] },
  {
    id: "app.commands",
    title: "Run a command",
    group: "General",
    scope: "app",
    keys: ["Cmd+KeyK"],
    hidden: true,
  },
  {
    id: "app.reload",
    title: "Reload schema and rows",
    group: "General",
    scope: "app",
    keys: ["Cmd+KeyR"],
  },
  {
    id: "app.sidebar",
    title: "Show or hide the sidebar",
    group: "General",
    scope: "app",
    keys: ["Cmd+Digit0"],
  },
  {
    id: "app.settings",
    title: "Settings",
    group: "General",
    scope: "app",
    keys: ["Cmd+Comma"],
    // The menu bar's "Settings…" owns ⌘, in the app.
    fixed: true,
  },
  {
    id: "app.shortcuts",
    title: "Keyboard shortcuts",
    group: "General",
    scope: "app",
    keys: ["Shift+Cmd+Slash"],
  },

  {
    id: "app.checkUpdates",
    title: "Check for updates",
    group: "General",
    scope: "app",
    keys: [],
  },
  {
    id: "app.newConnection",
    title: "New connection",
    group: "File",
    scope: "app",
    keys: ["Cmd+KeyN"],
  },
  { id: "file.import", title: "Import a file", group: "File", scope: "app", keys: [] },
  { id: "file.export", title: "Export", group: "File", scope: "app", keys: ["Shift+Cmd+KeyE"] },
  { id: "file.backup", title: "Back up the database", group: "File", scope: "app", keys: [] },
  { id: "file.restore", title: "Restore a backup", group: "File", scope: "app", keys: [] },
  { id: "edit.find", title: "Find", group: "General", scope: "app", keys: ["Cmd+KeyF"] },
  ...(["csv", "json", "markdown", "insert", "update"] as const).map((format): CommandDef => ({
    id: `grid.copy.${format}`,
    title: `Copy rows as ${COPY_TITLES[format]}`,
    group: "Tables",
    scope: "table",
    keys: [],
  })),
  {
    id: "table.export",
    title: "Export the table",
    group: "Tables",
    scope: "table",
    keys: [],
    hidden: true,
  },
  {
    id: "table.detail",
    title: "Show or hide the row details",
    group: "Tables",
    scope: "table",
    keys: ["Alt+Cmd+KeyD"],
  },
  {
    id: "app.theme.system",
    title: "Match macOS appearance",
    group: "View",
    scope: "app",
    keys: [],
  },
  { id: "app.theme.light", title: "Light appearance", group: "View", scope: "app", keys: [] },
  { id: "app.theme.dark", title: "Dark appearance", group: "View", scope: "app", keys: [] },
  { id: "view.zoomIn", title: "Zoom in", group: "View", scope: "app", keys: ["Cmd+Equal"] },
  { id: "view.zoomOut", title: "Zoom out", group: "View", scope: "app", keys: ["Cmd+Minus"] },
  {
    id: "view.zoomReset",
    title: "Actual size",
    group: "View",
    scope: "app",
    keys: ["Alt+Cmd+Digit0"],
  },
  {
    id: "query.export",
    title: "Export the result",
    group: "Queries",
    scope: "query",
    keys: [],
    hidden: true,
  },
  {
    id: "query.explain",
    title: "Explain the statement",
    group: "Queries",
    scope: "query",
    keys: ["Cmd+KeyE"],
  },
  {
    id: "query.analyze",
    title: "Explain and run the statement",
    group: "Queries",
    scope: "query",
    keys: ["Alt+Cmd+KeyE"],
  },

  { id: "tabs.new", title: "New query tab", group: "Tabs", scope: "app", keys: ["Cmd+KeyT"] },
  {
    id: "tabs.close",
    title: "Close tab",
    group: "Tabs",
    scope: "app",
    keys: ["Cmd+KeyW"],
    fixed: true,
    hidden: true,
  },
  {
    id: "tabs.next",
    title: "Next tab",
    group: "Tabs",
    scope: "app",
    keys: ["Shift+Cmd+BracketRight", "Ctrl+Tab"],
  },
  {
    id: "tabs.previous",
    title: "Previous tab",
    group: "Tabs",
    scope: "app",
    keys: ["Shift+Cmd+BracketLeft", "Ctrl+Shift+Tab"],
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(goto),

  { id: "table.save", title: "Save changes", group: "Tables", scope: "table", keys: ["Cmd+KeyS"] },
  {
    id: "table.preview",
    title: "Show the SQL of the changes",
    group: "Tables",
    scope: "table",
    keys: ["Shift+Cmd+KeyP"],
  },
  {
    id: "table.discard",
    title: "Discard changes",
    group: "Tables",
    scope: "table",
    keys: ["Shift+Cmd+Backspace"],
  },
  { id: "table.addRow", title: "Add a row", group: "Tables", scope: "table", keys: ["Cmd+KeyI"] },
  // ⌘F belongs to "Find", which asks the sidebar and the table in turn.
  { id: "table.filter", title: "Filter rows", group: "Tables", scope: "table", keys: [] },
  {
    id: "table.mode",
    title: "Switch between rows and structure",
    group: "Tables",
    scope: "table",
    keys: ["Alt+Cmd+BracketRight", "Alt+Cmd+BracketLeft"],
  },
  {
    id: "sidebar.filter",
    title: "Search the sidebar",
    group: "General",
    scope: "sidebar",
    keys: [],
    hidden: true,
  },

  {
    id: "structure.save",
    title: "Save the structure",
    group: "Structure",
    scope: "structure",
    keys: ["Cmd+KeyS"],
  },

  {
    id: "query.save",
    title: "Save the query",
    group: "Queries",
    scope: "query",
    keys: ["Shift+Cmd+KeyS"],
  },
  {
    id: "query.stop",
    title: "Stop the running query",
    group: "Queries",
    scope: "query",
    keys: ["Cmd+Period"],
  },

  {
    id: "editor.run",
    title: "Run the statement or selection",
    group: "SQL editor",
    scope: "editor",
    keys: ["Cmd+Enter"],
  },
  {
    id: "editor.runAll",
    title: "Run everything",
    group: "SQL editor",
    scope: "editor",
    keys: ["Shift+Cmd+Enter"],
  },
  {
    id: "editor.format",
    title: "Format the SQL",
    group: "SQL editor",
    scope: "editor",
    keys: ["Shift+Cmd+KeyF"],
  },
  {
    id: "editor.comment",
    title: "Comment or uncomment",
    group: "SQL editor",
    scope: "editor",
    keys: ["Cmd+Slash"],
  },
  {
    id: "editor.duplicateLine",
    title: "Copy the line down",
    group: "SQL editor",
    scope: "editor",
    keys: ["Shift+Cmd+KeyD"],
  },
  {
    id: "editor.selectNext",
    title: "Select the next occurrence",
    group: "SQL editor",
    scope: "editor",
    keys: ["Cmd+KeyD"],
  },
];

export const GROUP_ORDER: readonly Group[] = [
  "General",
  "File",
  "View",
  "Tabs",
  "Tables",
  "Structure",
  "Queries",
  "SQL editor",
];

/**
 * Commands that stand for a few others and ask them in turn: "Find" filters the sidebar when the
 * focus is there, else the table; "Export" exports the table or the query in front. They are
 * available when one of them is.
 */
export const MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "edit.find": ["sidebar.filter", "table.filter"],
  "file.export": ["table.export", "query.export"],
};

/**
 * The commands that have an item in the native menu bar (`src-tauri/src/menu.rs`; a test there
 * checks that the two lists are the same). The two whose keys the menu owns are left out of the
 * updates the page sends.
 */
export const MENU_COMMAND_IDS: readonly string[] = [
  "app.checkUpdates",
  "app.newConnection",
  "tabs.new",
  "app.find",
  "file.import",
  "file.export",
  "file.backup",
  "file.restore",
  "tabs.close",
  "grid.copy.csv",
  "grid.copy.json",
  "grid.copy.markdown",
  "grid.copy.insert",
  "grid.copy.update",
  "edit.find",
  "app.sidebar",
  "table.mode",
  "table.detail",
  "app.theme.system",
  "app.theme.light",
  "app.theme.dark",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomReset",
  "editor.run",
  "editor.runAll",
  "query.stop",
  "query.explain",
  "query.analyze",
  "editor.format",
  "query.save",
  "tabs.next",
  "tabs.previous",
  "app.shortcuts",
  "app.settings",
];

export const commandById = (id: string): CommandDef | undefined =>
  COMMANDS.find((c) => c.id === id);
