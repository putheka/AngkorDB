import { useQueries, type QueryObserverResult } from "@tanstack/react-query";

import type { DbObject } from "@/bindings";
import { schemaKey, useSchemas } from "@/features/sidebar/useSchema";
import { commands } from "@/lib/ipc";

// A fixed function, so TanStack Query can reuse its result while nothing changed.
function combine(results: QueryObserverResult<DbObject[]>[]) {
  return {
    objects: results.flatMap((r) => r.data ?? []),
    pending: results.some((r) => r.isPending),
  };
}

/**
 * Every object of every (non-system) schema. Uses the same cache entries as the sidebar, so the
 * schema being browsed is already there and the others are read once, then kept for a while.
 */
export function useAllObjects(connectionId: string) {
  const schemas = useSchemas(connectionId);
  return useQueries({
    queries: (schemas.data ?? []).map((schema) => ({
      queryKey: [...schemaKey(connectionId), "objects", schema.name],
      queryFn: () => commands.listObjects(connectionId, schema.name),
      staleTime: 30_000,
    })),
    combine,
  });
}
