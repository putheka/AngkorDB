import type { Filter, FilterOp } from "@/bindings";

/** What an operator needs typed in. `list` is one box with comma-separated values. */
export type Arity = 0 | 1 | 2 | "list";

export const OPERATORS: { op: FilterOp; label: string; arity: Arity }[] = [
  { op: "eq", label: "=", arity: 1 },
  { op: "ne", label: "!=", arity: 1 },
  { op: "lt", label: "<", arity: 1 },
  { op: "gt", label: ">", arity: 1 },
  { op: "le", label: "<=", arity: 1 },
  { op: "ge", label: ">=", arity: 1 },
  { op: "like", label: "LIKE", arity: 1 },
  { op: "iLike", label: "ILIKE", arity: 1 },
  { op: "in", label: "IN", arity: "list" },
  { op: "between", label: "BETWEEN", arity: 2 },
  { op: "isNull", label: "IS NULL", arity: 0 },
  { op: "isNotNull", label: "IS NOT NULL", arity: 0 },
];

export const arityOf = (op: FilterOp): Arity => OPERATORS.find((o) => o.op === op)?.arity ?? 1;

/** One row of the filter bar while it is being edited. */
export interface FilterDraft {
  id: string;
  column: string;
  op: FilterOp;
  /** Text as typed: one box (or two for BETWEEN). IN keeps its comma-separated list in `[0]`. */
  values: string[];
}

export interface FilterState {
  /** The bar is showing. */
  open: boolean;
  mode: "conditions" | "raw";
  drafts: FilterDraft[];
  /** The `WHERE` text typed in raw mode. */
  rawText: string;
  /** What the rows on screen were fetched with. Changes only when the user applies. */
  applied: { filters: Filter[]; rawWhere: string | null };
}

export const EMPTY_FILTER: FilterState = {
  open: false,
  mode: "conditions",
  drafts: [],
  rawText: "",
  applied: { filters: [], rawWhere: null },
};

let counter = 0;
export function newDraft(
  column: string,
  op: FilterOp = "eq",
  values: string[] = [""],
): FilterDraft {
  counter += 1;
  return { id: `f${counter}`, column, op, values };
}

/**
 * `a, b, "c, d"` → `a`, `b`, `c, d`. Quotes protect commas; a doubled quote inside is one quote.
 */
export function parseList(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '"') {
      if (quoted && text.charAt(i + 1) === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** The values the server needs for a draft, or the reason it isn't ready. */
function draftValues(draft: FilterDraft): string[] | string {
  const arity = arityOf(draft.op);
  const first = draft.values[0] ?? "";
  const second = draft.values[1] ?? "";
  switch (arity) {
    case 0:
      return [];
    case 1:
      return first === "" ? `Enter a value for ${draft.column}.` : [first];
    case 2:
      return first === "" || second === ""
        ? `Enter both values for ${draft.column}.`
        : [first, second];
    case "list": {
      const items = parseList(first);
      return items.length === 0 ? `Enter at least one value for ${draft.column}.` : items;
    }
  }
}

/** Is this row untouched: a value operator with nothing typed. */
const isBlank = (draft: FilterDraft) =>
  arityOf(draft.op) !== 0 && draft.values.every((v) => v.trim() === "");

/**
 * The server-side filters for the rows of the bar, or what is wrong with them. A single blank
 * row means "no filter"; a blank row among others is a mistake worth pointing out.
 */
export function toFilters(drafts: FilterDraft[]): { filters: Filter[]; error: string | null } {
  if (drafts.length === 1 && drafts.every(isBlank)) return { filters: [], error: null };
  const filters: Filter[] = [];
  for (const draft of drafts) {
    const values = draftValues(draft);
    if (typeof values === "string") return { filters: [], error: values };
    filters.push({ column: draft.column, op: draft.op, values });
  }
  return { filters, error: null };
}

/** How many conditions are in force: each filter, plus the raw `WHERE` if there is one. */
export const appliedCount = (state: FilterState) =>
  state.applied.filters.length + (state.applied.rawWhere ? 1 : 0);

/** The state after the user applies what is in the bar. */
export function apply(state: FilterState): { state: FilterState; error: string | null } {
  if (state.mode === "raw") {
    const rawWhere = state.rawText.trim() === "" ? null : state.rawText.trim();
    return { state: { ...state, applied: { filters: [], rawWhere } }, error: null };
  }
  const { filters, error } = toFilters(state.drafts);
  if (error) return { state, error };
  return { state: { ...state, applied: { filters, rawWhere: null } }, error: null };
}

/** Add `column = value` (or `IS NULL`) to what is applied, as "Filter by this value" does. */
export function withValueFilter(
  state: FilterState,
  column: string,
  value: string | null,
): FilterState {
  // Keep the rows already in force; a half-typed or blank row would make the whole set invalid.
  const kept =
    state.mode === "conditions"
      ? state.drafts.filter((d) => !isBlank(d) && typeof draftValues(d) !== "string")
      : [];
  const added = value === null ? newDraft(column, "isNull", []) : newDraft(column, "eq", [value]);
  const drafts = [...kept, added];
  return {
    ...state,
    open: true,
    mode: "conditions",
    drafts,
    applied: { filters: toFilters(drafts).filters, rawWhere: null },
  };
}

/** A row for `column` with nothing typed yet. */
const blankDraft = (column: string) => newDraft(column, "eq", [""]);

/** Show the bar, with one empty row if it has none. */
export function openBar(state: FilterState, column: string): FilterState {
  const drafts = state.drafts.length > 0 ? state.drafts : [blankDraft(column)];
  return { ...state, open: true, drafts };
}

export function updateDraft(
  state: FilterState,
  id: string,
  patch: Partial<Pick<FilterDraft, "column" | "values">>,
): FilterState {
  return { ...state, drafts: state.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)) };
}

/** Switch the operator. Typed values stay where they still make sense. */
export function changeOperator(state: FilterState, id: string, op: FilterOp): FilterState {
  const resize = (values: string[]): string[] => {
    const arity = arityOf(op);
    if (arity === 0) return [];
    if (arity === 2) return [values[0] ?? "", values[1] ?? ""];
    return [values[0] ?? ""];
  };
  return {
    ...state,
    drafts: state.drafts.map((d) => (d.id === id ? { ...d, op, values: resize(d.values) } : d)),
  };
}

/** The `+` button: a new row under this one. */
export function addDraftAfter(state: FilterState, id: string, column: string): FilterState {
  const at = state.drafts.findIndex((d) => d.id === id);
  const drafts = [...state.drafts];
  drafts.splice(at === -1 ? drafts.length : at + 1, 0, blankDraft(column));
  return { ...state, drafts };
}

/** The `−` button. The last row can't go; it is emptied instead. */
export function removeDraft(state: FilterState, id: string, column: string): FilterState {
  const drafts = state.drafts.filter((d) => d.id !== id);
  return { ...state, drafts: drafts.length > 0 ? drafts : [blankDraft(column)] };
}

/** "Clear all": no conditions in the bar, nothing applied. The bar stays open. */
export function clearAll(state: FilterState, column: string): FilterState {
  return {
    ...state,
    drafts: [blankDraft(column)],
    rawText: "",
    applied: { filters: [], rawWhere: null },
  };
}

/** Do the rows in the bar differ from what is applied? Used to nudge the user to press Apply. */
export function isDirty(state: FilterState): boolean {
  const next = apply(state);
  if (next.error) return true;
  return JSON.stringify(next.state.applied) !== JSON.stringify(state.applied);
}
