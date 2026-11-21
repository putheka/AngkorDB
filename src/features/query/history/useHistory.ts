import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SavedQueryInput } from "@/bindings";
import { commands } from "@/lib/ipc";

export const HISTORY_PAGE = 200;

export const historyKey = ["history"] as const;
export const savedKey = ["saved-queries"] as const;

/** The newest statements that match `search`; for one connection, or all of them. */
export function useHistory(search: string, connectionId: string | null) {
  return useQuery({
    queryKey: [...historyKey, connectionId, search.trim()],
    queryFn: () => commands.listHistory(search, connectionId, HISTORY_PAGE, 0),
    placeholderData: (previous) => previous,
  });
}

export function useDeleteHistoryEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => commands.deleteHistoryEntry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: historyKey }),
  });
}

export function useClearHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string | null) => commands.clearHistory(connectionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: historyKey }),
  });
}

/** Saved queries that can be used on this connection (its own, and those for every one). */
export function useSavedQueries(connectionId: string | null) {
  return useQuery({
    queryKey: [...savedKey, connectionId],
    queryFn: () => commands.listSavedQueries(connectionId),
  });
}

export function useSaveQuery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavedQueryInput) => commands.saveQuery(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey }),
  });
}

export function useDeleteSavedQuery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => commands.deleteSavedQuery(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: savedKey }),
  });
}
