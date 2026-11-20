import type { DbObject } from "@/bindings";
import { isOpenable } from "@/features/sidebar/treeRows";
import { useQueryViews } from "@/features/query/queryViews";
import { qualifiedName } from "@/lib/sql";
import { useBrowserStore } from "@/stores/browser";
import { useTabsStore } from "@/stores/tabs";

/** A query that does something useful with an object that has no rows to browse. */
export function queryFor(object: DbObject): string {
  const name = qualifiedName(object.schema, object.name);
  switch (object.kind) {
    case "function":
      return `SELECT ${name}();`;
    case "procedure":
      return `CALL ${name}();`;
    case "sequence":
      return `SELECT last_value, is_called FROM ${name};`;
    case "enumType":
      return `SELECT unnest(enum_range(NULL::${name})) AS value;`;
    default:
      return `SELECT * FROM ${name} LIMIT 100;`;
  }
}

/** A new query tab with `text` already in the editor. */
export function openQueryWith(text: string) {
  useTabsStore.getState().newQuery();
  const id = useTabsStore.getState().activeId;
  if (id)
    useQueryViews
      .getState()
      .update(id, { text, selection: { anchor: text.length, head: text.length } });
}

/**
 * What choosing an object in the palette does: a table, view or materialized view opens as a
 * tab that stays; functions, sequences and types open a query about them. The sidebar follows
 * to the object's schema.
 */
export function openObject(object: DbObject) {
  useBrowserStore.getState().setSchema(object.schema);
  if (isOpenable(object.kind)) {
    useTabsStore
      .getState()
      .openTable({ schema: object.schema, name: object.name, kind: object.kind }, true);
  } else {
    openQueryWith(queryFor(object));
  }
}
