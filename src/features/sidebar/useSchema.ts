import { useMutation, useQuery } from "@tanstack/react-query";

import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { dataKey } from "@/features/grid/useTableData";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { useBrowserStore } from "@/stores/browser";
import { useStatusStore } from "@/stores/status";
import { useTabsStore } from "@/stores/tabs";

/** Prefix of every cached schema query of one connection. */
export const schemaKey = (connectionId: string) => ["schema", connectionId] as const;

export function useDatabases(connectionId: string) {
  return useQuery({
    queryKey: [...schemaKey(connectionId), "databases"],
    queryFn: () => commands.listDatabases(connectionId),
  });
}

export function useSchemas(connectionId: string) {
  return useQuery({
    queryKey: [...schemaKey(connectionId), "schemas"],
    queryFn: () => commands.listSchemas(connectionId, false),
  });
}

export function useObjects(connectionId: string, schema: string | null) {
  return useQuery({
    queryKey: [...schemaKey(connectionId), "objects", schema],
    queryFn: () => commands.listObjects(connectionId, schema ?? "public"),
    enabled: schema !== null,
  });
}

/** The schema being browsed: the user's pick if it still exists, else the first (`public`). */
export function useCurrentSchema(connectionId: string) {
  const schemas = useSchemas(connectionId);
  const picked = useBrowserStore((s) => s.schema);
  const setSchema = useBrowserStore((s) => s.setSchema);
  const list = schemas.data ?? [];
  const schema = list.find((s) => s.name === picked)?.name ?? list[0]?.name ?? null;
  return { schema, schemas: list, setSchema, query: schemas };
}

/** Re-read databases, schemas and objects (the refresh button and ⌘R). */
export function refreshSchema(connectionId: string) {
  return queryClient.invalidateQueries({ queryKey: schemaKey(connectionId) });
}

/** The session behind the connection now points at another database: nothing cached is valid. */
export function useSwitchDatabase(connectionId: string) {
  return useMutation({
    mutationFn: async (database: string) => {
      // The tabs close with the old database, and their staged edits with them: ask first.
      if (!(await guardUnsaved(connectionId, "switch database"))) return false;
      await commands.switchDatabase(connectionId, database);
      return true;
    },
    onSuccess: async (switched) => {
      if (!switched) return;
      useTabsStore.getState().closeAll();
      useStatusStore.getState().clear();
      useBrowserStore.getState().setSchema(null);
      await queryClient.resetQueries({ queryKey: schemaKey(connectionId) });
      queryClient.removeQueries({ queryKey: dataKey(connectionId) });
    },
  });
}
