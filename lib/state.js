"use strict";

const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

const LOCK_STALE_MS = 10 * 60 * 1000;

class SyncAlreadyRunningError extends Error {
  constructor(message = "A Cribble sync is already running.") {
    super(message);
    this.name = "SyncAlreadyRunningError";
  }
}

function configDirectory(homeDirectory = homedir()) {
  return join(homeDirectory, ".config", "cribble");
}

function syncStatePath(homeDirectory = homedir()) {
  return join(configDirectory(homeDirectory), "sync-state.json");
}

function syncLockPath(homeDirectory = homedir()) {
  return join(configDirectory(homeDirectory), "sync.lock");
}

function ensurePrivateDirectory(filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readSyncState(filePath = syncStatePath()) {
  if (!existsSync(filePath)) return null;
  try {
    const state = readJson(filePath);
    if (!state || state.schemaVersion !== 1) throw new Error("unsupported schema");
    return state;
  } catch (error) {
    throw new Error(`Could not read Cribble sync status at ${filePath}: ${error.message}`);
  }
}

function writeSyncState(state, filePath = syncStatePath()) {
  ensurePrivateDirectory(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ ...state, schemaVersion: 1 }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function mergeSyncState(patch, filePath = syncStatePath()) {
  const previous = readSyncState(filePath) ?? {};
  const next = { ...previous, ...patch, schemaVersion: 1 };
  writeSyncState(next, filePath);
  return next;
}

function lockRecord(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function releaseOwnedLock(filePath, lockId) {
  if (!existsSync(filePath)) return;
  const current = lockRecord(filePath);
  if (current?.lockId === lockId) unlinkSync(filePath);
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves a process exists; ESRCH proves it does not.
    return error?.code === "EPERM";
  }
}

async function withSyncLock(
  task,
  {
    filePath = syncLockPath(),
    now = () => new Date(),
    staleMs = LOCK_STALE_MS,
  } = {},
) {
  ensurePrivateDirectory(filePath);
  const lockId = randomUUID();
  let acquired = false;

  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    const startedAt = now().toISOString();
    try {
      writeFileSync(
        filePath,
        `${JSON.stringify({ lockId, pid: process.pid, startedAt })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const existing = lockRecord(filePath);
      const startedTime = Date.parse(existing?.startedAt ?? "");
      const age = now().getTime() - startedTime;
      const ownerRunning = processIsRunning(Number(existing?.pid));
      const stale = !ownerRunning && (!Number.isFinite(startedTime) || age > staleMs);
      if (!stale || attempt === 1) throw new SyncAlreadyRunningError();
      unlinkSync(filePath);
    }
  }

  if (!acquired) throw new SyncAlreadyRunningError();

  try {
    return await task();
  } finally {
    releaseOwnedLock(filePath, lockId);
  }
}

module.exports = {
  SyncAlreadyRunningError,
  configDirectory,
  mergeSyncState,
  readSyncState,
  syncLockPath,
  syncStatePath,
  withSyncLock,
  writeSyncState,
};
