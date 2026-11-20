import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 260;
export const DETAIL_MIN = 280;
export const DETAIL_MAX = 640;
export const DETAIL_DEFAULT = 360;

const clampWidth = (width: number) =>
  Math.min(Math.max(Math.round(width), SIDEBAR_MIN), SIDEBAR_MAX);

const clampDetail = (width: number) =>
  Math.min(Math.max(Math.round(width), DETAIL_MIN), DETAIL_MAX);

interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** The row detail panel on the right of a table (Space). */
  detailOpen: boolean;
  detailWidth: number;
  setDetailWidth: (width: number) => void;
  toggleDetail: () => void;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;
  toggleSidebar: () => void;
}

/** What survives a restart. Anything unexpected in storage falls back to the defaults. */
function readSaved(
  value: unknown,
): Partial<Pick<LayoutState, "sidebarWidth" | "sidebarCollapsed" | "detailOpen" | "detailWidth">> {
  if (typeof value !== "object" || value === null) return {};
  const saved: ReturnType<typeof readSaved> = {};
  if ("sidebarWidth" in value && typeof value.sidebarWidth === "number") {
    if (Number.isFinite(value.sidebarWidth)) saved.sidebarWidth = clampWidth(value.sidebarWidth);
  }
  if ("sidebarCollapsed" in value && typeof value.sidebarCollapsed === "boolean") {
    saved.sidebarCollapsed = value.sidebarCollapsed;
  }
  if ("detailOpen" in value && typeof value.detailOpen === "boolean") {
    saved.detailOpen = value.detailOpen;
  }
  if ("detailWidth" in value && typeof value.detailWidth === "number") {
    if (Number.isFinite(value.detailWidth)) saved.detailWidth = clampDetail(value.detailWidth);
  }
  return saved;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR_DEFAULT,
      sidebarCollapsed: false,
      detailOpen: false,
      detailWidth: DETAIL_DEFAULT,
      setDetailWidth: (width) => set({ detailWidth: clampDetail(width) }),
      toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
      resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_DEFAULT }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: "angkordb.layout",
      version: 1,
      // If storage is blocked (private window, cleared site data) the layout just isn't remembered.
      storage: createJSONStorage(() => localStorage),
      partialize: ({ sidebarWidth, sidebarCollapsed, detailOpen, detailWidth }) => ({
        sidebarWidth,
        sidebarCollapsed,
        detailOpen,
        detailWidth,
      }),
      merge: (saved, current) => ({ ...current, ...readSaved(saved) }),
    },
  ),
);
