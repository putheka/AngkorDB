/**
 * The states of an update (ANG-59) and how a download moves between them. Pure: the plugin
 * and the screen are elsewhere. No alias imports (unit-tested in Node).
 */

export type UpdateStatus =
  | { kind: "idle" }
  /** `manual`: the person asked, so "you are up to date" is an answer worth showing. */
  | { kind: "checking"; manual: boolean }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  /** Installed; the app has to restart to run it. */
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

/** What the updater plugin reports while it downloads. */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** The download state after one event; anything else leaves the state alone. */
export function afterDownloadEvent(state: UpdateStatus, event: DownloadEvent): UpdateStatus {
  if (state.kind !== "downloading") return state;
  switch (event.event) {
    case "Started":
      return { ...state, downloaded: 0, total: event.data.contentLength ?? null };
    case "Progress":
      return { ...state, downloaded: state.downloaded + event.data.chunkLength };
    case "Finished":
      return state.total === null ? state : { ...state, downloaded: state.total };
  }
}

/** 0–100, or `null` when the size isn't known (then the bar just moves). */
export function percent(downloaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

/** Megabytes with a decimal, for "3.2 of 9.8 MB". */
export const megabytes = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

/** Whether the app should look for an update by itself now: wanted, and in the installed app. */
export function shouldCheckAtLaunch(wanted: boolean, native: boolean): boolean {
  return wanted && native;
}

/** The plugin's errors come as text or `Error`; the screen shows a sentence. */
export function updateErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!text) return "The update could not be checked.";
  // Not in the installed app: there is nothing to update (the browser mock, a dev run).
  if (/not allowed|invoke|__TAURI|undefined/i.test(text)) {
    return "Updates are only available in the installed app.";
  }
  return text;
}
