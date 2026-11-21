import { CheckIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { HistoryEntry } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SqlText } from "@/features/query/SqlText";
import { formatAgo, oneLine } from "@/features/query/history/historyText";
import {
  useClearHistory,
  useDeleteHistoryEntry,
  useHistory,
} from "@/features/query/history/useHistory";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  connectionId: string;
  connectionName: string;
  /** Put a statement into the editor. */
  onInsert: (sql: string) => void;
  onClose: () => void;
}

/** Every statement that was run, newest first: search it, click one to put it in the editor. */
export function HistoryPanel({ connectionId, connectionName, onInsert, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const history = useHistory(search, everywhere ? null : connectionId);
  const remove = useDeleteHistoryEntry();
  const clear = useClearHistory();
  const entries = history.data ?? [];

  // "5 min ago" moves on while the panel stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // "Clear" asks again; the question goes away if nothing is done about it.
  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  return (
    <section
      aria-label="Query history"
      className="flex h-full min-h-0 w-72 shrink-0 flex-col border-r bg-sidebar/40"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <h2 className="flex-1 text-sm font-medium">History</h2>
        {confirmClear ? (
          <Button
            size="xs"
            variant="destructive"
            onClick={() => {
              clear.mutate(everywhere ? null : connectionId);
              setConfirmClear(false);
            }}
          >
            <CheckIcon /> Clear {everywhere ? "all" : "this connection"}?
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Clear history"
            disabled={entries.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2Icon />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Close history" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 border-b p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search history"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <div className="flex gap-1 text-xs" role="group" aria-label="Connections">
          {[
            { all: false, label: connectionName },
            { all: true, label: "All connections" },
          ].map((choice) => (
            <button
              key={String(choice.all)}
              type="button"
              aria-pressed={everywhere === choice.all}
              onClick={() => setEverywhere(choice.all)}
              className={cn(
                "min-w-0 truncate rounded-md border px-2 py-0.5",
                everywhere === choice.all
                  ? "border-ring bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Statements">
        {entries.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            now={now}
            onInsert={onInsert}
            onDelete={() => remove.mutate(entry.id)}
          />
        ))}
        {entries.length === 0 && !history.isPending && (
          <li className="p-4 text-center text-xs text-muted-foreground">
            {search.trim() ? "Nothing matches." : "Statements you run show up here."}
          </li>
        )}
      </ul>
    </section>
  );
}

function HistoryRow({
  entry,
  now,
  onInsert,
  onDelete,
}: {
  entry: HistoryEntry;
  now: number;
  onInsert: (sql: string) => void;
  onDelete: () => void;
}) {
  return (
    <li className="group relative border-b border-border/50">
      <button
        type="button"
        title={entry.sql}
        onClick={() => onInsert(entry.sql)}
        className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
      >
        <span className="line-clamp-2 block text-xs break-all">
          <SqlText code={oneLine(entry.sql, 200)} />
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
          <span
            aria-label={entry.ok ? "Succeeded" : "Failed"}
            className={cn("size-1.5 rounded-full", entry.ok ? "bg-emerald-500" : "bg-destructive")}
          />
          {formatAgo(entry.ranAt, now)} · {formatDuration(entry.durationMs)}
        </span>
      </button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Remove from history"
        onClick={onDelete}
        className="absolute top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <XIcon />
      </Button>
    </li>
  );
}
