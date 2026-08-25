"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dirname, join, resolve } = require("node:path");

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

test("resolveBundledBinary skips Windows cmd/sh shims and uses the JS bin", () => {
  const baseDirectory = join("/app", "cribble-agent");
  const shim = join(baseDirectory, "node_modules", ".bin", "ccusage");
  const packagePath = join("/app", "node_modules", "ccusage", "package.json");
  const cliPath = resolve(dirname(packagePath), "./src/cli.js");
  const binary = resolveBundledBinary(baseDirectory, {
    platform: "win32",
    existsSyncFn: (filePath) => filePath === shim || filePath === cliPath,
    readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
    requireResolveFn: () => packagePath,
  });

  assert.equal(binary, cliPath);
});

test("resolveBundledBinary supports npm-hoisted dependencies", () => {
  const packagePath = join("/app", "node_modules", "ccusage", "package.json");
  const cliPath = resolve(dirname(packagePath), "./src/cli.js");
  const binary = resolveBundledBinary(join("/app", "node_modules", "cribble-agent"), {
    existsSyncFn: (filePath) => filePath === cliPath,
    readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
    requireResolveFn: () => packagePath,
  });

  assert.equal(binary, cliPath);
});

test("loadUsage invokes the configured collector without a shell", () => {
  let invocation;
  const result = loadUsage(
    {
      CCUSAGE_BIN: "/opt/tools/ccusage",
      HOME: "/Users/test",
      CRIBBLE_API_KEY: `crib_ag_${"f".repeat(64)}`,
      OPENAI_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/evil.js",
    },
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
  assert.equal(invocation.options.env.HOME, "/Users/test");
  assert.equal(invocation.options.env.NO_COLOR, "1");
  assert.equal(invocation.options.env.CRIBBLE_API_KEY, undefined);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
});

test("loadUsage refuses a PATH-resolved CCUSAGE_BIN override", () => {
  assert.throws(
    () => loadUsage({ CCUSAGE_BIN: "ccusage" }, { execFileSyncFn: () => "{}" }),
    /absolute executable path/,
  );
});

test("loadUsage invokes the bundled collector through an absolute Node path", () => {
  let invocation;
  const baseDirectory = join("/app", "cribble-agent");
  const bundledBinary = join(baseDirectory, "node_modules", ".bin", "ccusage");
  const packagePath = join(baseDirectory, "node_modules", "ccusage", "package.json");
  const cliPath = resolve(dirname(packagePath), "./src/cli.js");
  const result = loadUsage(
    {},
    {
      baseDirectory,
      existsSyncFn: (filePath) => filePath === bundledBinary || filePath === cliPath,
      readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
      requireResolveFn: () => packagePath,
      nodePath: "/absolute/node",
      execFileSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return '{"daily":[]}';
      },
    },
  );

  assert.deepEqual(result, { daily: [] });
  assert.equal(invocation.command, "/absolute/node");
  assert.ok(
    invocation.args[0] === bundledBinary || invocation.args[0] === cliPath,
    invocation.args[0],
  );
  assert.deepEqual(invocation.args.slice(1), ["daily", "--json"]);
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
