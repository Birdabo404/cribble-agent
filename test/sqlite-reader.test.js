"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { readSqliteFirstValue, readSqliteJsonRows } = require("../lib/sqlite-reader");

test("SQLite reader uses the CLI JSON output when sqlite3 is available", () => {
  const value = readSqliteFirstValue(
    "/tmp/state.vscdb",
    "SELECT value FROM ItemTable",
    "value",
    {
      existsSyncFn: () => true,
      execFileSyncFn: () => '[{"value":"session-token"}]\n',
    },
  );
  assert.equal(value, "session-token");
});

test("SQLite reader falls back to node:sqlite and fails closed when both miss", () => {
  const rows = readSqliteJsonRows("/tmp/state.vscdb", "SELECT 1", {
    existsSyncFn: () => true,
    execFileSyncFn: () => {
      const error = new Error("spawn sqlite3 ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    requireFn: () => {
      throw new Error("Cannot find module 'node:sqlite'");
    },
  });
  assert.deepEqual(rows, []);

  assert.throws(
    () =>
      readSqliteJsonRows("/tmp/state.vscdb", "SELECT 1", {
        existsSyncFn: () => true,
        throwOnReadFailure: true,
        label: "Cursor",
        execFileSyncFn: () => {
          const error = new Error("spawn sqlite3 ENOENT");
          error.code = "ENOENT";
          throw error;
        },
        requireFn: () => {
          throw new Error("Cannot find module 'node:sqlite'");
        },
      }),
    /Install the sqlite3 CLI or use Node.js 22/,
  );
});
