"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dirname, resolve } = require("node:path");

const {
  collectorEnvironment,
  collectionSince,
  loadUsage,
  resolveBundledBinary,
} = require("../lib/source");

const isolatedUsage = {
  loadSupplementalUsageFn: () => ({ daily: [] }),
  loadHermesProviderRoutesFn: () => [],
};

function fakeCcusageInstall() {
  const packagePath = resolve("/app/node_modules/ccusage/package.json");
  return {
    packagePath,
    binaryPath: resolve(dirname(packagePath), "src", "cli.js"),
  };
}

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
  const { packagePath, binaryPath } = fakeCcusageInstall();
  const binary = resolveBundledBinary(resolve("/app/node_modules/cribble-agent"), {
    existsSyncFn: (filePath) => filePath === binaryPath,
    readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
    requireResolveFn: () => packagePath,
  });

  assert.equal(binary, binaryPath);
});

test("loadUsage invokes the configured collector without a shell", () => {
  let invocation;
  const result = loadUsage(
    {
      CCUSAGE_BIN: "/opt/tools/ccusage",
      HOME: "/Users/test",
      HERMES_HOME: "/Users/test/.hermes,/Volumes/archive/hermes",
      TZ: "UTC",
      CRIBBLE_API_KEY: `crib_ag_${"f".repeat(64)}`,
      OPENAI_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/evil.js",
    },
    {
      execFileSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return '{"daily":[]}';
      },
      ...isolatedUsage,
    },
  );

  assert.deepEqual(result, { daily: [], timezone: "UTC" });
  assert.equal(invocation.command, "/opt/tools/ccusage");
  assert.deepEqual(invocation.args, [
    "daily",
    "--json",
    "--by-agent",
    "--timezone",
    "UTC",
  ]);
  assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(invocation.options.env.HOME, "/Users/test");
  assert.equal(
    invocation.options.env.HERMES_HOME,
    "/Users/test/.hermes,/Volumes/archive/hermes",
  );
  assert.equal(invocation.options.env.NO_COLOR, "1");
  assert.equal(invocation.options.env.CRIBBLE_API_KEY, undefined);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
});

test("collector environment keeps explicit Hermes roots and drops empty values", () => {
  assert.deepEqual(
    collectorEnvironment({
      HERMES_HOME: "   ",
      OPENAI_API_KEY: "must-not-leak",
    }),
    { NO_COLOR: "1" },
  );
  assert.equal(
    collectorEnvironment({ HERMES_HOME: "/one,/two" }).HERMES_HOME,
    "/one,/two",
  );
});

test("loadUsage constrains ccusage to the requested timezone date window", () => {
  let invocation;
  loadUsage(
    { CCUSAGE_BIN: "/opt/tools/ccusage" },
    {
      days: 7,
      now: new Date("2026-08-25T16:30:00.000Z"),
      timezone: "Asia/Manila",
      execFileSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return '{"daily":[]}';
      },
      ...isolatedUsage,
    },
  );

  assert.deepEqual(invocation.args, [
    "daily",
    "--json",
    "--by-agent",
    "--since",
    "2026-08-20",
    "--timezone",
    "Asia/Manila",
  ]);
  assert.equal(invocation.options.timeout, 120_000);
  assert.equal(
    collectionSince({
      days: 1,
      now: new Date("2026-08-25T16:30:00.000Z"),
      timezone: "Asia/Manila",
    }),
    "2026-08-26",
  );
});

test("ccusage timeout is configurable, bounded, and reported clearly", () => {
  let configuredTimeout;
  loadUsage(
    {
      CCUSAGE_BIN: "/opt/tools/ccusage",
      CRIBBLE_CCUSAGE_TIMEOUT_MS: "70000",
    },
    {
      execFileSyncFn: (_command, _args, options) => {
        configuredTimeout = options.timeout;
        return '{"daily":[]}';
      },
      ...isolatedUsage,
    },
  );
  assert.equal(configuredTimeout, 70_000);

  assert.throws(
    () =>
      loadUsage(
        {
          CCUSAGE_BIN: "/opt/tools/ccusage",
          CRIBBLE_CCUSAGE_TIMEOUT_MS: "120000",
        },
        {
          execFileSyncFn: () => {
            const error = new Error("spawnSync timed out");
            error.code = "ETIMEDOUT";
            throw error;
          },
        },
      ),
    /ccusage collection timed out after 120000 ms.*CRIBBLE_CCUSAGE_TIMEOUT_MS/,
  );
  assert.throws(
    () =>
      loadUsage(
        {
          CCUSAGE_BIN: "/opt/tools/ccusage",
          CRIBBLE_CCUSAGE_TIMEOUT_MS: "999",
        },
        { execFileSyncFn: () => '{"daily":[]}' },
      ),
    /between 1000 and 900000/,
  );
});

test("loadUsage refuses a PATH-resolved CCUSAGE_BIN override", () => {
  assert.throws(
    () => loadUsage({ CCUSAGE_BIN: "ccusage" }, { execFileSyncFn: () => "{}" }),
    /absolute executable path/,
  );
});

test("loadUsage invokes the bundled collector through an absolute Node path", () => {
  let invocation;
  const { packagePath, binaryPath } = fakeCcusageInstall();
  const result = loadUsage(
    {},
    {
      timezone: "UTC",
      baseDirectory: resolve("/app/cribble-agent"),
      existsSyncFn: (filePath) => filePath === binaryPath,
      readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
      requireResolveFn: () => packagePath,
      nodePath: "/absolute/node",
      execFileSyncFn: (command, args, options) => {
        invocation = { command, args, options };
        return '{"daily":[]}';
      },
      ...isolatedUsage,
    },
  );

  assert.deepEqual(result, { daily: [], timezone: "UTC" });
  assert.equal(invocation.command, "/absolute/node");
  assert.deepEqual(invocation.args, [
    binaryPath,
    "daily",
    "--json",
    "--by-agent",
    "--timezone",
    "UTC",
  ]);
});

test("loadUsage never passes a Windows npm shell shim to node.exe", () => {
  let invocation;
  const { packagePath, binaryPath } = fakeCcusageInstall();
  const shellShimPath = resolve(dirname(packagePath), "..", ".bin", "ccusage");
  loadUsage(
    {},
    {
      platform: "win32",
      timezone: "UTC",
      baseDirectory: resolve("/app/node_modules/cribble-agent"),
      existsSyncFn: (filePath) =>
        filePath === shellShimPath || filePath === binaryPath,
      readFileSyncFn: () => JSON.stringify({ bin: { ccusage: "./src/cli.js" } }),
      requireResolveFn: () => packagePath,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      execFileSyncFn: (command, args) => {
        invocation = { command, args };
        return '{"daily":[]}';
      },
      loadSupplementalUsageFn: () => ({ daily: [] }),
    },
  );

  assert.equal(invocation.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(invocation.args, [
    binaryPath,
    "daily",
    "--json",
    "--by-agent",
    "--timezone",
    "UTC",
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

test("supplemental failures abort instead of replacing complete totals", () => {
  assert.throws(
    () =>
      loadUsage(
        { CCUSAGE_BIN: "/opt/ccusage" },
        {
          execFileSyncFn: () => '{"daily":[]}',
          loadSupplementalUsageFn: () => {
            throw new Error("Prime reader failed");
          },
        },
      ),
    /Could not read complete supplemental usage: Prime reader failed/,
  );
});

test("Windows collection falls back to native when WSL has no usage", () => {
  const invocations = [];
  const result = loadUsage(
    {
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      CCUSAGE_BIN: "/opt/ccusage",
      USERPROFILE: "C:\\Users\\alice",
    },
    {
      platform: "win32",
      usageHomesFn: () => [
        { scope: "native", home: "C:\\Users\\alice" },
        {
          scope: "wsl:Ubuntu",
          home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
        },
      ],
      loadSupplementalUsageFn: () => ({ daily: [] }),
      execFileSyncFn: (_command, _args, options) => {
        invocations.push(options.env);
        const isWsl = options.env.HOME?.startsWith("\\\\wsl");
        return JSON.stringify({
          daily: isWsl
            ? []
            : [{
                date: "2026-08-25",
                agent: "claude",
                inputTokens: 10,
              }],
        });
      },
    },
  );

  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].agent, "claude");
  assert.equal(invocations[0].APPDATA, undefined);
  assert.equal(invocations[0].HOME, "\\\\wsl.localhost\\Ubuntu\\home\\alice");
  assert.match(invocations[0].CODEX_HOME, /\\.codex$/);
  assert.equal(invocations[1].APPDATA, "C:\\Users\\alice\\AppData\\Roaming");
});

test("Windows collection skips WSL homes without Claude data", () => {
  const invocations = [];
  const result = loadUsage(
    {
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      CCUSAGE_BIN: "/opt/ccusage",
      USERPROFILE: "C:\\Users\\alice",
    },
    {
      platform: "win32",
      usageHomesFn: () => [
        {
          scope: "wsl:Ubuntu",
          home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
        },
        { scope: "native", home: "C:\\Users\\alice" },
      ],
      loadSupplementalUsageFn: () => ({ daily: [] }),
      execFileSyncFn: (_command, _args, options) => {
        invocations.push(options.env);
        if (options.env.HOME?.startsWith("\\\\wsl")) {
          const error = new Error("ccusage exited");
          error.stderr =
            'CliError("No valid Claude data directories found in CLAUDE_CONFIG_DIR.")';
          throw error;
        }
        return JSON.stringify({
          daily: [{
            date: "2026-08-25",
            agent: "claude",
            inputTokens: 10,
          }],
        });
      },
    },
  );

  assert.equal(result.daily.length, 1);
  assert.equal(result.scope, "native");
  assert.equal(invocations.length, 2);
});

test("Windows collection keeps native logs out when preferred WSL has usage", () => {
  const invocations = [];
  let persistedScope;
  const result = loadUsage(
    {
      CCUSAGE_BIN: "/opt/ccusage",
      USERPROFILE: "C:\\Users\\alice",
    },
    {
      platform: "win32",
      usageHomesFn: () => [
        {
          scope: "wsl:Ubuntu",
          home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
        },
        { scope: "native", home: "C:\\Users\\alice" },
      ],
      readSelectedScopeFn: () => null,
      writeSelectedScopeFn: (scope) => {
        persistedScope = scope;
      },
      loadSupplementalUsageFn: () => ({ daily: [] }),
      execFileSyncFn: (_command, _args, options) => {
        invocations.push(options.env);
        return JSON.stringify({
          daily: [{
            date: "2026-08-25",
            agent: "codex",
            inputTokens: 20,
          }],
        });
      },
    },
  );

  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].agent, "codex");
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].HOME, /^\\\\wsl/);
  assert.equal(persistedScope, "wsl:Ubuntu");
});

test("Windows collection keeps its persisted scope instead of switching totals", () => {
  const invocations = [];
  const result = loadUsage(
    {
      CCUSAGE_BIN: "/opt/ccusage",
      USERPROFILE: "C:\\Users\\alice",
    },
    {
      platform: "win32",
      usageHomesFn: () => [
        {
          scope: "wsl:Ubuntu",
          home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
        },
        { scope: "native", home: "C:\\Users\\alice" },
      ],
      readSelectedScopeFn: () => "wsl:Ubuntu",
      loadSupplementalUsageFn: () => ({ daily: [] }),
      execFileSyncFn: (_command, _args, options) => {
        invocations.push(options.env);
        return JSON.stringify({
          daily: options.env.HOME?.startsWith("\\\\wsl")
            ? []
            : [{ date: "2026-08-25", agent: "claude", inputTokens: 50 }],
        });
      },
    },
  );

  assert.deepEqual(result.daily, []);
  assert.equal(result.scope, "wsl:Ubuntu");
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].HOME, /^\\\\wsl/);
});

test("Windows collection does not double-count native and WSL aggregates", () => {
  assert.throws(
    () =>
      loadUsage(
        {
          CCUSAGE_BIN: "/opt/ccusage",
          CRIBBLE_WSL_MODE: "both",
          USERPROFILE: "C:\\Users\\alice",
        },
        {
          platform: "win32",
          usageHomesFn: () => [
            { scope: "native", home: "C:\\Users\\alice" },
            {
              scope: "wsl:Ubuntu",
              home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
            },
          ],
          execFileSyncFn: () => '{"daily":[]}',
        },
      ),
    /cannot be record-deduplicated safely/,
  );
});
