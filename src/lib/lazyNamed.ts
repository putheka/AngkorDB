import { lazy, type ComponentType } from "react";

/** `React.lazy` for a component that is a named export: `lazyNamed(() => import("./X"), "X")`. */
export function lazyNamed<K extends string, P extends object>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  return lazy(() => load().then((module) => ({ default: module[name] })));
}
