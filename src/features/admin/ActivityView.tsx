import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BanIcon, OctagonXIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { create } from "zustand";

import type { Backend } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  describeWait,
  formatSeconds,
  isBlocked,
  isInTransaction,
  lockTree,
  oneLine,
  orphanWaiters,
  visibleBackends,
  type LockNode,
} from "@/features/admin/activity";
import { StopDialog, type StopAction } from "@/features/admin/StopDialog";
import { SqlText } from "@/features/query/SqlText";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const REFRESH_MS = 2000;

type Mode = "processes" | "locks";

/** Kept while another tab is in front: the view itself is dropped then, and polling stops. */
const usePrefs = create<{
  mode: Mode;
  hideIdle: boolean;
  auto: boolean;
  text: string;
  set: (patch: Partial<{ mode: Mode; hideIdle: boolean; auto: boolean; text: string }>) => void;
}>()((set) => ({
  mode: "processes",
  hideIdle: true,
  auto: true,
  text: "",
  set: (patch) => set(patch),
}));

interface Stopping {
  backend: Backend;
  action: StopAction;
}

/** The process list and the locks of the open connection's server. */
export function ActivityView({ connectionId }: { connectionId: string }) {
  const { mode, hideIdle, auto, text, set } = usePrefs();
  const [selected, setSelected] = useState<number | null>(null);
  const [stopping, setStopping] = useState<Stopping | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const activity = useQuery({
    queryKey: ["activity", connectionId],
    queryFn: () => commands.listActivity(connectionId),
    refetchInterval: auto ? REFRESH_MS : false,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rows = activity.data ?? [];
  const shown = visibleBackends(rows, { hideIdle, text });
  const tree = lockTree(rows);
  const orphans = orphanWaiters(rows);
  const waiting = rows.filter(isBlocked).length;

  const stop = (backend: Backend, action: StopAction) => setStopping({ backend, action });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-xs">
        <div role="tablist" className="flex rounded-md border p-0.5">
          {(["processes", "locks"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => set({ mode: m })}
              className={cn(
                "rounded px-2.5 py-1 font-medium",
                mode === m ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
            >
              {m === "processes" ? "Processes" : "Locks"}
              {m === "locks" && waiting > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-amber-700 dark:text-amber-300">
                  {waiting}
                </span>
              )}
            </button>
          ))}
        </div>

        {mode === "processes" && (
          <label className="flex items-center gap-1.5 rounded-md border px-2 py-1 focus-within:ring-2 focus-within:ring-ring/50">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <input
              aria-label="Filter processes"
              value={text}
              onChange={(e) => set({ text: e.target.value })}
              placeholder="Filter"
              className="w-40 bg-transparent outline-none"
            />
          </label>
        )}
        {mode === "processes" && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={hideIdle}
              onChange={(e) => set({ hideIdle: e.target.checked })}
            />
            Hide idle
          </label>
        )}

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => set({ auto: e.target.checked })}
            />
            Refresh every 2 s
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            onClick={() => void activity.refetch()}
          >
            <RefreshCwIcon className={cn(activity.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {note && (
        <p role="status" className="border-b bg-muted/40 px-3 py-1.5 text-xs">
          {note}
        </p>
      )}
      {activity.isError && (
        <p role="alert" className="border-b px-3 py-1.5 text-xs font-medium text-destructive">
          {errorMessage(activity.error)}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "processes" ? (
          <ProcessTable
            rows={shown}
            loading={activity.isPending}
            selected={selected}
            onSelect={(pid) => setSelected((p) => (p === pid ? null : pid))}
            onStop={stop}
            hiddenIdle={hideIdle}
          />
        ) : (
          <Locks tree={tree} orphans={orphans} loading={activity.isPending} onStop={stop} />
        )}
      </div>

      {stopping && (
        <StopDialog
          connectionId={connectionId}
          backend={stopping.backend}
          action={stopping.action}
          onClose={() => setStopping(null)}
          onDone={({ gone }) => {
            setNote(
              gone
                ? `Process ${stopping.backend.pid} had already finished.`
                : stopping.action === "terminate"
                  ? `Closed the connection of process ${stopping.backend.pid}.`
                  : `Cancelled the query of process ${stopping.backend.pid}.`,
            );
            void activity.refetch();
          }}
        />
      )}
    </div>
  );
}

function StateBadge({ backend }: { backend: Backend }) {
  const state = backend.state ?? "—";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 whitespace-nowrap",
        backend.state === "active" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        isInTransaction(backend) && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        backend.state === "idle" && "text-muted-foreground",
      )}
    >
      {state}
    </span>
  );
}

function StopButtons({
  backend,
  onStop,
}: {
  backend: Backend;
  onStop: (backend: Backend, action: StopAction) => void;
}) {
  return (
    <span className="inline-flex gap-0.5">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Cancel the query of ${backend.pid}`}
        title="Cancel query"
        disabled={backend.state !== "active"}
        onClick={(e) => {
          e.stopPropagation();
          onStop(backend, "cancel");
        }}
      >
        <BanIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close connection ${backend.pid}`}
        title="Close connection"
        onClick={(e) => {
          e.stopPropagation();
          onStop(backend, "terminate");
        }}
      >
        <OctagonXIcon className="text-destructive" />
      </Button>
    </span>
  );
}

const HEADERS = [
  "PID",
  "User",
  "Database",
  "Application",
  "Client",
  "State",
  "Wait",
  "Duration",
  "Query",
  "",
];

function ProcessTable({
  rows,
  loading,
  selected,
  hiddenIdle,
  onSelect,
  onStop,
}: {
  rows: Backend[];
  loading: boolean;
  selected: number | null;
  hiddenIdle: boolean;
  onSelect: (pid: number) => void;
  onStop: (backend: Backend, action: StopAction) => void;
}) {
  if (loading) return <Empty>Reading the process list…</Empty>;
  if (rows.length === 0) {
    return (
      <Empty>
        {hiddenIdle
          ? "Nothing is running. Untick “Hide idle” to see the idle connections."
          : "No connections match."}
      </Empty>
    );
  }
  return (
    <table className="w-full border-separate border-spacing-0 text-xs">
      <thead className="sticky top-0 z-10 bg-background">
        <tr>
          {HEADERS.map((h, i) => (
            <th
              key={i}
              scope="col"
              className="border-b px-2 py-1.5 text-left font-medium text-muted-foreground"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <Fragment key={b.pid}>
            <tr
              aria-selected={selected === b.pid}
              onClick={() => onSelect(b.pid)}
              className={cn(
                "cursor-default align-top hover:bg-muted/40",
                selected === b.pid && "bg-muted/60",
              )}
            >
              <td className="px-2 py-1 font-mono">{b.pid}</td>
              <td className="px-2 py-1">{b.user ?? "—"}</td>
              <td className="px-2 py-1">{b.database ?? "—"}</td>
              <td className="max-w-32 truncate px-2 py-1" title={b.application}>
                {b.application || "—"}
              </td>
              <td className="px-2 py-1 font-mono">{b.client ?? "local"}</td>
              <td className="px-2 py-1">
                <StateBadge backend={b} />
              </td>
              <td
                className="max-w-48 truncate px-2 py-1 text-muted-foreground"
                title={describeWait(b)}
              >
                {isBlocked(b) ? (
                  <span className="text-amber-700 dark:text-amber-300">
                    blocked by {b.blockedBy.join(", ")}
                  </span>
                ) : (
                  describeWait(b)
                )}
              </td>
              <td className="px-2 py-1 whitespace-nowrap tabular-nums">
                {formatSeconds(b.stateSecs)}
              </td>
              <td className="max-w-0 min-w-48 truncate px-2 py-1 font-mono" title={b.query}>
                {oneLine(b.query)}
              </td>
              <td className="px-2 py-1 text-right">
                <StopButtons backend={b} onStop={onStop} />
              </td>
            </tr>
            {selected === b.pid && (
              <tr className="bg-muted/30">
                <td colSpan={HEADERS.length} className="px-3 py-2">
                  <dl className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
                    <div>Transaction open: {formatSeconds(b.transactionSecs)}</div>
                    {b.lockWait && <div>Waits for {b.lockWait}</div>}
                    {b.waitEventType && (
                      <div>
                        Wait event: {b.waitEventType}: {b.waitEvent}
                      </div>
                    )}
                  </dl>
                  <pre className="max-h-60 overflow-auto text-xs leading-relaxed whitespace-pre-wrap select-text">
                    {b.query ? <SqlText code={b.query} /> : "No query to show."}
                  </pre>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function Locks({
  tree,
  orphans,
  loading,
  onStop,
}: {
  tree: LockNode[];
  orphans: Backend[];
  loading: boolean;
  onStop: (backend: Backend, action: StopAction) => void;
}) {
  if (loading) return <Empty>Reading the locks…</Empty>;
  if (tree.length === 0 && orphans.length === 0)
    return <Empty>Nothing is waiting for a lock.</Empty>;
  return (
    <div className="flex flex-col gap-3 p-3">
      {tree.map((node) => (
        <section key={node.backend.pid} className="rounded-lg border">
          <header className="flex items-start gap-3 border-b bg-muted/30 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                <span className="font-mono">{node.backend.pid}</span> holds up {node.waiting}{" "}
                {node.waiting === 1 ? "connection" : "connections"}
              </p>
              <p className="text-muted-foreground">
                {node.backend.user ?? "—"} · {node.backend.application || "—"} ·{" "}
                {node.backend.state ?? "—"} · transaction open{" "}
                {formatSeconds(node.backend.transactionSecs)}
              </p>
              <p className="truncate font-mono text-muted-foreground" title={node.backend.query}>
                {oneLine(node.backend.query) || "no query to show"}
              </p>
            </div>
            <StopButtons backend={node.backend} onStop={onStop} />
          </header>
          <ul className="flex flex-col text-xs">
            {node.waiters.map((w) => (
              <Waiter key={w.backend.pid} node={w} depth={0} onStop={onStop} />
            ))}
          </ul>
        </section>
      ))}
      {orphans.length > 0 && (
        <section className="rounded-lg border">
          <header className="border-b bg-muted/30 px-3 py-2 text-xs font-medium">
            Waiting for something not in the list
          </header>
          <ul className="flex flex-col text-xs">
            {orphans.map((b) => (
              <Waiter
                key={b.pid}
                node={{ backend: b, waiters: [], waiting: 0 }}
                depth={0}
                onStop={onStop}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Waiter({
  node,
  depth,
  onStop,
}: {
  node: LockNode;
  depth: number;
  onStop: (backend: Backend, action: StopAction) => void;
}) {
  const b = node.backend;
  return (
    <li>
      <div
        className="flex items-start gap-3 border-b px-3 py-1.5 last:border-b-0"
        style={{ paddingLeft: 12 + depth * 20 }}
      >
        <span className="font-mono">{b.pid}</span>
        <div className="min-w-0 flex-1">
          <p>
            <span className="text-amber-700 dark:text-amber-300">
              {b.lockWait ? `waits for ${b.lockWait}` : "waits"}
            </span>{" "}
            <span className="text-muted-foreground">
              for {formatSeconds(b.stateSecs)} · {b.user ?? "—"} · blocked by{" "}
              {b.blockedBy.join(", ")}
            </span>
          </p>
          <p className="truncate font-mono text-muted-foreground" title={b.query}>
            {oneLine(b.query)}
          </p>
        </div>
        <StopButtons backend={b} onStop={onStop} />
      </div>
      {node.waiters.length > 0 && (
        <ul>
          {node.waiters.map((w) => (
            <Waiter key={w.backend.pid} node={w} depth={depth + 1} onStop={onStop} />
          ))}
        </ul>
      )}
    </li>
  );
}
