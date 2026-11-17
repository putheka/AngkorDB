import { create } from "zustand";

interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  sidebarWidth: 260,
  sidebarCollapsed: false,
  setSidebarWidth: (width) => set({ sidebarWidth: Math.min(Math.max(width, 180), 480) }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
