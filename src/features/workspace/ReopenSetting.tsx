import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/ipc";

const key = ["startup-state"] as const;

/** Whether the app opens the last connection, with its tabs, at launch. */
export function ReopenSetting() {
  const queryClient = useQueryClient();
  const startup = useQuery({ queryKey: key, queryFn: () => commands.startupState() });
  const change = useMutation({
    mutationFn: (restore: boolean) => commands.setRestoreOnLaunch(restore),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={startup.data?.restoreOnLaunch ?? true}
        disabled={!startup.data || change.isPending}
        onChange={(e) => change.mutate(e.target.checked)}
      />
      Open the last connection and its tabs when AngkorDB starts
    </label>
  );
}
