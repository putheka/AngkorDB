import type { Theme } from "@glideapps/glide-data-grid";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { gridMetrics, type AppearancePrefs } from "@/features/appearance/prefs";
import { useAppearance } from "@/stores/appearance";

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

const FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
  mono: '"SF Mono", ui-monospace, Menlo, monospace',
} as const;

/** `rgba(r, g, b, a)` with another alpha. */
function withAlpha(rgba: string, alpha: number): string {
  const [r = "0", g = "0", b = "0"] = rgba.match(/[\d.]+/g) ?? [];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The grid's colors and fonts from our theme tokens, so it matches the rest of the window. */
export function buildGridTheme(
  prefs: Pick<AppearancePrefs, "density" | "gridFont" | "gridFontSize">,
): Partial<Theme> {
  const background = token("--background");
  const foreground = token("--foreground");
  const muted = token("--muted-foreground");
  const mutedBackground = token("--muted");
  const border = token("--border");
  const accent = token("--accent");
  // The macOS accent color (blue where the system doesn't say).
  const system = token("--app-accent");
  const size = prefs.gridFontSize;

  return {
    accentColor: system,
    accentFg: "#fff",
    accentLight: withAlpha(system, 0.16),
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
    headerFontStyle: `600 ${size - 1}px`,
    baseFontStyle: `${size}px`,
    markerFontStyle: `${size - 2}px`,
    fontFamily: FONTS[prefs.gridFont],
    editorFontSize: `${size}px`,
    cellHorizontalPadding: gridMetrics(prefs).cellPadding,
  };
}

/** The color of every other row. */
export function buildGridStripe(): string {
  return token("--grid-stripe");
}

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.classList.contains("dark");

/** The window came to the front: the person may have changed the system accent color meanwhile. */
function useAccentTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, []);
  return tick;
}

/** Grid theme that follows light/dark mode, the accent color, the font and the density. */
export function useGridTheme(): Partial<Theme> {
  const dark = useSyncExternalStore(subscribeToTheme, isDark);
  const density = useAppearance((s) => s.density);
  const gridFont = useAppearance((s) => s.gridFont);
  const gridFontSize = useAppearance((s) => s.gridFontSize);
  const accentTick = useAccentTick();
  return useMemo(() => {
    // Not read, but the tokens `buildGridTheme` resolves change with them.
    void dark;
    void accentTick;
    return buildGridTheme({ density, gridFont, gridFontSize });
  }, [dark, accentTick, density, gridFont, gridFontSize]);
}

/** The color of the striped rows; it follows light/dark mode. */
export function useGridStripe(): string {
  const dark = useSyncExternalStore(subscribeToTheme, isDark);
  return useMemo(() => {
    // Not read, but the token `buildGridStripe` resolves changes with it.
    void dark;
    return buildGridStripe();
  }, [dark]);
}
