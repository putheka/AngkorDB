import { create } from "zustand";

/** What the user picked in the sidebar for the open connection. */
interface BrowserState {
  /** Chosen schema. `null` (or a schema that no longer exists) means the first one, `public`. */
  schema: string | null;
  setSchema: (schema: string | null) => void;
}

export const useBrowserStore = create<BrowserState>()((set) => ({
  schema: null,
  setSchema: (schema) => set({ schema }),
}));
