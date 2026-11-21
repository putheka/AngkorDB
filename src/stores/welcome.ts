import { create } from "zustand";

interface WelcomeState {
  /** Something (File ▸ New Connection) asked the welcome screen for a new connection. */
  newConnection: boolean;
  requestNewConnection: () => void;
  done: () => void;
}

export const useWelcome = create<WelcomeState>()((set) => ({
  newConnection: false,
  requestNewConnection: () => set({ newConnection: true }),
  done: () => set({ newConnection: false }),
}));
