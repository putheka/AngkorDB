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

export type Group = "General" | "Tabs" | "Tables" | "Structure" | "Queries" | "SQL editor";

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
    id: "app.shortcuts",
    title: "Keyboard shortcuts",
    group: "General",
    scope: "app",
    keys: ["Shift+Cmd+Slash"],
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
  { id: "table.filter", title: "Filter rows", group: "Tables", scope: "table", keys: ["Cmd+KeyF"] },
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
    keys: ["Cmd+KeyF"],
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
  "Tabs",
  "Tables",
  "Structure",
  "Queries",
  "SQL editor",
];

export const commandById = (id: string): CommandDef | undefined =>
  COMMANDS.find((c) => c.id === id);
