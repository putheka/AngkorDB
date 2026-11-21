/** A small, living process list for the in-browser mock: durations tick, stopping works. */
import type { Backend } from "@/bindings";
import { appError } from "@/dev/mockSupport";

interface MockBackend extends Omit<Backend, "stateSecs" | "transactionSecs"> {
  /** `Date.now()` when it entered its state / opened its transaction. */
  since: number;
  transactionSince: number | null;
}

const ago = (secs: number) => Date.now() - secs * 1000;

function initial(): MockBackend[] {
  const base = {
    database: "shop",
    user: "app",
    application: "psql",
    client: "10.0.0.5",
    waitEventType: null,
    waitEvent: null,
    blockedBy: [] as number[],
    lockWait: null,
    isSelf: false,
  };
  return [
    {
      ...base,
      pid: 3902,
      state: "idle in transaction",
      query: "UPDATE public.orders SET status = 'shipped' WHERE id = 42;",
      since: ago(612),
      transactionSince: ago(640),
      waitEventType: "Client",
      waitEvent: "ClientRead",
    },
    {
      ...base,
      pid: 4411,
      application: "DBeaver 24.1",
      client: "10.0.0.17",
      state: "active",
      query: "select pg_sleep(600)",
      since: ago(37),
      transactionSince: ago(37),
      waitEventType: "Timeout",
      waitEvent: "PgSleep",
    },
    {
      ...base,
      pid: 4520,
      user: "worker",
      application: "billing-worker",
      client: "10.0.1.8",
      state: "active",
      query: "UPDATE public.orders SET total = total * 1.2 WHERE customer_id = 7",
      since: ago(31),
      transactionSince: ago(31),
      waitEventType: "Lock",
      waitEvent: "transactionid",
      blockedBy: [3902],
      lockWait: "ShareLock on transactionid",
    },
    {
      ...base,
      pid: 4533,
      user: "worker",
      application: "billing-worker",
      client: "10.0.1.9",
      state: "active",
      query: "SELECT * FROM public.orders WHERE id = 42 FOR UPDATE",
      since: ago(12),
      transactionSince: ago(12),
      waitEventType: "Lock",
      waitEvent: "transactionid",
      blockedBy: [3902, 4520],
      lockWait: "ShareLock on transactionid",
    },
    {
      ...base,
      pid: 4601,
      user: "reporting",
      application: "metabase",
      client: "10.0.2.3",
      state: "idle",
      query: "SELECT count(*) FROM public.users",
      since: ago(95),
      transactionSince: null,
      waitEventType: "Client",
      waitEvent: "ClientRead",
    },
    {
      ...base,
      pid: 4602,
      user: "reporting",
      application: "metabase",
      client: "10.0.2.3",
      state: "idle",
      query: "SELECT 1",
      since: ago(400),
      transactionSince: null,
      waitEventType: "Client",
      waitEvent: "ClientRead",
    },
    {
      ...base,
      pid: 5100,
      user: "angkor",
      database: "angkordb_dev",
      application: "AngkorDB",
      client: "127.0.0.1",
      state: "idle",
      query: "SELECT n.nspname FROM pg_namespace n",
      since: ago(3),
      transactionSince: null,
    },
    {
      ...base,
      pid: 5101,
      user: "angkor",
      database: "angkordb_dev",
      application: "AngkorDB",
      client: "127.0.0.1",
      state: "active",
      query: "SELECT pid, … FROM pg_stat_activity a",
      since: Date.now(),
      transactionSince: Date.now(),
      isSelf: true,
    },
  ];
}

let backends = initial();

export function mockListActivity(): Backend[] {
  const now = Date.now();
  return backends.map(({ since, transactionSince, ...rest }) => ({
    ...rest,
    stateSecs: (now - since) / 1000,
    transactionSecs: transactionSince === null ? null : (now - transactionSince) / 1000,
    blockedBy: [...rest.blockedBy],
  }));
}

/** What happens to the ones that waited for `pid` once it is gone: they go through, and finish. */
function release(pid: number) {
  backends = backends.map((b) => {
    if (!b.blockedBy.includes(pid)) return b;
    const blockedBy = b.blockedBy.filter((p) => p !== pid);
    if (blockedBy.length > 0) return { ...b, blockedBy };
    return {
      ...b,
      blockedBy,
      lockWait: null,
      waitEventType: "Client",
      waitEvent: "ClientRead",
      state: "idle",
      since: Date.now(),
      transactionSince: null,
    };
  });
}

function find(pid: number): MockBackend | undefined {
  return backends.find((b) => b.pid === pid);
}

export function mockCancelBackend(pid: number): boolean {
  const target = find(pid);
  if (!target) return false;
  if (target.isSelf) {
    throw appError("VALIDATION", "That is the connection this list is read with.");
  }
  if (target.state === "active") {
    // The query stops; the connection stays, idle.
    backends = backends.map((b) =>
      b.pid === pid
        ? {
            ...b,
            state: "idle",
            since: Date.now(),
            transactionSince: null,
            blockedBy: [],
            lockWait: null,
            waitEventType: "Client",
            waitEvent: "ClientRead",
          }
        : b,
    );
    release(pid);
  }
  return true;
}

export function mockTerminateBackend(pid: number): boolean {
  const target = find(pid);
  if (!target) return false;
  if (target.isSelf) {
    throw appError("VALIDATION", "That is the connection this list is read with.");
  }
  backends = backends.filter((b) => b.pid !== pid);
  release(pid);
  return true;
}

export function resetMockActivity() {
  backends = initial();
}
