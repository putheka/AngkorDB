/**
 * The settings that are not about colors, fonts or keys (ANG-53): what happens at launch and
 * quit, how a table is paged, how grid values are written, what a new connection starts with.
 * Checked on the way in, so anything odd in storage falls back to the defaults. No alias imports
 * (unit-tested in Node).
 */

export const PAGE_SIZES = [100, 500, 1000] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** How a NULL is drawn in the grid (never confusable with the text "NULL": it stays grey italic). */
export type NullDisplay = "NULL" | "null" | "∅" | "(null)" | "blank";
export const NULL_DISPLAYS: Record<NullDisplay, string> = {
  NULL: "NULL",
  null: "null",
  "∅": "∅ (empty set)",
  "(null)": "(null)",
  blank: "Nothing",
};

/** `database`: as Postgres prints it. `iso`: 2024-03-01T12:34:56. `locale`: as macOS writes dates. */
export type DateFormat = "database" | "iso" | "locale";
export const DATE_FORMATS: Record<DateFormat, string> = {
  database: "As the database prints it",
  iso: "ISO 8601",
  locale: "As macOS writes dates",
};

/** Which clock a `timestamptz` is shown in: the one it came in, UTC, or this Mac's. */
export type TimeZoneDisplay = "database" | "utc" | "local";
export const TIME_ZONES: Record<TimeZoneDisplay, string> = {
  database: "As the database sends it",
  utc: "UTC",
  local: "This Mac's time zone",
};

export type DefaultSafeMode = "off" | "confirm" | "touch-id" | "read-only";
export const SAFE_MODE_CHOICES: Record<DefaultSafeMode, string> = {
  off: "Off: reads and writes",
  confirm: "Confirm: ask before saving or running changes",
  "touch-id": "Touch ID: ask for Touch ID or your Mac password",
  "read-only": "Read-only: the server refuses writes",
};

export interface GeneralPrefs {
  /** Rows per page of a table that is opened. */
  pageSize: PageSize;
  /** Ask before quitting, even with nothing unsaved. */
  confirmOnQuit: boolean;
  /** Look for a new version when the app starts (used by the updater, ANG-59). */
  checkForUpdates: boolean;
  nullDisplay: NullDisplay;
  dateFormat: DateFormat;
  timeZone: TimeZoneDisplay;
  /** What a new connection starts with. */
  defaultSafeMode: DefaultSafeMode;
}

export const DEFAULT_GENERAL: GeneralPrefs = {
  pageSize: 500,
  confirmOnQuit: false,
  checkForUpdates: true,
  nullDisplay: "NULL",
  dateFormat: "database",
  timeZone: "database",
  defaultSafeMode: "off",
};

/** The part of the settings that changes how a grid cell is written. */
export type DisplayPrefs = Pick<GeneralPrefs, "nullDisplay" | "dateFormat" | "timeZone">;

export const DEFAULT_DISPLAY: DisplayPrefs = {
  nullDisplay: DEFAULT_GENERAL.nullDisplay,
  dateFormat: DEFAULT_GENERAL.dateFormat,
  timeZone: DEFAULT_GENERAL.timeZone,
};

/** The text a NULL is drawn as. */
export const nullText = (display: NullDisplay): string => (display === "blank" ? "" : display);

const has = (record: object, key: unknown): key is string =>
  typeof key === "string" && Object.hasOwn(record, key);

/** Take what is stored (or anything else) and give back valid settings. */
export function sanitizeGeneral(value: unknown): GeneralPrefs {
  const saved: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};
  const prefs = { ...DEFAULT_GENERAL };
  if ((PAGE_SIZES as readonly unknown[]).includes(saved["pageSize"])) {
    prefs.pageSize = saved["pageSize"] as PageSize;
  }
  if (typeof saved["confirmOnQuit"] === "boolean") prefs.confirmOnQuit = saved["confirmOnQuit"];
  if (typeof saved["checkForUpdates"] === "boolean") {
    prefs.checkForUpdates = saved["checkForUpdates"];
  }
  if (has(NULL_DISPLAYS, saved["nullDisplay"]))
    prefs.nullDisplay = saved["nullDisplay"] as NullDisplay;
  if (has(DATE_FORMATS, saved["dateFormat"])) prefs.dateFormat = saved["dateFormat"] as DateFormat;
  if (has(TIME_ZONES, saved["timeZone"])) prefs.timeZone = saved["timeZone"] as TimeZoneDisplay;
  if (has(SAFE_MODE_CHOICES, saved["defaultSafeMode"])) {
    prefs.defaultSafeMode = saved["defaultSafeMode"] as DefaultSafeMode;
  }
  return prefs;
}
