"use strict";

const { randomUUID } = require("node:crypto");
const {
  chmodSync,
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
const { safeText } = require("./safety");

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
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
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
  const safeState = {
    schemaVersion: 1,
    ...(state.status == null
      ? {}
      : { status: safeText(state.status, { maxLength: 32 }) }),
    ...Object.fromEntries(
      ["lastAttemptAt", "lastSuccessAt", "lastFailureAt", "clientId", "endpoint"]
        .filter((field) => state[field] != null)
        .map((field) => [field, safeText(state[field], { maxLength: 2048 })]),
    ),
    ...Object.fromEntries(
      ["syncedDays", "httpStatus"]
        .filter((field) => Number.isInteger(state[field]))
        .map((field) => [field, state[field]]),
    ),
    ...(state.lastResult && typeof state.lastResult === "object"
      ? {
          lastResult: Object.fromEntries(
            ["inserted", "replaced", "stale"]
              .filter(
                (field) =>
                  Number.isInteger(state.lastResult[field]) && state.lastResult[field] >= 0,
              )
              .map((field) => [field, state.lastResult[field]]),
          ),
        }
      : {}),
    ...(state.lastError === null
      ? { lastError: null }
      : state.lastError == null
        ? {}
        : { lastError: safeText(state.lastError, { maxLength: 300 }) }),
  };
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(safeState, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function mergeSyncState(patch, filePath = syncStatePath()) {
  let previous = {};
  try {
    previous = readSyncState(filePath) ?? {};
  } catch {
    // Status is operational metadata, not authoritative usage. A partial or
    // manually damaged file must not permanently brick future sync attempts.
  }
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
    processIsRunningFn = processIsRunning,
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
      const ownerRunning = processIsRunningFn(Number(existing?.pid));
      const stale =
        !Number.isFinite(startedTime) || !ownerRunning || age > staleMs || age < -60_000;
      if (!stale || attempt === 1) throw new SyncAlreadyRunningError();
      const current = lockRecord(filePath);
      if (current?.lockId !== existing?.lockId) throw new SyncAlreadyRunningError();
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
