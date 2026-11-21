/**
 * Dates and times in the grid (ANG-53), written the way the person chose. Display only: the
 * value that is copied or edited stays what Postgres sent. No alias imports (unit-tested in Node).
 *
 * Anything this doesn't recognise (`infinity`, years BC, a shape from an odd `DateStyle`) comes
 * back as it was: showing the database's text is always right.
 */
import type { DateFormat, TimeZoneDisplay } from "../settings/generalPrefs.ts";

type Kind = "timestamptz" | "timestamp" | "date" | "time";

/** What a column's type is, in these terms; `null` for anything else. */
export function temporalKind(typeName: string): Kind | null {
  const t = typeName.toLowerCase();
  if (t.startsWith("timestamp"))
    return t.includes("without time zone")
      ? "timestamp"
      : t.includes("with time zone")
        ? "timestamptz"
        : "timestamp";
  if (t === "date") return "date";
  if (t.startsWith("time ") || t.startsWith("time("))
    return t.includes("with time zone") ? null : "time";
  return null;
}

const TIMESTAMPTZ =
  /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-]\d{2})(?::(\d{2}))?(?::(\d{2}))?$/;
const TIMESTAMP = /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;
const DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Date and time on a clock shifted `offsetMinutes` from UTC. */
function wallOf(ms: number, offsetMinutes: number): Wall {
  const d = new Date(ms + offsetMinutes * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

const dateText = (w: Wall) => `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
const timeText = (w: Wall, fraction: string) =>
  `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${fraction}`;

/** `+07`, `+05:30`, `-08` as Postgres writes an offset. */
function postgresOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `${sign}${pad(hours)}${rest ? `:${pad(rest)}` : ""}`;
}

/** `+07:00`, or `Z` for none, as ISO 8601 writes it. */
function isoOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

function localeText(w: Wall, dateOnly: boolean, timeOnly = false): string {
  // The wall clock, written by the Mac's locale; `UTC` so no zone is applied a second time.
  const d = new Date(Date.UTC(2000, w.month - 1, w.day, w.hour, w.minute, w.second));
  d.setUTCFullYear(w.year);
  const style: Intl.DateTimeFormatOptions = {
    timeZone: "UTC",
    ...(timeOnly ? {} : { dateStyle: "medium" as const }),
    ...(dateOnly ? {} : { timeStyle: "medium" as const }),
  };
  return new Intl.DateTimeFormat(undefined, style).format(d);
}

interface Options {
  dateFormat: DateFormat;
  timeZone: TimeZoneDisplay;
}

/** `text` (what Postgres sent for a column of `typeName`) as the settings want it shown. */
export function formatTemporal(text: string, typeName: string, options: Options): string {
  const kind = temporalKind(typeName);
  if (!kind) return text;
  const { dateFormat, timeZone } = options;
  if (kind === "time") {
    const match = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(text);
    if (!match || dateFormat !== "locale") return text;
    const wall: Wall = {
      year: 2000,
      month: 1,
      day: 1,
      hour: Number(match[1]),
      minute: Number(match[2]),
      second: Number(match[3]),
    };
    return localeText(wall, false, true);
  }
  if (kind === "date") {
    const match = DATE.exec(text);
    if (!match || dateFormat !== "locale") return text;
    const wall: Wall = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
    return localeText(wall, true);
  }
  if (kind === "timestamp") {
    const match = TIMESTAMP.exec(text);
    if (!match || dateFormat === "database") return text;
    const wall: Wall = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6]),
    };
    const fraction = match[7] ?? "";
    return dateFormat === "iso"
      ? `${dateText(wall)}T${timeText(wall, fraction)}`
      : localeText(wall, false);
  }

  // timestamptz
  const match = TIMESTAMPTZ.exec(text);
  if (!match) return text;
  const [, y, mo, d, h, mi, s, fraction = "", offHours, offMinutes = "00"] = match;
  const sourceOffset =
    (offHours?.startsWith("-") ? -1 : 1) * (Math.abs(Number(offHours)) * 60 + Number(offMinutes));
  const asUtc = Date.UTC(2000, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const when = new Date(asUtc);
  when.setUTCFullYear(Number(y));
  const ms = when.getTime() - sourceOffset * 60_000;
  if (Number.isNaN(ms)) return text;

  const offset =
    timeZone === "utc"
      ? 0
      : timeZone === "local"
        ? -new Date(ms).getTimezoneOffset()
        : sourceOffset;
  const wall = wallOf(ms, offset);
  if (dateFormat === "database") {
    return `${dateText(wall)} ${timeText(wall, fraction)}${postgresOffset(offset)}`;
  }
  if (dateFormat === "iso") {
    return `${dateText(wall)}T${timeText(wall, fraction)}${isoOffset(offset)}`;
  }
  return `${localeText(wall, false)} ${postgresOffset(offset)}`;
}
