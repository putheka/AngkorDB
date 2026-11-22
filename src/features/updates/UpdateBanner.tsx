import { DownloadIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { megabytes, percent } from "@/features/updates/updateState";
import { useUpdates } from "@/stores/updates";

/**
 * Bottom-right notice of the updater: an update is there (Install and restart), it is being
 * downloaded, it failed, or (when asked) there is nothing new. Silent otherwise.
 */
export function UpdateBanner() {
  const status = useUpdates((s) => s.status);
  const install = useUpdates((s) => s.install);
  const dismiss = useUpdates((s) => s.dismiss);
  if (status.kind === "idle") return null;

  let body;
  switch (status.kind) {
    case "checking":
      // Only a check the person asked for shows anything while it runs.
      if (!status.manual) return null;
      body = <p>Checking for updates…</p>;
      break;
    case "upToDate":
      body = <p>AngkorDB is up to date.</p>;
      break;
    case "available":
      body = (
        <>
          <p className="font-medium">AngkorDB {status.version} is available</p>
          {status.notes && (
            <p className="line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">
              {status.notes}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <Button size="xs" onClick={() => void install()}>
              <DownloadIcon /> Install and restart
            </Button>
            <Button size="xs" variant="ghost" onClick={dismiss}>
              Later
            </Button>
          </div>
        </>
      );
      break;
    case "downloading": {
      const pct = percent(status.downloaded, status.total);
      body = (
        <>
          <p>Downloading {status.version}…</p>
          <div
            role="progressbar"
            aria-valuenow={pct ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 overflow-hidden rounded bg-muted"
          >
            <div
              className={
                pct === null ? "h-full w-1/3 animate-pulse bg-primary" : "h-full bg-primary"
              }
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {status.total
              ? `${megabytes(status.downloaded)} of ${megabytes(status.total)} MB`
              : `${megabytes(status.downloaded)} MB`}
          </p>
        </>
      );
      break;
    }
    case "ready":
      body = <p>Installed {status.version}. Restarting…</p>;
      break;
    case "error":
      body = (
        <>
          <p className="font-medium text-destructive">The update did not work</p>
          <p className="text-xs text-muted-foreground">{status.message}</p>
        </>
      );
      break;
  }

  return (
    <div
      role="status"
      className="fixed right-4 bottom-10 z-50 flex w-72 flex-col gap-1.5 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      {status.kind !== "downloading" && status.kind !== "ready" && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
      {body}
    </div>
  );
}
