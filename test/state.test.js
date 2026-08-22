"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  SyncAlreadyRunningError,
  readSyncState,
  withSyncLock,
  writeSyncState,
} = require("../lib/state");

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "cribble-agent-state-"));
}

test("sync state is written atomically without secrets", () => {
  const root = temporaryRoot();
  const filePath = join(root, "config", "sync-state.json");
  try {
    writeSyncState(
      {
        status: "success",
        lastSuccessAt: "2026-08-22T00:00:00.000Z",
        lastResult: { inserted: 1, replaced: 0, stale: 0 },
      },
      filePath,
    );
    const state = readSyncState(filePath);

    assert.equal(state.schemaVersion, 1);
    assert.equal(state.status, "success");
    assert.doesNotMatch(readFileSync(filePath, "utf8"), /crib_ag_/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withSyncLock rejects overlap and releases the owned lock", async () => {
  const root = temporaryRoot();
  const filePath = join(root, "sync.lock");
  let release;
  try {
    const first = withSyncLock(
      () => new Promise((resolve) => {
        release = resolve;
      }),
      { filePath },
    );

    await assert.rejects(
      withSyncLock(async () => {}, { filePath }),
      SyncAlreadyRunningError,
    );
    release("done");
    assert.equal(await first, "done");
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withSyncLock recovers an old orphaned lock", async () => {
  const root = temporaryRoot();
  const filePath = join(root, "sync.lock");
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        lockId: "orphan",
        pid: 999_999,
        startedAt: "2026-08-21T00:00:00.000Z",
      }),
    );
    const result = await withSyncLock(async () => "recovered", {
      filePath,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });

    assert.equal(result, "recovered");
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
