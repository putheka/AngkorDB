/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_APPEARANCE,
  DENSITIES,
  DENSITY_METRICS,
  gridMetrics,
  resolveDark,
  sanitizeAppearance,
} from "./prefs.ts";

test("system follows macOS, and the other two ignore it", () => {
  assert.equal(resolveDark("system", true), true);
  assert.equal(resolveDark("system", false), false);
  assert.equal(resolveDark("dark", false), true);
  assert.equal(resolveDark("light", true), false);
});

test("a row is always tall enough for its text, and denser means shorter", () => {
  const heights = DENSITIES.map((density) => gridMetrics({ density, gridFontSize: 13 }).rowHeight);
  assert.deepEqual(heights, [22, 28, 36]);
  // A big font pushes a compact row up so text isn't cut off.
  assert.equal(gridMetrics({ density: "compact", gridFontSize: 16 }).rowHeight, 24);
  assert.equal(gridMetrics({ density: "comfortable", gridFontSize: 16 }).rowHeight, 36);
  for (const density of DENSITIES) {
    const m = DENSITY_METRICS[density];
    assert.ok(m.headerHeight > m.rowHeight, density);
  }
});

test("what is stored is checked, and anything odd falls back to the default", () => {
  assert.deepEqual(sanitizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(sanitizeAppearance("dark"), DEFAULT_APPEARANCE);
  assert.deepEqual(sanitizeAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(
    sanitizeAppearance({
      mode: "dark",
      density: "compact",
      gridFont: "mono",
      gridFontSize: 15,
      editorTheme: "ocean",
      translucentSidebar: false,
    }),
    {
      mode: "dark",
      density: "compact",
      gridFont: "mono",
      gridFontSize: 15,
      editorTheme: "ocean",
      translucentSidebar: false,
    },
  );
  assert.deepEqual(
    sanitizeAppearance({
      mode: "auto",
      density: "huge",
      gridFont: "comic",
      gridFontSize: 99,
      editorTheme: "toString",
      translucentSidebar: "yes",
    }),
    DEFAULT_APPEARANCE,
  );
  // One bad value does not spoil the others.
  assert.equal(sanitizeAppearance({ mode: "light", density: 3 }).mode, "light");
  assert.equal(sanitizeAppearance({ mode: "light", density: 3 }).density, "normal");
});
