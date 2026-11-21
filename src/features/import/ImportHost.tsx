import { ImportDialog } from "@/features/import/ImportDialog";
import { useImportDialog } from "@/stores/importDialog";

/** Shows the import dialog when something asked for it (a table, the sidebar, ⌘K). */
export function ImportHost({ connectionId }: { connectionId: string }) {
  const seed = useImportDialog((s) => s.seed);
  const close = useImportDialog((s) => s.close);
  if (!seed) return null;
  return (
    <ImportDialog
      key={`${seed.schema}.${seed.table ?? ""}.${seed.path ?? ""}`}
      connectionId={connectionId}
      seed={seed}
      onClose={close}
    />
  );
}
