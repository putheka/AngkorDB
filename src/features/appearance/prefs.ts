/**
 * What the person can set about how the app looks (ANG-51). Checked on the way in, so anything
 * odd in storage falls back to the defaults. No alias imports (unit-tested in Node).
 */

/** `system` follows macOS and changes with it, live. */
export type AppearanceMode = "system" | "light" | "dark";
export const APPEARANCE_MODES: readonly AppearanceMode[] = ["system", "light", "dark"];

export type Density = "compact" | "normal" | "comfortable";
export const DENSITIES: readonly Density[] = ["compact", "normal", "comfortable"];

export type GridFont = "system" | "mono";
export const GRID_FONT_SIZES = [11, 12, 13, 14, 15, 16] as const;

/** Colors of SQL syntax, in the editor and wherever SQL is shown. `default` is the app's own. */
export type EditorTheme = "default" | "ocean" | "warm" | "mono";
export const EDITOR_THEMES: Record<EditorTheme, string> = {
  default: "Default",
  ocean: "Ocean",
  warm: "Warm",
  mono: "Monochrome",
};

/** The sizes of View ▸ Zoom In and Zoom Out; 1 is actual size. */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75] as const;

/** The next size up (`1`) or down (`-1`), staying at the end of the list. */
export function stepZoom(current: number, direction: 1 | -1): number {
  let at = 0;
  ZOOM_STEPS.forEach((step, i) => {
    if (Math.abs(step - current) < Math.abs((ZOOM_STEPS[at] ?? 1) - current)) at = i;
  });
  return ZOOM_STEPS[Math.min(Math.max(at + direction, 0), ZOOM_STEPS.length - 1)] ?? 1;
}

export interface AppearancePrefs {
  mode: AppearanceMode;
  density: Density;
  gridFont: GridFont;
  gridFontSize: number;
  editorTheme: EditorTheme;
  /** The sidebar shows the desktop through it (macOS vibrancy). */
  translucentSidebar: boolean;
  /** How large everything is drawn: 1 is actual size. */
  zoom: number;
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  mode: "system",
  density: "normal",
  gridFont: "system",
  gridFontSize: 13,
  editorTheme: "default",
  translucentSidebar: true,
  zoom: 1,
};

export interface GridMetrics {
  rowHeight: number;
  headerHeight: number;
  cellPadding: number;
}

/** Row and header heights per density; the font size is set separately. */
export const DENSITY_METRICS: Record<Density, GridMetrics> = {
  compact: { rowHeight: 22, headerHeight: 26, cellPadding: 8 },
  normal: { rowHeight: 28, headerHeight: 32, cellPadding: 10 },
  comfortable: { rowHeight: 36, headerHeight: 38, cellPadding: 12 },
};

/** Whether the app is dark: the person's choice, or macOS's when they chose to follow it. */
export function resolveDark(mode: AppearanceMode, systemDark: boolean): boolean {
  return mode === "system" ? systemDark : mode === "dark";
}

/**
 * Row height that fits the font: a row must hold a line of text with some air, whatever
 * the density and the font size are.
 */
export function gridMetrics(prefs: Pick<AppearancePrefs, "density" | "gridFontSize">): GridMetrics {
  const base = DENSITY_METRICS[prefs.density];
  const least = Math.ceil(prefs.gridFontSize * 1.5);
  return { ...base, rowHeight: Math.max(base.rowHeight, least) };
}

const isOneOf = <T extends number | string>(list: readonly T[], value: unknown): value is T =>
  list.includes(value as T);

/** Take what is stored (or anything else) and give back valid preferences. */
export function sanitizeAppearance(value: unknown): AppearancePrefs {
  const saved: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};
  const prefs = { ...DEFAULT_APPEARANCE };
  if (isOneOf(APPEARANCE_MODES, saved["mode"])) prefs.mode = saved["mode"];
  if (isOneOf(DENSITIES, saved["density"])) prefs.density = saved["density"];
  if (saved["gridFont"] === "system" || saved["gridFont"] === "mono") {
    prefs.gridFont = saved["gridFont"];
  }
  if (isOneOf(GRID_FONT_SIZES, saved["gridFontSize"])) prefs.gridFontSize = saved["gridFontSize"];
  if (
    typeof saved["editorTheme"] === "string" &&
    Object.hasOwn(EDITOR_THEMES, saved["editorTheme"])
  ) {
    prefs.editorTheme = saved["editorTheme"] as EditorTheme;
  }
  if (isOneOf(ZOOM_STEPS, saved["zoom"])) prefs.zoom = saved["zoom"];
  if (typeof saved["translucentSidebar"] === "boolean") {
    prefs.translucentSidebar = saved["translucentSidebar"];
  }
  return prefs;
}
