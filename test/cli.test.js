"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { main: unguardedMain, parseArgs } = require("../index");
const { SyncAlreadyRunningError } = require("../lib/state");

const API_KEY = `crib_ag_${"c".repeat(64)}`;
const CLIENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const main = (argv, env, dependencies = {}) =>
  unguardedMain(argv, env, { platform: "darwin", ...dependencies });

test("parseArgs models the explicit background lifecycle", () => {
  assert.deepEqual(parseArgs(["connect"]), {
    command: "auth",
    action: "set",
    days: 7,
    intervalMinutes: 15,
    endpoint: undefined,
    dryRun: false,
    background: false,
    all: false,
    json: false,
    color: undefined,
    hermesHome: undefined,
    ccusageTimeoutMs: undefined,
  });
  assert.deepEqual(parseArgs(["start", "--interval=30", "--days", "14"]), {
    command: "background",
    action: "install",
    days: 14,
    intervalMinutes: 30,
    endpoint: undefined,
    dryRun: false,
    background: false,
    all: false,
    json: false,
    color: undefined,
    hermesHome: undefined,
    ccusageTimeoutMs: undefined,
  });
  assert.equal(parseArgs(["pause"]).action, "pause");
  assert.equal(parseArgs(["resume"]).action, "resume");
  assert.equal(parseArgs(["disconnect"]).action, "remove");
  assert.deepEqual(parseArgs(["background"]), {
    command: "background",
    action: "status",
    days: 7,
    intervalMinutes: 15,
    endpoint: undefined,
    dryRun: false,
    background: false,
    all: false,
    json: false,
    color: undefined,
    hermesHome: undefined,
    ccusageTimeoutMs: undefined,
  });
  assert.deepEqual(
    parseArgs(["background", "install", "--interval=30", "--days", "14"]),
    {
      command: "background",
      action: "install",
      days: 14,
      intervalMinutes: 30,
      endpoint: undefined,
      dryRun: false,
      background: false,
      all: false,
      json: false,
      color: undefined,
      hermesHome: undefined,
      ccusageTimeoutMs: undefined,
    },
  );
  assert.throws(() => parseArgs(["background", "start"]), /Unknown background action/);
  assert.throws(
    () => parseArgs(["background", "pause", "--days", "3"]),
    /--days can only be used/,
  );
  assert.throws(
    () => parseArgs(["background", "status", "--endpoint", "https://example.test"]),
    /--endpoint can only be used/,
  );
  assert.throws(() => parseArgs(["sync", "--endpoint="]), /needs a value/);
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.equal(parseArgs(["sync", "--no-color"]).color, false);
  assert.deepEqual(
    parseArgs([
      "sync",
      "--background",
      "--hermes-home",
      "/one,/two",
      "--ccusage-timeout-ms",
      "180000",
    ]),
    {
      command: "sync",
      action: undefined,
      days: 7,
      intervalMinutes: 15,
      endpoint: undefined,
      dryRun: false,
      background: true,
      all: false,
      json: false,
      color: undefined,
      hermesHome: "/one,/two",
      ccusageTimeoutMs: 180_000,
    },
  );
  assert.throws(
    () => parseArgs(["sync", "--hermes-home", "/one"]),
    /reserved for scheduled sync/,
  );
});

test("operational commands fail before sync on unknown platforms", async () => {
  let usageRead = false;
  let networkCalled = false;

  await assert.rejects(
    unguardedMain(["sync"], { CRIBBLE_API_KEY: API_KEY }, {
      platform: "freebsd",
      loadUsageFn: () => {
        usageRead = true;
        return { daily: [] };
      },
      postSnapshotWithRetryFn: async () => {
        networkCalled = true;
      },
    }),
    /supports macOS, Linux, and Windows/,
  );

  assert.equal(usageRead, false);
  assert.equal(networkCalled, false);
});

test("help and version describe cross-platform support", async () => {
  const output = [];
  const dependencies = { platform: "win32", log: (value) => output.push(value) };

  await unguardedMain(["help"], {}, dependencies);
  await unguardedMain(["version"], {}, dependencies);

  assert.match(output[0], /supports macOS, Linux, and Windows/);
  assert.match(output[1], /^Cribble Agent /);
});

test("custom endpoints never receive the Agent key from Keychain", async () => {
  let keyRead = false;
  await assert.rejects(
    main(["sync", "--endpoint", "https://example.test/collect"], {}, {
      resolveApiKeyFn: () => {
        keyRead = true;
        return API_KEY;
      },
    }),
    /never use the Agent key stored in secure storage/,
  );
  assert.equal(keyRead, false);
});

test("background sync refuses a custom endpoint that cannot receive an environment key", async () => {
  let installed = false;
  await assert.rejects(
    main(["start", "--endpoint", "https://example.test/collect"], {}, {
      installBackgroundFn: () => {
        installed = true;
      },
      keychainHasApiKeyFn: () => true,
      readKeychainApiKeyFn: () => API_KEY,
    }),
    /Custom endpoints cannot be saved/,
  );
  assert.equal(installed, false);
});

test("successful sync records durable attempt and result state", async () => {
  const states = [];
  const output = [];
  const times = [
    new Date("2026-08-22T00:00:00.000Z"),
    new Date("2026-08-22T00:00:01.000Z"),
    new Date("2026-08-22T00:00:02.000Z"),
  ];

  await main(["sync"], {}, {
    getClientIdFn: () => CLIENT_ID,
    loadUsageFn: () => ({
      daily: [{
        date: "2026-08-22",
        agent: "codex",
        modelsUsed: ["gpt-5"],
        inputTokens: 10,
      }],
    }),
    log: (value) => output.push(value),
    mergeSyncStateFn: (state) => states.push(state),
    nowFn: () => times.shift() ?? new Date("2026-08-22T00:00:03.000Z"),
    postSnapshotWithRetryFn: async () => ({
      status: 200,
      endpoint: "https://cribble.dev/api/agent/usage",
      body: {
        success: true,
        inserted: 1,
        replaced: 0,
        stale: 0,
        clientId: CLIENT_ID,
      },
    }),
    resolveApiKeyFn: () => API_KEY,
    timezoneFn: () => "Asia/Manila",
    withSyncLockFn: (task) => task(),
  });

  assert.equal(states.length, 2);
  assert.match(states[0].lastAttemptAt, /^2026-08-22T/);
  assert.equal(states[0].status, "running");
  assert.deepEqual(states[1].lastResult, { inserted: 1, replaced: 0, stale: 0 });
  assert.equal(states[1].status, "success");
  assert.match(output[0], /Synced 1 usage day/);
});

test("foreground sync runs the interactive progress lifecycle", async () => {
  const events = [];
  await main(["sync", "--no-color"], {}, {
    createActivityFn: ({ enabled, color }) => {
      events.push(["created", enabled, color]);
      return {
        start: (label) => events.push(["start", label]),
        update: (label) => events.push(["update", label]),
        stop: () => events.push(["stop"]),
      };
    },
    getClientIdFn: () => CLIENT_ID,
    loadUsageFn: () => ({
      daily: [{
        date: "2026-08-22",
        agent: "codex",
        modelsUsed: ["gpt-5"],
        inputTokens: 10,
      }],
    }),
    log: () => {},
    mergeSyncStateFn: () => {},
    output: { isTTY: true, write() {} },
    postSnapshotWithRetryFn: async () => ({
      status: 200,
      endpoint: "https://cribble.dev/api/agent/usage",
      body: {
        success: true,
        inserted: 1,
        replaced: 0,
        stale: 0,
        clientId: CLIENT_ID,
      },
    }),
    resolveApiKeyFn: () => API_KEY,
    timezoneFn: () => "Asia/Manila",
    withSyncLockFn: (task) => task(),
  });

  assert.deepEqual(events, [
    ["created", true, false],
    ["start", "Collecting local token usage"],
    ["update", "Sending usage to Cribble"],
    ["stop"],
  ]);
});

test("scheduled sync disables progress animation even with a TTY", async () => {
  let activityEnabled;
  await main(["sync", "--background"], {}, {
    createActivityFn: ({ enabled }) => {
      activityEnabled = enabled;
      return { start() {}, update() {}, stop() {} };
    },
    getClientIdFn: () => CLIENT_ID,
    loadUsageFn: () => ({
      daily: [{
        date: "2026-08-22",
        agent: "codex",
        modelsUsed: ["gpt-5"],
        inputTokens: 10,
      }],
    }),
    mergeSyncStateFn: () => {},
    output: { isTTY: true, write() {} },
    postSnapshotWithRetryFn: async () => ({
      status: 200,
      endpoint: "https://cribble.dev/api/agent/usage",
      body: {
        success: true,
        inserted: 1,
        replaced: 0,
        stale: 0,
        clientId: CLIENT_ID,
      },
    }),
    resolveApiKeyFn: () => API_KEY,
    timezoneFn: () => "Asia/Manila",
    withSyncLockFn: (task) => task(),
  });

  assert.equal(activityEnabled, false);
});

test("failed sync records an actionable error state", async () => {
  const states = [];
  await assert.rejects(
    main(["sync"], {}, {
      getClientIdFn: () => CLIENT_ID,
      loadUsageFn: () => ({
        daily: [{
          date: "2026-08-22",
          agent: "codex",
          modelsUsed: ["gpt-5"],
          inputTokens: 10,
        }],
      }),
      mergeSyncStateFn: (state) => states.push(state),
      postSnapshotWithRetryFn: async () => {
        throw new Error("network unavailable");
      },
      resolveApiKeyFn: () => API_KEY,
      timezoneFn: () => "Asia/Manila",
      withSyncLockFn: (task) => task(),
    }),
    /network unavailable/,
  );

  assert.equal(states.at(-1).status, "error");
  assert.equal(states.at(-1).lastError, "network unavailable");
});

test("background collection failures are recorded instead of disappearing", async () => {
  const states = [];
  await assert.rejects(
    main(["sync", "--background"], {}, {
      loadUsageFn: () => {
        throw new Error("ccusage log directory unavailable");
      },
      mergeSyncStateFn: (state) => states.push(state),
      resolveApiKeyFn: () => API_KEY,
      withSyncLockFn: (task) => task(),
    }),
    /ccusage log directory unavailable/,
  );

  assert.deepEqual(states.map((state) => state.status), ["running", "error"]);
  assert.equal(states.at(-1).lastError, "ccusage log directory unavailable");
});

test("an overlapping scheduled run exits quietly without touching usage or state", async () => {
  let usageRead = false;
  let stateWritten = false;
  await main(["sync", "--background"], {}, {
    loadUsageFn: () => {
      usageRead = true;
    },
    mergeSyncStateFn: () => {
      stateWritten = true;
    },
    withSyncLockFn: async () => {
      throw new SyncAlreadyRunningError();
    },
  });

  assert.equal(usageRead, false);
  assert.equal(stateWritten, false);
});

test("background install refuses to create a service before Keychain setup", async () => {
  let installCalled = false;
  await assert.rejects(
    main(["background", "install"], {}, {
      installBackgroundFn: () => {
        installCalled = true;
      },
      keychainHasApiKeyFn: () => false,
    }),
    /Run `cribble connect` first/,
  );
  assert.equal(installCalled, false);
});

test("background install validates the stored Keychain value before scheduling", async () => {
  let installCalled = false;
  await assert.rejects(
    main(["background", "install"], {}, {
      installBackgroundFn: () => {
        installCalled = true;
      },
      keychainHasApiKeyFn: () => true,
      readKeychainApiKeyFn: () => {
        throw new Error("The stored Agent key is invalid.");
      },
    }),
    /stored Agent key is invalid/,
  );
  assert.equal(installCalled, false);
});

test("background install captures explicit collector configuration", async () => {
  let installedOptions;
  await main(
    ["start"],
    {
      HERMES_HOME: "/home/alice/.hermes,/archive/hermes",
      CRIBBLE_CCUSAGE_TIMEOUT_MS: "180000",
    },
    {
      installBackgroundFn: (options) => {
        installedOptions = options;
        return options;
      },
      keychainHasApiKeyFn: () => true,
      readKeychainApiKeyFn: () => API_KEY,
      log: () => {},
    },
  );

  assert.equal(installedOptions.hermesHome, "/home/alice/.hermes,/archive/hermes");
  assert.equal(installedOptions.ccusageTimeoutMs, 180_000);
});

test("auth removal refuses to break an active background schedule", async () => {
  let removeCalled = false;
  await assert.rejects(
    main(["auth", "remove"], {}, {
      backgroundStatusFn: () => ({ installed: true, loaded: true, disabled: false }),
      removeKeychainApiKeyFn: () => {
        removeCalled = true;
      },
    }),
    /Pause or uninstall background sync/,
  );
  assert.equal(removeCalled, false);
});

test("auth setup removes a malformed value instead of leaving it in Keychain", async () => {
  let removed = false;
  await assert.rejects(
    main(["auth", "set"], {}, {
      promptAndStoreApiKeyFn: () => {},
      readKeychainApiKeyFn: () => {
        throw new Error("The stored Agent key is malformed.");
      },
      removeKeychainApiKeyFn: () => {
        removed = true;
        return true;
      },
    }),
    /stored Agent key is malformed/,
  );
  assert.equal(removed, true);
});

test("status reports credential, service, and last sync without reading usage", async () => {
  const output = [];
  let usageRead = false;
  await main(["status"], {}, {
    backgroundStatusFn: () => ({ installed: true, loaded: false, disabled: true }),
    keychainHasApiKeyFn: () => true,
    readKeychainApiKeyFn: () => API_KEY,
    loadUsageFn: () => {
      usageRead = true;
    },
    log: (value) => output.push(value),
    readSyncStateFn: () => ({
      schemaVersion: 1,
      lastAttemptAt: "2026-08-22T00:00:00.000Z",
      lastSuccessAt: "2026-08-22T00:00:01.000Z",
      lastResult: { inserted: 1, replaced: 2, stale: 3 },
    }),
  });

  assert.equal(usageRead, false);
  assert.match(output[0], /Agent key\s+macOS Keychain/);
  assert.match(output[0], /Background\s+paused/);
  assert.match(output[0], /1 inserted, 2 replaced, 3 unchanged/);
});

test("status explains invalid credentials and recovers from damaged local state", async () => {
  const output = [];
  await main(["status"], { CRIBBLE_API_KEY: "not-a-key" }, {
    backgroundStatusFn: () => ({ installed: false, loaded: false, disabled: false }),
    log: (value) => output.push(value),
    readSyncStateFn: () => {
      throw new Error("status JSON is damaged\u001b[31m");
    },
    resolveApiKeyFn: () => {
      throw new Error("invalid key");
    },
  });

  assert.match(output[0], /invalid environment override/);
  assert.match(output[0], /next sync attempt will repair it/);
  assert.doesNotMatch(output[0], /\u001b/);
});
