import { useQuery } from "@tanstack/react-query";
import {
  KeyboardIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  TableIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  APPEARANCE_MODES,
  DENSITIES,
  EDITOR_THEMES,
  GRID_FONT_SIZES,
  type AppearanceMode,
  type Density,
  type EditorTheme,
  type GridFont,
} from "@/features/appearance/prefs";
import { toolsAdvice } from "@/features/backup/backupOptions";
import { FONT_CHOICES, FONT_SIZES, TAB_SIZES, type FontChoice } from "@/features/query/prefs";
import type { KeywordCase } from "@/features/query/format";
import { ShortcutsPanel } from "@/features/shortcuts/ShortcutsDialog";
import {
  DATE_FORMATS,
  NULL_DISPLAYS,
  PAGE_SIZES,
  SAFE_MODE_CHOICES,
  TIME_ZONES,
  type DateFormat,
  type DefaultSafeMode,
  type NullDisplay,
  type PageSize,
  type TimeZoneDisplay,
} from "@/features/settings/generalPrefs";
import { commands } from "@/lib/ipc";
import { pickFolder } from "@/lib/pickFile";
import { cn } from "@/lib/utils";
import { readToolsDir, writeToolsDir } from "@/stores/backupDialog";
import { useAppearance } from "@/stores/appearance";
import { useEditorPrefs } from "@/stores/editorPrefs";
import { useGeneral } from "@/stores/general";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "editor", label: "Editor", icon: TerminalIcon },
  { id: "grid", label: "Grid", icon: TableIcon },
  { id: "security", label: "Security", icon: ShieldIcon },
  { id: "tools", label: "Tools", icon: WrenchIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const SELECT = "h-8 max-w-72 rounded-lg border bg-background px-2 text-sm";

const MODE_LABELS: Record<AppearanceMode, string> = {
  system: "Match macOS",
  light: "Light",
  dark: "Dark",
};
const DENSITY_LABELS: Record<Density, string> = {
  compact: "Compact",
  normal: "Normal",
  comfortable: "Comfortable",
};
const GRID_FONT_LABELS: Record<GridFont, string> = { system: "System", mono: "Monospace" };
const KEYWORD_LABELS: Record<KeywordCase, string> = {
  upper: "UPPER CASE",
  lower: "lower case",
  preserve: "As typed",
};

/** A line of settings: what it is, a hint under it, and the control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Choice<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className={SELECT}
      value={String(value)}
      onChange={(e) => {
        const picked = options.find((o) => String(o.value) === e.target.value);
        if (picked) onChange(picked.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

const entries = <K extends string>(record: Record<K, string>) =>
  (Object.keys(record) as K[]).map((value) => ({ value, label: record[value] }));

function General() {
  const general = useGeneral();
  const appearance = useAppearance();
  const startup = useQuery({ queryKey: ["startup-state"], queryFn: () => commands.startupState() });
  const [restore, setRestore] = useState<boolean | null>(null);
  const restoreNow = restore ?? startup.data?.restoreOnLaunch ?? true;
  return (
    <>
      <Row label="Appearance" hint="Match macOS follows it as it changes, with no restart.">
        <Choice
          label="Appearance"
          value={appearance.mode}
          options={APPEARANCE_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
          onChange={(mode) => appearance.set({ mode })}
        />
      </Row>
      <Row label="Translucent sidebar" hint="Lets the desktop show through the sidebar.">
        <Toggle
          label="Translucent sidebar"
          checked={appearance.translucentSidebar}
          onChange={(translucentSidebar) => appearance.set({ translucentSidebar })}
        />
      </Row>
      <Row
        label="Open the last connection when AngkorDB starts"
        hint="With its tabs and the text of its queries. Off: start at the connections list."
      >
        <Toggle
          label="Open the last connection when AngkorDB starts"
          checked={restoreNow}
          onChange={(value) => {
            setRestore(value);
            void commands.setRestoreOnLaunch(value);
          }}
        />
      </Row>
      <Row label="Rows per page" hint="For a table that is opened. Each table can change it.">
        <Choice
          label="Rows per page"
          value={general.pageSize}
          options={PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
          onChange={(pageSize: PageSize) => general.set({ pageSize })}
        />
      </Row>
      <Row label="Ask before quitting" hint="Even when nothing is unsaved.">
        <Toggle
          label="Ask before quitting"
          checked={general.confirmOnQuit}
          onChange={(confirmOnQuit) => general.set({ confirmOnQuit })}
        />
      </Row>
      <Row
        label="Check for updates"
        hint="Looks for a new version a few seconds after the app starts. AngkorDB ▸ Check for Updates does it any time."
      >
        <Toggle
          label="Check for updates"
          checked={general.checkForUpdates}
          onChange={(checkForUpdates) => general.set({ checkForUpdates })}
        />
      </Row>
    </>
  );
}

function Editor() {
  const prefs = useEditorPrefs();
  const appearance = useAppearance();
  return (
    <>
      <Row label="Font">
        <Choice
          label="Editor font"
          value={prefs.fontFamily}
          options={(Object.keys(FONT_CHOICES) as FontChoice[]).map((id) => ({
            value: id,
            label: FONT_CHOICES[id].label,
          }))}
          onChange={(fontFamily) => prefs.set({ fontFamily })}
        />
        <Choice
          label="Editor font size"
          value={prefs.fontSize}
          options={FONT_SIZES.map((n) => ({ value: n, label: `${n} px` }))}
          onChange={(fontSize) => prefs.set({ fontSize })}
        />
      </Row>
      <Row label="Tab size">
        <Choice
          label="Tab size"
          value={prefs.tabSize}
          options={TAB_SIZES.map((n) => ({ value: n, label: `${n} spaces` }))}
          onChange={(tabSize) => prefs.set({ tabSize })}
        />
      </Row>
      <Row label="Line numbers">
        <Toggle
          label="Line numbers"
          checked={prefs.lineNumbers}
          onChange={(lineNumbers) => prefs.set({ lineNumbers })}
        />
      </Row>
      <Row label="Word wrap">
        <Toggle
          label="Word wrap"
          checked={prefs.wordWrap}
          onChange={(wordWrap) => prefs.set({ wordWrap })}
        />
      </Row>
      <Row label="Vim keys">
        <Toggle label="Vim keys" checked={prefs.vim} onChange={(vim) => prefs.set({ vim })} />
      </Row>
      <Row label="Keywords when formatting">
        <Choice
          label="Keywords when formatting"
          value={prefs.keywordCase}
          options={(Object.keys(KEYWORD_LABELS) as KeywordCase[]).map((id) => ({
            value: id,
            label: KEYWORD_LABELS[id],
          }))}
          onChange={(keywordCase) => prefs.set({ keywordCase })}
        />
      </Row>
      <Row label="SQL colors" hint="Also used where SQL is shown outside the editor.">
        <Choice
          label="SQL colors"
          value={appearance.editorTheme}
          options={entries(EDITOR_THEMES)}
          onChange={(editorTheme: EditorTheme) => appearance.set({ editorTheme })}
        />
      </Row>
    </>
  );
}

function Grid() {
  const appearance = useAppearance();
  const general = useGeneral();
  return (
    <>
      <Row label="Density" hint="How tall the rows are.">
        <Choice
          label="Density"
          value={appearance.density}
          options={DENSITIES.map((d) => ({ value: d, label: DENSITY_LABELS[d] }))}
          onChange={(density) => appearance.set({ density })}
        />
      </Row>
      <Row label="Font">
        <Choice
          label="Grid font"
          value={appearance.gridFont}
          options={entries(GRID_FONT_LABELS)}
          onChange={(gridFont: GridFont) => appearance.set({ gridFont })}
        />
        <Choice
          label="Grid font size"
          value={appearance.gridFontSize}
          options={GRID_FONT_SIZES.map((n) => ({ value: n, label: `${n} px` }))}
          onChange={(gridFontSize) => appearance.set({ gridFontSize })}
        />
      </Row>
      <Row label="NULL" hint="Always grey and italic, so it is never mistaken for text.">
        <Choice
          label="NULL display"
          value={general.nullDisplay}
          options={entries(NULL_DISPLAYS)}
          onChange={(nullDisplay: NullDisplay) => general.set({ nullDisplay })}
        />
      </Row>
      <Row
        label="Dates and times"
        hint="Only how they are shown: copying and editing keep the value."
      >
        <Choice
          label="Date format"
          value={general.dateFormat}
          options={entries(DATE_FORMATS)}
          onChange={(dateFormat: DateFormat) => general.set({ dateFormat })}
        />
      </Row>
      <Row
        label="Time zone"
        hint="For timestamp with time zone. A timestamp without one is never moved."
      >
        <Choice
          label="Time zone"
          value={general.timeZone}
          options={entries(TIME_ZONES)}
          onChange={(timeZone: TimeZoneDisplay) => general.set({ timeZone })}
        />
      </Row>
    </>
  );
}

function Security() {
  const general = useGeneral();
  return (
    <Row
      label="Safe mode of a new connection"
      hint="What a connection starts with. Each connection keeps its own. Touch ID asks for Touch ID or your Mac password."
    >
      <Choice
        label="Safe mode of a new connection"
        value={general.defaultSafeMode}
        options={entries(SAFE_MODE_CHOICES)}
        onChange={(defaultSafeMode: DefaultSafeMode) => general.set({ defaultSafeMode })}
      />
    </Row>
  );
}

function Tools() {
  const [dir, setDir] = useState<string | null>(readToolsDir);
  const found = useQuery({
    queryKey: ["pg-tools", dir],
    queryFn: () => commands.detectPgTools(dir),
    staleTime: 60_000,
  });
  const [error, setError] = useState<string | null>(null);
  const advice = toolsAdvice(found.data ?? [], null);

  return (
    <>
      <Row
        label="pg_dump and pg_restore"
        hint={
          dir
            ? `Looking in ${dir} first.`
            : "Found automatically: Homebrew, Postgres.app, the EDB installer, PATH."
        }
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              const chosen = await pickFolder("Folder with pg_dump and pg_restore");
              if (!chosen) return;
              writeToolsDir(chosen);
              setDir(chosen);
              setError(null);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Choose folder…
        </Button>
        {dir && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              writeToolsDir(null);
              setDir(null);
            }}
          >
            Use the ones found
          </Button>
        )}
      </Row>
      {error && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="py-2 text-xs">
        {found.isPending ? (
          <p className="text-muted-foreground">Looking…</p>
        ) : (found.data ?? []).length === 0 ? (
          <p className="text-amber-700 dark:text-amber-300">{advice.warning}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {(found.data ?? []).map((tool) => (
              <li key={tool.dir} className="flex gap-2">
                <span className="w-20 shrink-0 font-medium">PostgreSQL {tool.major}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                  title={tool.dir}
                >
                  {tool.dir}
                </span>
                <span className="shrink-0 text-muted-foreground">{tool.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The settings window (⌘,): a list of sections on the left, the settings of one on the right.
 * Everything is stored as soon as it is changed, and the main window takes it in at once.
 */
export function SettingsApp() {
  const [section, setSection] = useState<SectionId>("general");
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="flex h-full bg-background text-foreground">
      <nav
        aria-label="Settings sections"
        className="flex w-44 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2 pt-4"
      >
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={id === section ? "page" : undefined}
            onClick={() => setSection(id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
              id === section ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60",
            )}
          >
            <Icon className="size-4 text-muted-foreground" />
            {label}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <h1 className="pb-3 text-lg font-semibold">{current.label}</h1>
        {section === "general" && <General />}
        {section === "editor" && <Editor />}
        {section === "grid" && <Grid />}
        {section === "security" && <Security />}
        {section === "tools" && <Tools />}
        {section === "shortcuts" && <ShortcutsPanel />}
      </main>
    </div>
  );
}
