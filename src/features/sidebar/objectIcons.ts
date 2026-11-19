import {
  EyeIcon,
  HashIcon,
  LayersIcon,
  ListIcon,
  SquareFunctionIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";

import type { ObjectKind } from "@/bindings";

/** One icon per kind of database object, for the sidebar and the tabs. */
export const OBJECT_ICONS: Record<ObjectKind, LucideIcon> = {
  table: TableIcon,
  partitionedTable: TableIcon,
  foreignTable: TableIcon,
  view: EyeIcon,
  materializedView: LayersIcon,
  function: SquareFunctionIcon,
  procedure: SquareFunctionIcon,
  sequence: HashIcon,
  enumType: ListIcon,
};
