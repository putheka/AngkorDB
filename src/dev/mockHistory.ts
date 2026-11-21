import type { HistoryEntry, SavedQuery, SavedQueryInput } from "@/bindings";
import { appError, type Handler } from "@/dev/mockSupport";

const MAX_HISTORY = 10_000;
let history: HistoryEntry[] = [];
let saved: SavedQuery[] = [];
let nextId = 1;

/** What the Rust side does for every statement a run executes. */
export function recordHistory(connectionId: string, sql: string, durationMs: number, ok: boolean) {
  const text = sql.trim();
  if (!text) return;
  // Like the Rust side: a statement that gives a password a value is not kept.
  const hidden = /(?<![\w'])pass(?:word|wd)\b"?\s*(?:=|'|\$|e')/i.test(
    text.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " "),
  );
  const stored = hidden ? "-- statement not kept: it contains a password" : text;
  const last = history.find((h) => h.connectionId === connectionId);
  if (last && last.sql === stored) {
    Object.assign(last, { ranAt: Date.now(), durationMs, ok });
    return;
  }
  history = [
    { id: nextId++, connectionId, sql: stored, ranAt: Date.now(), durationMs, ok },
    ...history,
  ].slice(0, MAX_HISTORY);
}

export function createHistoryHandlers(): Record<string, Handler> {
  return {
    list_history: (args): HistoryEntry[] => {
      const words = String(args["query"]).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      const connectionId = args["connectionId"] as string | null;
      return history
        .filter((h) => connectionId === null || h.connectionId === connectionId)
        .filter((h) => words.every((w) => h.sql.toLowerCase().includes(w)))
        .slice(Number(args["offset"]), Number(args["offset"]) + Number(args["limit"]));
    },
    delete_history_entry: (args) => {
      history = history.filter((h) => h.id !== Number(args["id"]));
      return null;
    },
    clear_history: (args) => {
      const connectionId = args["connectionId"] as string | null;
      history = connectionId === null ? [] : history.filter((h) => h.connectionId !== connectionId);
      return null;
    },
    list_saved_queries: (args): SavedQuery[] => {
      const connectionId = args["connectionId"] as string | null;
      return [...saved]
        .filter(
          (q) =>
            connectionId === null || q.connectionId === null || q.connectionId === connectionId,
        )
        .sort(
          (a, b) =>
            a.folder.localeCompare(b.folder, undefined, { sensitivity: "base" }) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
            a.id - b.id,
        );
    },
    save_query: (args): SavedQuery => {
      const input = args["input"] as SavedQueryInput;
      const name = input.name.trim();
      if (!name) throw appError("VALIDATION", "Give the query a name.");
      if (!input.sql.trim()) throw appError("VALIDATION", "There is no SQL to save.");
      const folder = input.folder.trim();
      if (input.id !== null) {
        const existing = saved.find((q) => q.id === input.id);
        if (!existing) throw appError("NOT_FOUND", `saved query ${input.id}`);
        Object.assign(existing, { name, folder, sql: input.sql, connectionId: input.connectionId });
        return { ...existing };
      }
      const created: SavedQuery = {
        id: nextId++,
        connectionId: input.connectionId,
        name,
        folder,
        sql: input.sql,
        createdAt: Date.now(),
      };
      saved = [...saved, created];
      return created;
    },
    delete_saved_query: (args) => {
      saved = saved.filter((q) => q.id !== Number(args["id"]));
      return null;
    },
  };
}
