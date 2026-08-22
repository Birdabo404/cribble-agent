"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadUsage, resolveBundledBinary } = require("../lib/source");

test("loadUsage never downloads an unpinned collector at runtime", () => {
  let executed = false;
  assert.throws(
    () =>
      loadUsage(
        {},
        {
          baseDirectory: "/missing/cribble-agent",
          existsSyncFn: () => false,
          requireResolveFn: () => {
            throw new Error("missing");
          },
          execFileSyncFn: () => {
            executed = true;
          },
        },
      ),
    /Run `npm install`/,
  );
  assert.equal(executed, false);
});

test("resolveBundledBinary supports npm-hoisted dependencies", () => {
  const binary = resolveBundledBinary("/app/node_modules/cribble-agent", {
    existsSyncFn: (filePath) => filePath === "/app/node_modules/ccusage/src/cli.js",
    readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
    requireResolveFn: () => "/app/node_modules/ccusage/package.json",
  });

  assert.equal(binary, "/app/node_modules/ccusage/src/cli.js");
});

test("loadUsage invokes the configured collector without a shell", () => {
  let invocation;
  const result = loadUsage(
    { CCUSAGE_BIN: "/opt/tools/ccusage" },
    {
      execFileSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return '{"daily":[]}';
      },
    },
  );

  assert.deepEqual(result, { daily: [] });
  assert.equal(invocation.command, "/opt/tools/ccusage");
  assert.deepEqual(invocation.args, ["daily", "--json"]);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
});

test("loadUsage invokes the bundled collector through an absolute Node path", () => {
  let invocation;
  const result = loadUsage(
    {},
    {
      baseDirectory: "/app/cribble-agent",
      existsSyncFn: (filePath) => filePath === "/app/cribble-agent/node_modules/.bin/ccusage",
      nodePath: "/absolute/node",
      execFileSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return '{"daily":[]}';
      },
    },
  );

  assert.deepEqual(result, { daily: [] });
  assert.equal(invocation.command, "/absolute/node");
  assert.deepEqual(invocation.args, [
    "/app/cribble-agent/node_modules/.bin/ccusage",
    "daily",
    "--json",
  ]);
});

test("loadUsage sanitizes collector failures before printing them", () => {
  const secret = `crib_ag_${"e".repeat(64)}`;
  assert.throws(
    () =>
      loadUsage(
        { CCUSAGE_BIN: "/opt/tools/ccusage" },
        {
          execFileSyncFn: () => {
            const error = new Error("failed");
            error.stderr = `oops\u001b[31m ${secret}`;
            throw error;
          },
        },
      ),
    (error) =>
      error.message.includes("[REDACTED]") &&
      !error.message.includes(secret) &&
      !error.message.includes("\u001b"),
  );
});
