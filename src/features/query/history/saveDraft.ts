import type { SavedQuery } from "@/bindings";

/** What the dialog starts with: a new query (no `id`) or a saved one to change. */
export interface SaveQueryDraft {
  id: number | null;
  name: string;
  folder: string;
  sql: string;
  /** Only usable on this connection (the default), or on every connection. */
  forThisConnection: boolean;
}

export const draftFromSaved = (query: SavedQuery): SaveQueryDraft => ({
  id: query.id,
  name: query.name,
  folder: query.folder,
  sql: query.sql,
  forThisConnection: query.connectionId !== null,
});
