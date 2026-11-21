import { ActivityIcon, PlusIcon, ShieldIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsDirty } from "@/features/grid/editing/unsaved";
import { OBJECT_ICONS } from "@/features/sidebar/objectIcons";
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsToTheRight,
} from "@/features/tabs/closeTabs";
import { qualifiedName } from "@/lib/sql";
import { cn } from "@/lib/utils";
import { tabTitle, useTabsStore, type Tab } from "@/stores/tabs";

/** Pointer travel before a press on a tab turns into a drag. */
const DRAG_THRESHOLD = 5;

/** The open tables and queries. Press to switch, drag to reorder, double-click to keep. */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; moving: boolean } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Keep the front tab visible when there are more tabs than fit.
  useEffect(() => {
    barRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, tab: Tab) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    useTabsStore.getState().activate(tab.id); // on press, like native tabs
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: tab.id, startX: e.clientX, moving: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moving && Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD) return;
    if (!d.moving) {
      d.moving = true;
      setDraggingId(d.id);
    }

    // Swap with the tab under the pointer once the pointer is past that tab's middle, so
    // tabs of different widths don't jump back and forth.
    const { tabs: current, move } = useTabsStore.getState();
    const over = [...(barRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])].find(
      (el) => {
        const r = el.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX < r.right;
      },
    );
    const overId = over?.dataset["tabId"];
    if (!over || !overId || overId === d.id) return;
    const from = current.findIndex((t) => t.id === d.id);
    const to = current.findIndex((t) => t.id === overId);
    const rect = over.getBoundingClientRect();
    const middle = rect.left + rect.width / 2;
    if ((to > from && e.clientX > middle) || (to < from && e.clientX < middle)) move(d.id, to);
  };

  const endDrag = () => {
    drag.current = null;
    setDraggingId(null);
  };

  // A mouse wheel only scrolls vertically; let it scroll the tabs sideways.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && barRef.current) {
      barRef.current.scrollLeft += e.deltaY;
    }
  };

  return (
    <nav className="flex h-9 shrink-0 items-center justify-between border-b pr-2 text-xs">
      <div
        ref={barRef}
        role="tablist"
        onWheel={onWheel}
        className="flex h-full min-w-0 [scrollbar-width:none] items-stretch overflow-x-auto"
      >
        {tabs.length === 0 && (
          <span className="self-center px-3 text-muted-foreground">No tabs</span>
        )}
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            dragging={tab.id === draggingId}
            onPointerDown={(e) => onPointerDown(e, tab)}
            onPointerMove={onPointerMove}
            onPointerEnd={endDrag}
          />
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New query tab"
            onClick={() => useTabsStore.getState().newQuery()}
          >
            <PlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>New query tab (⌘T)</TooltipContent>
      </Tooltip>
    </nav>
  );
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: () => void;
}

function TabItem({ tab, active, dragging, ...handlers }: TabItemProps) {
  // Actions never change; the position and count do, and the menu's disabled items depend on them.
  const { pin } = useTabsStore.getState();
  const dirty = useIsDirty(tab.id);
  const count = useTabsStore((s) => s.tabs.length);
  const index = useTabsStore((s) => s.tabs.findIndex((t) => t.id === tab.id));
  const Icon =
    tab.kind === "table"
      ? OBJECT_ICONS[tab.objectKind]
      : tab.kind === "activity"
        ? ActivityIcon
        : tab.kind === "roles"
          ? ShieldIcon
          : SquareTerminalIcon;
  const title = tabTitle(tab);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          data-tab-id={tab.id}
          aria-selected={active}
          title={tab.kind === "table" ? `${tab.schema}.${tab.name}` : title}
          onPointerDown={handlers.onPointerDown}
          onPointerMove={handlers.onPointerMove}
          onPointerUp={handlers.onPointerEnd}
          onPointerCancel={handlers.onPointerEnd}
          onDoubleClick={() => pin(tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) void closeTab(tab.id); // middle click
          }}
          className={cn(
            "group flex max-w-52 shrink-0 cursor-default items-center gap-1.5 border-r pr-1 pl-2.5 select-none",
            active
              ? "bg-background text-foreground"
              : "bg-muted/40 text-muted-foreground hover:text-foreground",
            dragging && "relative z-10 shadow-md",
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className={cn("truncate", tab.preview && "italic")}>{title}</span>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={() => void closeTab(tab.id)}
            className="relative rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
          >
            {/* A dot while edits are waiting; the × again when the pointer is on it. */}
            {dirty && (
              <span
                role="img"
                aria-label="Unsaved changes"
                className="absolute inset-0 m-auto size-1.5 rounded-full bg-yellow-500 group-hover:hidden"
              />
            )}
            <XIcon className={cn("size-3", dirty && "invisible group-hover:visible")} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {tab.preview && <ContextMenuItem onSelect={() => pin(tab.id)}>Keep open</ContextMenuItem>}
        <ContextMenuItem onSelect={() => void closeTab(tab.id)}>
          Close <ContextMenuShortcut>⌘W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={count < 2} onSelect={() => void closeOtherTabs(tab.id)}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem
          disabled={index === count - 1}
          onSelect={() => void closeTabsToTheRight(tab.id)}
        >
          Close to the right
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void closeAllTabs()}>Close all</ContextMenuItem>
        {tab.kind === "table" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() =>
                void navigator.clipboard
                  .writeText(qualifiedName(tab.schema, tab.name))
                  .catch(() => undefined)
              }
            >
              Copy as schema.name
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
