"use strict";

// SQLite access is adapted from TokenTracker's MIT-licensed sqlite-reader.
// Cribble uses it only to extract Cursor's local session token for Cursor's
// own usage API. Query results are never logged.

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { safeText } = require("./safety");

function errorText(error) {
  return safeText(error?.message, { fallback: "sqlite error", maxLength: 160 });
}

function isSqliteCliUnavailable(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    error?.code === "ENOENT" ||
    message.includes("spawn sqlite3 enoent") ||
    message.includes("not recognized as an internal or external command")
  );
}

function isReadonlyUnsupported(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("unknown option") && message.includes("readonly");
}

function readSqliteRowsWithCli(dbPath, sql, { execFileSyncFn, timeout, maxBuffer }) {
  // Never inherit the full parent environment (it can hold CRIBBLE_API_KEY).
  const spawnEnv = {
    PATH: typeof process.env.PATH === "string" ? process.env.PATH : "",
  };
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot === "string" && systemRoot) spawnEnv.SystemRoot = systemRoot;
  const run = (args) => {
    const raw = execFileSyncFn("sqlite3", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
    });
    if (!raw || !String(raw).trim()) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  };
  try {
    return run(["-readonly", "-json", dbPath, sql]);
  } catch (error) {
    if (isSqliteCliUnavailable(error) || !isReadonlyUnsupported(error)) throw error;
    return run(["-json", dbPath, sql]);
  }
}

function readSqliteRowsWithNode(dbPath, sql, { requireFn = require }) {
  // node:sqlite is optional and experimental before Node 22. Load it only
  // after the sqlite3 CLI fails so ordinary collection does not import it.
  const { DatabaseSync } = requireFn("node:sqlite");
  if (typeof DatabaseSync !== "function") {
    throw new Error("node:sqlite DatabaseSync is unavailable");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(sql).all();
    return Array.isArray(rows) ? rows : [];
  } finally {
    db.close();
  }
}

function readSqliteJsonRows(dbPath, sql, options = {}) {
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  if (!dbPath || !sql || !existsSyncFn(dbPath)) return [];
  const execFileSyncFn = options.execFileSyncFn ?? execFileSync;
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 5_000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 1024 * 1024;
  const label = options.label ?? "local";

  let cliError;
  try {
    return readSqliteRowsWithCli(dbPath, sql, { execFileSyncFn, timeout, maxBuffer });
  } catch (error) {
    cliError = error;
  }

  let nodeError;
  try {
    return readSqliteRowsWithNode(dbPath, sql, {
      requireFn: options.requireFn,
    });
  } catch (error) {
    nodeError = error;
  }

  if (options.throwOnReadFailure) {
    throw new Error(
      `Could not read the ${label} SQLite database. Install the sqlite3 CLI or use Node.js 22+: ${errorText(cliError)}; ${errorText(nodeError)}`,
    );
  }
  return [];
}

function readSqliteFirstValue(dbPath, sql, column, options = {}) {
  const rows = readSqliteJsonRows(dbPath, sql, options);
  const row = rows[0];
  if (!row || typeof row !== "object") return null;
  const key = column || Object.keys(row)[0];
  const value = row[key];
  if (typeof value === "string") return value.trim();
  return value == null ? null : String(value).trim();
}

module.exports = {
  readSqliteFirstValue,
  readSqliteJsonRows,
};
