import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ConnectionConfig, PasswordChange } from "@/bindings";
import { commands } from "@/lib/ipc";

const connectionsKey = ["connections"] as const;

export function useConnections() {
  return useQuery({ queryKey: connectionsKey, queryFn: () => commands.listConnections() });
}

function useRefreshConnections() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: connectionsKey });
}

export function useSaveConnection() {
  const refresh = useRefreshConnections();
  return useMutation({
    mutationFn: (input: { config: ConnectionConfig; password: PasswordChange }) =>
      commands.saveConnection(input.config, input.password),
    onSuccess: refresh,
  });
}

export function useDeleteConnection() {
  const refresh = useRefreshConnections();
  return useMutation({
    mutationFn: (id: string) => commands.deleteConnection(id),
    onSuccess: refresh,
  });
}

export function useDuplicateConnection() {
  const refresh = useRefreshConnections();
  return useMutation({
    mutationFn: (id: string) => commands.duplicateConnection(id),
    onSuccess: refresh,
  });
}
