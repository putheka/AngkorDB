/** What a window shows when it opens. */
export type WindowStart =
  /** The connection used last, if the person wants that (the first window at launch). */
  | { kind: "restore" }
  /** The welcome screen. */
  | { kind: "welcome" }
  /** The form for a new connection. */
  | { kind: "new" }
  /** Open this connection. */
  | { kind: "open"; id: string };

/**
 * What the window `label` with this address hash starts with. The app opens further windows at
 * `#open=<connection id>` and `#new`; a window made by the app's configuration has no hash.
 */
export function windowStart(label: string, hash: string): WindowStart {
  if (hash === "#new") return { kind: "new" };
  if (hash.startsWith("#open=")) {
    const id = decodeId(hash.slice("#open=".length));
    if (id) return { kind: "open", id };
  }
  return label === "main" ? { kind: "restore" } : { kind: "welcome" };
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}
