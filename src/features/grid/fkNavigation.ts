import { withValueFilter, EMPTY_FILTER } from "@/features/grid/filters";
import { useTableViews } from "@/features/grid/tableViews";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { tableTabId, useTabsStore } from "@/stores/tabs";

/** `column = value`, for the table being opened. */
export interface Condition {
  column: string;
  value: string;
}

/**
 * Open a table in its own tab, filtered to `conditions` (all of them must match). If the table is
 * already open its tab comes to the front and its filter is replaced; the filter bar shows the
 * conditions so they can be changed or removed.
 */
export async function openTableWhere(
  connectionId: string,
  schema: string,
  name: string,
  conditions: Condition[],
): Promise<void> {
  // The kind (table, partitioned table, …) is in the catalog; the same query the tab itself runs.
  const described = await queryClient.fetchQuery({
    queryKey: ["schema", connectionId, "describe", schema, name],
    queryFn: () => commands.describeTable(connectionId, schema, name),
    staleTime: 30_000,
  });
  const filter = conditions.reduce(
    (state, { column, value }) => withValueFilter(state, column, value),
    EMPTY_FILTER,
  );
  useTableViews.getState().update(tableTabId(schema, name), { filter, page: 0 });
  useTabsStore.getState().openTable({ schema, name, kind: described.kind }, true);
}
