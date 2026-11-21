/** The parts of the Structure view. No imports: it is read by the view state and by tests. */
export const SECTIONS = ["columns", "indexes", "constraints", "triggers", "info", "ddl"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  columns: "Columns",
  indexes: "Indexes",
  constraints: "Constraints",
  triggers: "Triggers",
  info: "Table info",
  ddl: "DDL",
};

/** What a table tab shows: its rows, or how it is built. */
export type TableMode = "data" | "structure";

/** The other mode: what ⌘⌥] and ⌘⌥[ switch to. */
export const otherMode = (mode: TableMode): TableMode => (mode === "data" ? "structure" : "data");
