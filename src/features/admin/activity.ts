/** What the process list shows: which rows, in what order, and who blocks whom. */
import type { Backend } from "@/bindings";
import { formatDuration } from "../../lib/format.ts";

export interface ActivityFilter {
  /** Hide connections that are doing nothing (`idle`). One waiting inside a transaction stays. */
  hideIdle: boolean;
  text: string;
}

export const isIdle = (b: Backend) => b.state === "idle";
export const isInTransaction = (b: Backend) => (b.state ?? "").startsWith("idle in transaction");
export const isBlocked = (b: Backend) => b.blockedBy.length > 0;

const rank = (b: Backend) => (b.state === "active" ? 0 : isInTransaction(b) ? 1 : 2);

/** The rows to draw: this app's own list connection left out, the longest waiters first. */
export function visibleBackends(rows: readonly Backend[], filter: ActivityFilter): Backend[] {
  const needle = filter.text.trim().toLowerCase();
  return rows
    .filter((b) => !b.isSelf)
    .filter((b) => !(filter.hideIdle && isIdle(b)))
    .filter(
      (b) =>
        needle === "" ||
        [String(b.pid), b.user, b.application, b.database, b.client, b.state, b.query].some((v) =>
          v?.toLowerCase().includes(needle),
        ),
    )
    .sort((a, b) => rank(a) - rank(b) || (b.stateSecs ?? 0) - (a.stateSecs ?? 0) || a.pid - b.pid);
}

/** `850 ms`, `12 s`, `3 min 5 s`; `—` when the server did not say. */
export function formatSeconds(secs: number | null): string {
  return secs === null ? "—" : formatDuration(Math.max(0, secs) * 1000);
}

/** `Lock: ShareLock on public.orders`, `IO: DataFileRead`, or nothing. */
export function describeWait(b: Backend): string {
  if (b.lockWait) return `waits for ${b.lockWait}`;
  if (b.waitEventType && b.waitEvent) return `${b.waitEventType}: ${b.waitEvent}`;
  return "";
}

/** A connection that holds others up, and the ones queued behind it (which may hold up more). */
export interface LockNode {
  backend: Backend;
  /** Shown under this one: each waiting connection appears once, under the one it queues behind. */
  waiters: LockNode[];
  /** Every connection held up by it, directly or through others. */
  waiting: number;
}

/**
 * Who blocks whom. The roots are the connections that block someone and wait for nobody: ending
 * those frees the rest. A connection that waits for several is drawn once, under the one it
 * queues directly behind (the latest to start waiting); `waiting` counts it for all of them.
 */
export function lockTree(rows: readonly Backend[]): LockNode[] {
  const byPid = new Map(rows.map((b) => [b.pid, b]));
  const visible = (b: Backend) => b.blockedBy.filter((p) => byPid.has(p));
  const waitersOf = new Map<number, Backend[]>();
  const children = new Map<number, Backend[]>();
  for (const b of rows) {
    const blockers = visible(b);
    for (const blocker of blockers) {
      waitersOf.set(blocker, [...(waitersOf.get(blocker) ?? []), b]);
    }
    // Under a blocker that is itself waiting (it is in front of us in the queue), if there is one.
    const queued = blockers
      .map((p) => byPid.get(p))
      .filter((p): p is Backend => !!p && visible(p).length > 0)
      .sort((x, y) => (x.stateSecs ?? 0) - (y.stateSecs ?? 0) || x.pid - y.pid);
    const parent = queued[0]?.pid ?? blockers[0];
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), b]);
  }

  const held = (pid: number): number => {
    const seen = new Set<number>([pid]);
    const walk = (p: number) => {
      for (const w of waitersOf.get(p) ?? []) {
        if (seen.has(w.pid)) continue;
        seen.add(w.pid);
        walk(w.pid);
      }
    };
    walk(pid);
    return seen.size - 1;
  };
  const build = (b: Backend, path: ReadonlySet<number>): LockNode => ({
    backend: b,
    waiting: held(b.pid),
    waiters: (children.get(b.pid) ?? [])
      .filter((w) => !path.has(w.pid)) // a deadlock is a loop: don't follow it round
      .sort((x, y) => (y.stateSecs ?? 0) - (x.stateSecs ?? 0) || x.pid - y.pid)
      .map((w) => build(w, new Set([...path, b.pid]))),
  });
  return rows
    .filter((b) => waitersOf.has(b.pid) && visible(b).length === 0)
    .sort((a, b) => (b.transactionSecs ?? 0) - (a.transactionSecs ?? 0) || a.pid - b.pid)
    .map((b) => build(b, new Set()));
}

/** Connections that wait for something that is not in the list (a blocker the list can't show). */
export function orphanWaiters(rows: readonly Backend[]): Backend[] {
  const pids = new Set(rows.map((b) => b.pid));
  return rows.filter((b) => b.blockedBy.length > 0 && b.blockedBy.every((p) => !pids.has(p)));
}

/** The query on one line, cut to `max` characters, for a table cell. */
export function oneLine(query: string, max = 160): string {
  const flat = query.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
