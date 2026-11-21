/** Ask the person for a file with the system's file dialog. `null` when they cancel. */
export async function pickFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ title, multiple: false, directory: false });
  return typeof chosen === "string" ? chosen : null;
}
