/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PgTools, ToolStatus } from "../../bindings.ts";
import {
  backupProblem,
  databaseNameOf,
  defaultBackupForm,
  defaultFileName,
  defaultRestoreForm,
  jobsOf,
  listOf,
  progressText,
  restoreProblem,
  sizeText,
  toBackupRequest,
  toRestoreRequest,
  toolsAdvice,
} from "./backupOptions.ts";

const tool = (major: number): PgTools => ({
  dir: `/pg${major}/bin`,
  version: `${major}.1`,
  major,
  source: "test",
});

test("table lists accept lines and commas", () => {
  assert.deepEqual(listOf("public.a, public.b\n\n  c* \n"), ["public.a", "public.b", "c*"]);
  assert.deepEqual(listOf("  "), []);
});

test("the backup request follows the form", () => {
  const request = toBackupRequest(
    { ...defaultBackupForm, scope: "schema", include: "a, b", exclude: "c", compression: "6" },
    "/x/shop.dump",
    "/pg17/bin",
    "shop",
  );
  assert.deepEqual(request, {
    toolsDir: "/pg17/bin",
    database: "shop",
    path: "/x/shop.dump",
    format: "custom",
    schemaOnly: true,
    dataOnly: false,
    includeTables: ["a", "b"],
    excludeTables: ["c"],
    compression: 6,
    noOwner: true,
  });
  const data = toBackupRequest({ ...defaultBackupForm, scope: "data" }, "/x", null, null);
  assert.equal(data.dataOnly, true);
  assert.equal(data.schemaOnly, false);
  assert.equal(data.compression, null);
});

test("what is wrong with the backup form", () => {
  assert.equal(backupProblem(defaultBackupForm), null);
  assert.match(backupProblem({ ...defaultBackupForm, compression: "10" }) ?? "", /0 to 9/);
  assert.match(backupProblem({ ...defaultBackupForm, compression: "x" }) ?? "", /0 to 9/);
  assert.equal(backupProblem({ ...defaultBackupForm, compression: "0" }), null);
  assert.match(backupProblem({ ...defaultBackupForm, include: "--file=x" }) ?? "", /not a table/);
  assert.match(backupProblem({ ...defaultBackupForm, exclude: "ok, -t" }) ?? "", /not a table/);
});

test("file and database names", () => {
  const day = new Date("2026-01-02T10:00:00Z");
  assert.equal(defaultFileName("shop", "custom", day), "shop-2026-01-02.dump");
  assert.equal(defaultFileName("shop", "plain", day), "shop-2026-01-02.sql");
  assert.equal(defaultFileName("shop", "tar", day), "shop-2026-01-02.tar");
  assert.equal(defaultFileName("shop", "directory", day), "shop-2026-01-02");
  assert.equal(defaultFileName("a/b", "plain", day), "a_b-2026-01-02.sql");
  assert.equal(databaseNameOf("/x/shop-2026-01-02.dump"), "shop_2026_01_02_restored");
  assert.equal(databaseNameOf("/x/Shop Backup/"), "shop_backup_restored");
  assert.equal(databaseNameOf("/x/---.dump"), "restored_restored");
});

test("the restore request follows the form; drop-first only applies to an existing database", () => {
  const into = (patch: Partial<typeof defaultRestoreForm>) =>
    toRestoreRequest({ ...defaultRestoreForm, ...patch }, "/x/a.dump", null);
  assert.deepEqual(into({ newName: " copy ", clean: true, jobs: "8" }), {
    toolsDir: null,
    path: "/x/a.dump",
    target: { kind: "new", database: "copy" },
    clean: false,
    noOwner: true,
    jobs: 8,
  });
  const existing = into({ intoNew: false, existing: "shop", clean: true });
  assert.deepEqual(existing.target, { kind: "existing", database: "shop" });
  assert.equal(existing.clean, true);
  assert.equal(jobsOf("99"), 16);
  assert.equal(jobsOf("0"), 1);
  assert.equal(jobsOf("x"), 1);
});

test("what is wrong with the restore form", () => {
  assert.match(restoreProblem(defaultRestoreForm) ?? "", /name/);
  assert.equal(restoreProblem({ ...defaultRestoreForm, newName: "copy" }), null);
  assert.match(
    restoreProblem({ ...defaultRestoreForm, intoNew: false }) ?? "",
    /Choose the database/,
  );
  assert.equal(restoreProblem({ ...defaultRestoreForm, intoNew: false, existing: "shop" }), null);
  assert.match(
    restoreProblem({ ...defaultRestoreForm, newName: "c", jobs: "40" }) ?? "",
    /1 to 16/,
  );
});

test("the tools to use, and when there are none that suit", () => {
  const found = [tool(17), tool(16), tool(14)];
  assert.equal(toolsAdvice(found, "16.4").tool?.major, 16);
  assert.equal(toolsAdvice(found, "15.2").tool?.major, 16);
  assert.equal(toolsAdvice(found, "16.4").warning, null);
  const old = toolsAdvice(found, "18.0");
  assert.equal(old.tool?.major, 17); // the newest, shown with the warning
  assert.match(old.warning ?? "", /too old.*postgresql@18/);
  assert.match(toolsAdvice([], "16.4").warning ?? "", /not found/);
  assert.equal(toolsAdvice(found, null).tool?.major, 17);
});

test("progress text", () => {
  const status = (patch: Partial<ToolStatus>): ToolStatus => ({
    state: "running",
    log: [],
    lines: 12,
    bytes: 2048,
    command: "",
    output: null,
    error: null,
    ...patch,
  });
  assert.equal(progressText(status({}), true), "2.0 KB written · 12 lines of output");
  assert.equal(progressText(status({}), false), "12 lines of output");
  assert.equal(progressText(status({ bytes: 0 }), true), "12 lines of output");
  assert.equal(sizeText(56 * 1024 * 1024), "56 MB");
});
