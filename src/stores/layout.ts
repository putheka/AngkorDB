import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 260;

const clampWidth = (width: number) =>
  Math.min(Math.max(Math.round(width), SIDEBAR_MIN), SIDEBAR_MAX);

interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;
  toggleSidebar: () => void;
}

/** What survives a restart. Anything unexpected in storage falls back to the defaults. */
function readSaved(
  value: unknown,
): Partial<Pick<LayoutState, "sidebarWidth" | "sidebarCollapsed">> {
  if (typeof value !== "object" || value === null) return {};
  const saved: ReturnType<typeof readSaved> = {};
  if ("sidebarWidth" in value && typeof value.sidebarWidth === "number") {
    if (Number.isFinite(value.sidebarWidth)) saved.sidebarWidth = clampWidth(value.sidebarWidth);
  }
  if ("sidebarCollapsed" in value && typeof value.sidebarCollapsed === "boolean") {
    saved.sidebarCollapsed = value.sidebarCollapsed;
  }
  return saved;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: SIDEBAR_DEFAULT,
      sidebarCollapsed: false,
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
      resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_DEFAULT }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: "angkordb.layout",
      version: 1,
      // If storage is blocked (private window, cleared site data) the layout just isn't remembered.
      storage: createJSONStorage(() => localStorage),
      partialize: ({ sidebarWidth, sidebarCollapsed }) => ({ sidebarWidth, sidebarCollapsed }),
      merge: (saved, current) => ({ ...current, ...readSaved(saved) }),
    },
  ),
);
