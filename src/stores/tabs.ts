import { create } from "zustand";

import type { ObjectKind } from "@/bindings";

interface TabBase {
  id: string;
  /** Opened with a single click: shown in italics, and the next single click replaces it. */
  preview: boolean;
}

/** A table, view or materialized view. */
export interface TableTab extends TabBase {
  kind: "table";
  schema: string;
  name: string;
  objectKind: ObjectKind;
}

/** A SQL editor. `number` is what the title says: Query 1, Query 2, … */
export interface QueryTab extends TabBase {
  kind: "query";
  number: number;
}

/** The process list. There is one per connection. */
export interface ActivityTab extends TabBase {
  kind: "activity";
}

/** Roles, their privileges and the default privileges. There is one per connection. */
export interface RolesTab extends TabBase {
  kind: "roles";
}

export type Tab = TableTab | QueryTab | ActivityTab | RolesTab;

export const ACTIVITY_TAB_ID = "activity";
export const ROLES_TAB_ID = "roles";

export const tableTabId = (schema: string, name: string) => `table:${schema}.${name}`;

export const tabTitle = (tab: Tab) => {
  switch (tab.kind) {
    case "table":
      return tab.name;
    case "activity":
      return "Activity";
    case "roles":
      return "Roles";
    case "query":
      return `Query ${tab.number}`;
  }
};

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  nextQueryNumber: number;

  /**
   * Show a table: focus its tab, or open one. Without `pin` a new tab is a preview that takes
   * the place of the current preview; with it (double-click, Enter) the tab stays.
   */
  openTable: (object: { schema: string; name: string; kind: ObjectKind }, pin?: boolean) => void;
  newQuery: () => void;
  /** Show the process list: focus its tab, or open one. */
  openActivity: () => void;
  /** Show roles and privileges: focus its tab, or open one. */
  openRoles: () => void;
  activate: (id: string) => void;
  /** 0-based; out of range picks the last tab. */
  activateIndex: (index: number) => void;
  /** Next (`1`) or previous (`-1`) tab, wrapping around. */
  cycle: (direction: 1 | -1) => void;
  /** Turn a preview into a permanent tab. */
  pin: (id: string) => void;
  move: (id: string, toIndex: number) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
  closeAll: () => void;
}

/** What is left after removing tabs: the same front tab if it survived, else `fallback`. */
function keepFront(tabs: Tab[], activeId: string | null, fallback: string | null) {
  return tabs.some((t) => t.id === activeId) ? activeId : fallback;
}

export const useTabsStore = create<TabsState>()((set) => ({
  tabs: [],
  activeId: null,
  nextQueryNumber: 1,

  openTable: ({ schema, name, kind }, pin = false) =>
    set((state) => {
      const id = tableTabId(schema, name);
      const existing = state.tabs.find((t) => t.id === id);
      if (existing) {
        const tabs =
          pin && existing.preview
            ? state.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t))
            : state.tabs;
        return { tabs, activeId: id };
      }

      const tab: TableTab = { id, kind: "table", schema, name, objectKind: kind, preview: !pin };
      const previewAt = pin ? -1 : state.tabs.findIndex((t) => t.preview);
      const tabs =
        previewAt === -1
          ? [...state.tabs, tab]
          : state.tabs.map((t, i) => (i === previewAt ? tab : t));
      return { tabs, activeId: id };
    }),

  newQuery: () =>
    set((state) => {
      const number = state.nextQueryNumber;
      const tab: QueryTab = { id: `query:${number}`, kind: "query", number, preview: false };
      return { tabs: [...state.tabs, tab], activeId: tab.id, nextQueryNumber: number + 1 };
    }),

  openActivity: () =>
    set((state) => {
      if (state.tabs.some((t) => t.id === ACTIVITY_TAB_ID)) return { activeId: ACTIVITY_TAB_ID };
      const tab: ActivityTab = { id: ACTIVITY_TAB_ID, kind: "activity", preview: false };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }),

  openRoles: () =>
    set((state) => {
      if (state.tabs.some((t) => t.id === ROLES_TAB_ID)) return { activeId: ROLES_TAB_ID };
      const tab: RolesTab = { id: ROLES_TAB_ID, kind: "roles", preview: false };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }),

  activate: (id) =>
    set((state) => (state.tabs.some((t) => t.id === id) ? { activeId: id } : state)),

  activateIndex: (index) =>
    set((state) => {
      const tab = state.tabs[index] ?? state.tabs[state.tabs.length - 1];
      return tab ? { activeId: tab.id } : state;
    }),

  cycle: (direction) =>
    set((state) => {
      const count = state.tabs.length;
      if (count < 2) return state;
      const current = state.tabs.findIndex((t) => t.id === state.activeId);
      const next = state.tabs[(current + direction + count) % count];
      return next ? { activeId: next.id } : state;
    }),

  pin: (id) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) })),

  move: (id, toIndex) =>
    set((state) => {
      const from = state.tabs.findIndex((t) => t.id === id);
      const tab = state.tabs[from];
      if (!tab || from === toIndex || toIndex < 0 || toIndex >= state.tabs.length) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      tabs.splice(toIndex, 0, tab);
      return { tabs };
    }),

  close: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      // Closing the front tab brings its right neighbour forward, else the left one.
      const neighbour = (tabs[index] ?? tabs[index - 1])?.id ?? null;
      return { tabs, activeId: keepFront(tabs, state.activeId, neighbour) };
    }),

  closeOthers: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id === id);
      return { tabs, activeId: tabs[0]?.id ?? null };
    }),

  closeToRight: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.slice(0, index + 1);
      return { tabs, activeId: keepFront(tabs, state.activeId, id) };
    }),

  closeAll: () => set({ tabs: [], activeId: null, nextQueryNumber: 1 }),
}));
