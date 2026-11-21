/** Ask the person for a file with the system's file dialog. `null` when they cancel. */
export async function pickFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ title, multiple: false, directory: false });
  return typeof chosen === "string" ? chosen : null;
}

/** Ask where to save a file, with the system's dialog. `null` when they cancel. */
export async function pickSavePath(
  title: string,
  defaultName: string,
  extension: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    title,
    defaultPath: defaultName,
    filters: [{ name: extension, extensions: [extension] }],
  });
}

/** Ask for a folder. `null` when they cancel. */
export async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ title, multiple: false, directory: true });
  return typeof chosen === "string" ? chosen : null;
}

/** Ask for a data file to import, with the system's dialog. `null` when they cancel. */
export async function pickDataFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: "Data files", extensions: ["csv", "tsv", "txt", "json", "ndjson", "jsonl"] }],
  });
  return typeof chosen === "string" ? chosen : null;
}
