import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { SIDEBAR_MAX, SIDEBAR_MIN, useLayoutStore } from "@/stores/layout";

const STEP = 16;
const BIG_STEP = 48;

/** The draggable edge of the sidebar. Also works with the arrow keys; double-click resets. */
export function SidebarResizer() {
  const width = useLayoutStore((s) => s.sidebarWidth);
  const setWidth = useLayoutStore((s) => s.setSidebarWidth);
  const reset = useLayoutStore((s) => s.resetSidebarWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); // no text selection while dragging
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(drag.current.startWidth + e.clientX - drag.current.startX);
  };
  const stopDrag = () => {
    drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const next = {
      ArrowLeft: width - step,
      ArrowRight: width + step,
      Home: SIDEBAR_MIN,
      End: SIDEBAR_MAX,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring/40 group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
}
