/**
 * What the person can set about the SQL editor (ANG-34). The values are checked on the way in,
 * so anything odd in storage falls back to the defaults. No alias imports (unit-tested in Node).
 */
import type { KeywordCase } from "./format.ts";

export const FONT_CHOICES = {
  system: { label: "SF Mono", css: '"SF Mono", ui-monospace, Menlo, monospace' },
  menlo: { label: "Menlo", css: "Menlo, monospace" },
  monaco: { label: "Monaco", css: "Monaco, Menlo, monospace" },
  courier: { label: "Courier New", css: '"Courier New", Courier, monospace' },
} as const;

export type FontChoice = keyof typeof FONT_CHOICES;

export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20] as const;
export const TAB_SIZES = [2, 4, 8] as const;
export const KEYWORD_CASES: readonly KeywordCase[] = ["upper", "lower", "preserve"];

export interface EditorPrefs {
  fontFamily: FontChoice;
  fontSize: number;
  tabSize: number;
  lineNumbers: boolean;
  wordWrap: boolean;
  vim: boolean;
  keywordCase: KeywordCase;
}

export const DEFAULT_PREFS: EditorPrefs = {
  fontFamily: "system",
  fontSize: 13,
  tabSize: 2,
  lineNumbers: true,
  wordWrap: false,
  vim: false,
  keywordCase: "upper",
};

const isOneOf = <T extends number | string>(list: readonly T[], value: unknown): value is T =>
  list.includes(value as T);

/** Take what is stored (or anything else) and give back valid preferences. */
export function sanitizePrefs(value: unknown): EditorPrefs {
  const saved: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};
  const prefs = { ...DEFAULT_PREFS };
  if (typeof saved["fontFamily"] === "string" && Object.hasOwn(FONT_CHOICES, saved["fontFamily"])) {
    prefs.fontFamily = saved["fontFamily"] as FontChoice;
  }
  if (isOneOf(FONT_SIZES, saved["fontSize"])) prefs.fontSize = saved["fontSize"];
  if (isOneOf(TAB_SIZES, saved["tabSize"])) prefs.tabSize = saved["tabSize"];
  if (typeof saved["lineNumbers"] === "boolean") prefs.lineNumbers = saved["lineNumbers"];
  if (typeof saved["wordWrap"] === "boolean") prefs.wordWrap = saved["wordWrap"];
  if (typeof saved["vim"] === "boolean") prefs.vim = saved["vim"];
  if (isOneOf(KEYWORD_CASES, saved["keywordCase"])) prefs.keywordCase = saved["keywordCase"];
  return prefs;
}
