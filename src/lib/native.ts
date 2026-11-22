/** The real app has window metadata; the browser mock of `npm run dev` only fakes `invoke`. */
export const inNativeApp = (): boolean => {
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: unknown } })
    .__TAURI_INTERNALS__;
  return Boolean(internals?.metadata);
};
