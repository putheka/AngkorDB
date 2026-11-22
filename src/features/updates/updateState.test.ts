/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  afterDownloadEvent,
  megabytes,
  percent,
  shouldCheckAtLaunch,
  updateErrorMessage,
  type UpdateStatus,
} from "./updateState.ts";

const downloading: UpdateStatus = {
  kind: "downloading",
  version: "0.1.1",
  downloaded: 0,
  total: null,
};

test("a download reports its size, then progress, then that it is done", () => {
  let state = afterDownloadEvent(downloading, { event: "Started", data: { contentLength: 1000 } });
  assert.deepEqual(state, { ...downloading, total: 1000 });
  state = afterDownloadEvent(state, { event: "Progress", data: { chunkLength: 250 } });
  state = afterDownloadEvent(state, { event: "Progress", data: { chunkLength: 300 } });
  assert.equal(state.kind === "downloading" && state.downloaded, 550);
  assert.equal(percent(550, 1000), 55);
  state = afterDownloadEvent(state, { event: "Finished" });
  assert.equal(state.kind === "downloading" && state.downloaded, 1000);
});

test("a download of unknown size has no percentage, and events outside a download change nothing", () => {
  const started = afterDownloadEvent(downloading, { event: "Started", data: {} });
  assert.equal(started.kind === "downloading" && started.total, null);
  assert.equal(percent(500, null), null);
  assert.equal(percent(5, 0), null);
  assert.equal(percent(2000, 1000), 100);
  const idle: UpdateStatus = { kind: "idle" };
  assert.equal(afterDownloadEvent(idle, { event: "Progress", data: { chunkLength: 5 } }), idle);
  const ready: UpdateStatus = { kind: "ready", version: "0.1.1" };
  assert.equal(afterDownloadEvent(ready, { event: "Finished" }), ready);
});

test("sizes read in megabytes, and launch checks need both the wish and the installed app", () => {
  assert.equal(megabytes(3_355_443), "3.2");
  assert.equal(megabytes(0), "0.0");
  assert.equal(shouldCheckAtLaunch(true, true), true);
  assert.equal(shouldCheckAtLaunch(false, true), false);
  assert.equal(shouldCheckAtLaunch(true, false), false);
});

test("errors become one sentence", () => {
  assert.equal(
    updateErrorMessage(new Error("could not fetch a valid release JSON")),
    "could not fetch a valid release JSON",
  );
  assert.equal(updateErrorMessage("network down"), "network down");
  assert.equal(updateErrorMessage(undefined), "The update could not be checked.");
  assert.match(
    updateErrorMessage(new TypeError("Cannot read properties of undefined (reading 'invoke')")),
    /installed app/,
  );
});
