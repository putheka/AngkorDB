/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_GENERAL, sanitizeGeneral, nullText } from "../settings/generalPrefs.ts";
import { formatTemporal, temporalKind } from "./temporal.ts";

// A zone with no daylight saving, so "this Mac's time zone" has one answer all year.
process.env["TZ"] = "Asia/Phnom_Penh"; // UTC+7

const tz = "timestamp with time zone";
const show = (
  text: string,
  type: string,
  dateFormat: "database" | "iso" | "locale",
  timeZone: "database" | "utc" | "local",
) => formatTemporal(text, type, { dateFormat, timeZone });

test("which columns are dates and times", () => {
  assert.equal(temporalKind("timestamp with time zone"), "timestamptz");
  assert.equal(temporalKind("timestamp(3) with time zone"), "timestamptz");
  assert.equal(temporalKind("timestamp without time zone"), "timestamp");
  assert.equal(temporalKind("timestamp(6) without time zone"), "timestamp");
  assert.equal(temporalKind("date"), "date");
  assert.equal(temporalKind("time without time zone"), "time");
  for (const other of [
    "text",
    "integer",
    "interval",
    "time with time zone",
    "timestamps",
    "tstzrange",
  ]) {
    assert.equal(temporalKind(other), other === "timestamps" ? "timestamp" : null, other);
  }
});

test("by default what the database sent is what is shown", () => {
  for (const [text, type] of [
    ["2024-03-01 12:34:56.789+00", tz],
    ["2024-03-01 12:34:56", "timestamp without time zone"],
    ["2024-03-01", "date"],
    ["12:34:56", "time without time zone"],
    ["not a date", tz],
  ] as const) {
    assert.equal(show(text, type, "database", "database"), text);
  }
});

test("a timestamptz can be shown in UTC, in this Mac's zone, or the one it came in", () => {
  const sent = "2024-03-01 12:34:56.123456+05:30";
  assert.equal(show(sent, tz, "database", "utc"), "2024-03-01 07:04:56.123456+00");
  assert.equal(show(sent, tz, "database", "local"), "2024-03-01 14:04:56.123456+07");
  assert.equal(show(sent, tz, "database", "database"), sent);
  // The day can change with the zone.
  assert.equal(show("2024-03-01 22:00:00+00", tz, "database", "local"), "2024-03-02 05:00:00+07");
  assert.equal(show("2024-03-01 01:00:00+07", tz, "database", "utc"), "2024-02-29 18:00:00+00");
  assert.equal(
    show("2024-03-01 08:00:00-08", tz, "database", "database"),
    "2024-03-01 08:00:00-08",
  );
});

test("ISO 8601 writes a T and a Z", () => {
  assert.equal(show("2024-03-01 12:34:56.5+00", tz, "iso", "database"), "2024-03-01T12:34:56.5Z");
  assert.equal(show("2024-03-01 12:34:56+07", tz, "iso", "database"), "2024-03-01T12:34:56+07:00");
  assert.equal(show("2024-03-01 12:34:56+05:30", tz, "iso", "utc"), "2024-03-01T07:04:56Z");
  assert.equal(
    show("2024-03-01 12:34:56", "timestamp without time zone", "iso", "local"),
    "2024-03-01T12:34:56",
  );
  assert.equal(
    show("2024-03-01 12:34:56.25", "timestamp without time zone", "iso", "utc"),
    "2024-03-01T12:34:56.25",
  );
  // A date and a time of day are already unambiguous.
  assert.equal(show("2024-03-01", "date", "iso", "local"), "2024-03-01");
  assert.equal(show("12:34:56", "time without time zone", "iso", "local"), "12:34:56");
});

test("a timestamp without a zone is never moved to another zone", () => {
  assert.equal(
    show("2024-03-01 23:59:59", "timestamp without time zone", "database", "utc"),
    "2024-03-01 23:59:59",
  );
  assert.equal(
    show("2024-03-01 23:59:59", "timestamp without time zone", "iso", "local"),
    "2024-03-01T23:59:59",
  );
});

test("the locale format uses the Mac's way of writing dates", () => {
  const out = show("2024-03-01 12:34:56+07", tz, "locale", "database");
  assert.match(out, /2024/);
  assert.match(out, /\+07$/);
  assert.match(show("2024-03-01", "date", "locale", "database"), /2024/);
  assert.match(show("12:34:56", "time without time zone", "locale", "database"), /12|34/);
});

test("anything else is left exactly as it was", () => {
  for (const text of [
    "infinity",
    "-infinity",
    "0044-03-15 12:00:00+00 BC",
    "01/02/2024",
    "",
    "2024-13-45 99:99:99+00x",
  ]) {
    assert.equal(show(text, tz, "iso", "utc"), text, text);
    assert.equal(show(text, "date", "locale", "utc"), text, text);
  }
  assert.equal(show("2024-03-01 12:00:00+00", "text", "iso", "utc"), "2024-03-01 12:00:00+00");
});

test("the settings are checked, and the defaults hold when they are odd", () => {
  assert.deepEqual(sanitizeGeneral(undefined), DEFAULT_GENERAL);
  assert.deepEqual(sanitizeGeneral(42), DEFAULT_GENERAL);
  assert.deepEqual(
    sanitizeGeneral({
      pageSize: 1000,
      confirmOnQuit: true,
      checkForUpdates: false,
      nullDisplay: "∅",
      dateFormat: "iso",
      timeZone: "utc",
      defaultSafeMode: "read-only",
    }),
    {
      pageSize: 1000,
      confirmOnQuit: true,
      checkForUpdates: false,
      nullDisplay: "∅",
      dateFormat: "iso",
      timeZone: "utc",
      defaultSafeMode: "read-only",
    },
  );
  assert.deepEqual(
    sanitizeGeneral({
      pageSize: 7,
      confirmOnQuit: "yes",
      checkForUpdates: 0,
      nullDisplay: "toString",
      dateFormat: "us",
      timeZone: "mars",
      defaultSafeMode: "yolo",
    }),
    DEFAULT_GENERAL,
  );
  assert.equal(nullText("NULL"), "NULL");
  assert.equal(nullText("blank"), "");
  assert.equal(nullText("∅"), "∅");
});
