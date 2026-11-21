import { create } from "zustand";

interface QuitConfirmState {
  open: boolean;
  ask: () => Promise<boolean>;
  answer: (quit: boolean) => void;
}

let waiting: ((quit: boolean) => void) | null = null;

export const useQuitConfirm = create<QuitConfirmState>()((set) => ({
  open: false,
  ask: () =>
    new Promise((resolve) => {
      waiting?.(false);
      waiting = resolve;
      set({ open: true });
    }),
  answer: (quit) => {
    const done = waiting;
    waiting = null;
    set({ open: false });
    done?.(quit);
  },
}));
