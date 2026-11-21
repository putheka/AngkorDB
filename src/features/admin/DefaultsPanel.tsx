import { useQuery } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

/** What new objects start out with, per role and schema (`ALTER DEFAULT PRIVILEGES`). */
export function DefaultsPanel({ connectionId }: { connectionId: string }) {
  const defaults = useQuery({
    queryKey: ["privileges", connectionId, "defaults"],
    queryFn: () => commands.defaultPrivileges(connectionId),
    retry: false,
  });

  if (defaults.isError) {
    return (
      <p role="alert" className="px-4 py-6 text-sm font-medium text-destructive">
        {errorMessage(defaults.error)}
      </p>
    );
  }
  if (!defaults.data) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">Reading…</p>;
  }
  return (
    <div className="h-full overflow-auto">
      <p className="px-3 py-2 text-xs text-muted-foreground">
        What a table, sequence, function or type starts out with when the role creates it. To change
        these, run <span className="font-mono">ALTER DEFAULT PRIVILEGES</span> in a query tab.
      </p>
      {defaults.data.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No default privileges are set in this database.
        </p>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 bg-background">
            <tr>
              {["Created by", "In schema", "Kind", "Granted to", "Privileges"].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="border-b px-3 py-1.5 text-left font-medium text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {defaults.data.map((d) => (
              <tr
                key={`${d.role}|${d.schema ?? ""}|${d.objectType}|${d.grantee ?? ""}`}
                className="hover:bg-muted/40"
              >
                <td className="px-3 py-1 font-mono">{d.role}</td>
                <td className="px-3 py-1">{d.schema ?? "every schema"}</td>
                <td className="px-3 py-1">{d.objectType}</td>
                <td className="px-3 py-1 font-mono">{d.grantee ?? "PUBLIC"}</td>
                <td className="px-3 py-1">{d.privileges.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
