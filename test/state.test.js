"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  SyncAlreadyRunningError,
  mergeSyncState,
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
        lastError: `server echoed crib_ag_${"a".repeat(64)}\u001b[31m`,
        ignoredApiKey: `crib_ag_${"b".repeat(64)}`,
      },
      filePath,
    );
    const state = readSyncState(filePath);

    assert.equal(state.schemaVersion, 1);
    assert.equal(state.status, "success");
    assert.doesNotMatch(readFileSync(filePath, "utf8"), /crib_ag_/);
    assert.doesNotMatch(state.lastError, /\u001b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt status file cannot brick the next sync state update", () => {
  const root = temporaryRoot();
  const filePath = join(root, "sync-state.json");
  try {
    writeFileSync(filePath, "not json");
    mergeSyncState({ status: "running", lastError: null }, filePath);

    assert.equal(readSyncState(filePath).status, "running");
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

test("withSyncLock never evicts an old lock while its owner is alive", async () => {
  const root = temporaryRoot();
  const filePath = join(root, "sync.lock");
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        lockId: "reused-pid",
        pid: process.pid,
        startedAt: "2026-08-21T00:00:00.000Z",
      }),
    );
    let ran = false;
    await assert.rejects(
      withSyncLock(
        async () => {
          ran = true;
        },
        {
          filePath,
          now: () => new Date("2026-08-22T00:00:00.000Z"),
          processIsRunningFn: () => true,
        },
      ),
      SyncAlreadyRunningError,
    );
    assert.equal(ran, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
