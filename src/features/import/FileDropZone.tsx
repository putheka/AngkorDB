import { useEffect, useRef, useState } from "react";

import {
  chooseDropped,
  dropPrompt,
  dropTarget,
  isImportable,
  refusal,
} from "@/features/import/fileDrop";
import { cn } from "@/lib/utils";
import { useBrowserStore } from "@/stores/browser";
import { useImportDialog } from "@/stores/importDialog";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";

const NOTICE_MS = 5000;

function currentTarget() {
  const { tabs, activeId } = useTabsStore.getState();
  const front = tabs.find((t) => t.id === activeId) ?? null;
  return dropTarget(front, useBrowserStore.getState().schema);
}

/**
 * Dropping a data file on the window opens the import dialog with the file chosen: into the table
 * in front, or as a new table. While files are over the window it says what a drop will do.
 */
export function FileDropZone() {
  const [hover, setHover] = useState<{ text: string; ok: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const say = (text: string) => {
      setNotice(text);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
    };
    const busy = () => useImportDialog.getState().seed !== null;
    const connected = () => useSessionStore.getState().activeConnectionId !== null;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const drop = event.payload;
          if (drop.type === "leave") {
            setHover(null);
          } else if (drop.type === "enter") {
            if (busy() || !connected()) return;
            setHover(
              drop.paths.some(isImportable)
                ? { text: dropPrompt(currentTarget()), ok: true }
                : { text: refusal(drop.paths), ok: false },
            );
          } else if (drop.type === "drop") {
            setHover(null);
            if (busy()) return;
            const { path, left } = chooseDropped(drop.paths);
            if (!connected()) {
              if (path) say("Open a connection first, then drop the file again.");
            } else if (!path) {
              say(refusal(drop.paths));
            } else {
              if (left > 0) say(`Importing the first file. ${left} other file(s) were left out.`);
              useImportDialog.getState().open({ ...currentTarget(), path });
            }
          }
        }),
      )
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => undefined); // no native window behind the page (browser dev mode)

    return () => {
      cancelled = true;
      unlisten?.();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return (
    <>
      {hover && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed bg-background/80 text-sm font-medium",
            hover.ok ? "border-primary text-foreground" : "border-destructive text-destructive",
          )}
        >
          {hover.text}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
        >
          {notice}
        </div>
      )}
    </>
  );
}
