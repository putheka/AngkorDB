import type { Theme } from "@glideapps/glide-data-grid";
import { useMemo, useSyncExternalStore } from "react";

let probe: CanvasRenderingContext2D | null = null;

/**
 * Any CSS color (our tokens are `oklch(...)`) as an `rgba(...)` string. The grid's canvas code
 * does its own color math and only understands plain colors, so paint one pixel and read it back.
 */
function toRgba(color: string): string {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return color;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000"; // a color the browser can't parse would keep the previous one
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

/** The current value of a CSS variable, as a plain color. */
function token(name: string): string {
  const probeEl = document.createElement("span");
  probeEl.style.color = `var(${name})`;
  document.body.appendChild(probeEl);
  const resolved = getComputedStyle(probeEl).color;
  probeEl.remove();
  return toRgba(resolved);
}

const BLUE = "rgb(59, 130, 246)";
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/** The grid's colors and fonts from our theme tokens, so it matches the rest of the window. */
export function buildGridTheme(): Partial<Theme> {
  const background = token("--background");
  const foreground = token("--foreground");
  const muted = token("--muted-foreground");
  const mutedBackground = token("--muted");
  const border = token("--border");
  const accent = token("--accent");

  return {
    accentColor: BLUE,
    accentFg: "#fff",
    accentLight: "rgba(59, 130, 246, 0.16)",
    textDark: foreground,
    textMedium: muted,
    textLight: muted,
    textHeader: muted,
    textHeaderSelected: "#fff",
    bgCell: background,
    bgCellMedium: mutedBackground,
    bgHeader: mutedBackground,
    bgHeaderHasFocus: accent,
    bgHeaderHovered: accent,
    bgIconHeader: background,
    fgIconHeader: foreground,
    borderColor: border,
    horizontalBorderColor: border,
    headerFontStyle: "600 12px",
    baseFontStyle: "13px",
    markerFontStyle: "11px",
    fontFamily: FONT,
    editorFontSize: "13px",
    cellHorizontalPadding: 10,
  };
}

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.classList.contains("dark");

/** Grid theme that follows light/dark mode. */
export function useGridTheme(): Partial<Theme> {
  const dark = useSyncExternalStore(subscribeToTheme, isDark);
  // `dark` is not read inside, but the tokens it resolves change with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildGridTheme(), [dark]);
}
