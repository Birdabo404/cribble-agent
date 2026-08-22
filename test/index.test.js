"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  DEFAULT_SYNC_ENDPOINT,
  buildSnapshot,
  buildWirePayload,
  getOrCreateClientId,
  main,
  parseArgs,
  parseEndpoint,
  postSnapshot,
  renderSnapshot,
} = require("../index");

const NOW = new Date("2026-08-22T00:00:00.000Z");
const CLIENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY = `crib_ag_${"a".repeat(64)}`;

test("buildSnapshot filters current ccusage output to the latest requested days", () => {
  const raw = {
    daily: [
      {
        period: "2026-08-20",
        agent: "all",
        metadata: { agents: ["claude", "codex"] },
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        totalTokens: 180,
        totalCost: 0.25,
        modelsUsed: ["model-a"],
        modelBreakdowns: [{ noisy: "raw data is intentionally dropped" }],
      },
      {
        period: "2026-08-22",
        agent: "codex",
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 50,
        totalTokens: 450,
        totalCost: 0.75,
        modelsUsed: ["model-b"],
      },
      {
        period: "2026-08-21",
        agent: "claude",
        inputTokens: 200,
        outputTokens: 80,
        totalTokens: 280,
        totalCost: 0.5,
        modelsUsed: ["model-a"],
      },
    ],
  };

  const snapshot = buildSnapshot(raw, { days: 2, now: NOW });

  assert.deepEqual(snapshot.range, {
    startDate: "2026-08-21",
    endDate: "2026-08-22",
    dayCount: 2,
  });
  assert.equal(snapshot.totals.totalTokens, 730);
  assert.equal(snapshot.totals.costUsd, 1.25);
  assert.deepEqual(snapshot.agents, ["claude", "codex"]);
  assert.deepEqual(snapshot.models, ["model-a", "model-b"]);
  assert.equal(snapshot.daily[0].modelBreakdowns, undefined);
});

test("buildSnapshot supports the legacy type/data/summary shape", () => {
  const snapshot = buildSnapshot(
    {
      type: "daily",
      data: [
        {
          date: "2026-08-22",
          models: ["claude-sonnet"],
          inputTokens: 11,
          outputTokens: 12,
          cacheCreationTokens: 13,
          cacheReadTokens: 14,
          costUSD: 0.1234,
        },
      ],
      summary: { totalTokens: 999999 },
    },
    { now: NOW },
  );

  assert.equal(snapshot.daily[0].totalTokens, 50);
  assert.equal(snapshot.totals.totalTokens, 50);
  assert.equal(snapshot.totals.cacheTokens, 27);
});

test("buildWirePayload adds client identity, timezone, and provenance", () => {
  const snapshot = buildSnapshot(
    {
      daily: [
        {
          date: "2026-08-22",
          agent: "codex",
          modelsUsed: ["gpt-5"],
          inputTokens: 11,
          outputTokens: 12,
          cacheCreationTokens: 13,
          cacheReadTokens: 14,
          totalTokens: 999,
          totalCost: 0.25,
        },
      ],
    },
    { now: NOW },
  );

  const payload = buildWirePayload(snapshot, {
    clientId: CLIENT_ID,
    timezone: "Asia/Manila",
    cliVersion: "1.0.0-test",
  });

  assert.deepEqual(payload, {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    clientId: CLIENT_ID,
    timezone: "Asia/Manila",
    provenance: { source: "ccusage", cliVersion: "1.0.0-test" },
    daily: [
      {
        date: "2026-08-22",
        agents: ["codex"],
        models: ["gpt-5"],
        inputTokens: 11,
        outputTokens: 12,
        cacheCreationTokens: 13,
        cacheReadTokens: 14,
        totalTokens: 50,
        costUsd: 0.25,
      },
    ],
  });
});

test("buildWirePayload drops rows whose date cannot be ingested", () => {
  const snapshot = buildSnapshot(
    {
      daily: [
        { date: "unknown", inputTokens: 999 },
        { date: "0000-01-01", inputTokens: 999 },
        { date: "2026-02-30", inputTokens: 999 },
        { date: "2026-08-22", inputTokens: 1 },
      ],
    },
    { now: NOW },
  );

  const payload = buildWirePayload(snapshot, {
    clientId: CLIENT_ID,
    timezone: "Asia/Manila",
  });

  assert.deepEqual(payload.daily.map((row) => row.date), ["2026-08-22"]);
});

test("duplicate source dates are merged before display and ingestion", () => {
  const snapshot = buildSnapshot(
    {
      daily: [
        {
          date: "2026-08-22",
          agent: "codex",
          modelsUsed: ["gpt-5"],
          inputTokens: 10,
          outputTokens: 2,
          totalCost: 0.1,
        },
        {
          date: "2026-08-22",
          agent: "claude",
          modelsUsed: ["sonnet"],
          inputTokens: 20,
          cacheReadTokens: 3,
          totalCost: 0.2,
        },
      ],
    },
    { now: NOW },
  );
  const payload = buildWirePayload(snapshot, {
    clientId: CLIENT_ID,
    timezone: "Asia/Manila",
  });

  assert.equal(snapshot.daily.length, 1);
  assert.equal(snapshot.daily[0].totalTokens, 35);
  assert.equal(snapshot.daily[0].costUsd, 0.3);
  assert.deepEqual(snapshot.daily[0].agents, ["codex", "claude"]);
  assert.equal(payload.daily.length, 1);
  assert.equal(payload.daily[0].totalTokens, 35);
});

test("source labels cannot inject terminal control or bidi characters", () => {
  const snapshot = buildSnapshot(
    {
      daily: [
        {
          date: "2026-08-22",
          agent: "codex\u001b[31m\u202e",
          modelsUsed: ["gpt\u0000-5"],
          inputTokens: 1,
        },
      ],
    },
    { now: NOW },
  );
  const rendered = renderSnapshot(snapshot, { color: false });

  assert.doesNotMatch(rendered, /[\u0000\u001b\u202e]/);
  assert.doesNotMatch(snapshot.agents[0], /[\u001b\u202e]/);
});

test("sync applies its day window after dropping invalid source dates", async () => {
  const output = [];
  await main(["sync", "--dry-run", "--days", "2"], {}, {
    getClientIdFn: () => CLIENT_ID,
    loadUsageFn: () => ({
      daily: [
        { date: "2026-08-20", inputTokens: 1 },
        { date: "2026-08-21", inputTokens: 2 },
        { date: "2026-08-22", inputTokens: 3 },
        { date: "unknown", inputTokens: 999 },
      ],
    }),
    log: (value) => output.push(value),
    timezoneFn: () => "Asia/Manila",
  });

  assert.deepEqual(
    JSON.parse(output[0]).daily.map((row) => row.date),
    ["2026-08-21", "2026-08-22"],
  );
});

test("getOrCreateClientId persists and reuses one UUID v4", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "cribble-agent-test-"));
  const filePath = join(temporaryRoot, "nested", "client-id");

  try {
    const first = getOrCreateClientId(filePath);
    const second = getOrCreateClientId(filePath);

    assert.match(
      first,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(second, first);
    assert.equal(readFileSync(filePath, "utf8").trim(), first);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("renderSnapshot produces a compact human-readable report", () => {
  const snapshot = buildSnapshot(
    {
      daily: [
        {
          date: "2026-08-22",
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          totalCost: 1.5,
          modelsUsed: ["gpt-5"],
        },
      ],
    },
    { now: NOW },
  );

  const rendered = renderSnapshot(snapshot, { color: false });

  assert.match(rendered, /Cribble · Token usage/);
  assert.match(rendered, /Total tokens\s+1,500/);
  assert.match(rendered, /Estimated cost\s+\$1\.50/);
  assert.match(rendered, /2026-08-22\s+1,200\s+300/);
  assert.doesNotMatch(rendered, /modelBreakdowns/);
});

test("parseArgs handles show and sync options", () => {
  assert.deepEqual(parseArgs([]), {
    command: "show",
    action: undefined,
    days: 7,
    intervalMinutes: 15,
    endpoint: undefined,
    dryRun: false,
    background: false,
    json: false,
    color: undefined,
  });
  assert.deepEqual(
    parseArgs([
      "sync",
      "--days=30",
      "--endpoint",
      "https://api.test/sync",
      "--dry-run",
    ]),
    {
      command: "sync",
      action: undefined,
      days: 30,
      intervalMinutes: 15,
      endpoint: "https://api.test/sync",
      dryRun: true,
      background: false,
      json: false,
      color: undefined,
    },
  );
  assert.throws(() => parseArgs(["--days", "0"]), /between 1 and 365/);
});

test("a sync dry run can inspect the payload before an endpoint is configured", () => {
  const options = parseArgs(["sync", "--dry-run"]);
  assert.equal(options.command, "sync");
  assert.equal(options.dryRun, true);
  assert.equal(options.endpoint, undefined);
});

test("sync dry-run works without a key or network access", async () => {
  const output = [];
  let networkCalled = false;

  await main(["sync", "--dry-run"], {}, {
    loadUsageFn: () => ({ daily: [{ date: "2026-08-22", inputTokens: 10 }] }),
    getClientIdFn: () => CLIENT_ID,
    timezoneFn: () => "Asia/Manila",
    fetchFn: async () => {
      networkCalled = true;
      throw new Error("offline");
    },
    log: (value) => output.push(value),
  });

  assert.equal(networkCalled, false);
  assert.equal(output.length, 1);
  const payload = JSON.parse(output[0]);
  assert.equal(payload.clientId, CLIENT_ID);
  assert.equal(payload.timezone, "Asia/Manila");
  assert.deepEqual(payload.provenance, { source: "ccusage", cliVersion: "1.1.0" });
});

test("parseEndpoint only allows valid HTTP endpoints", () => {
  assert.equal(parseEndpoint("https://cribble.test/api/usage").hostname, "cribble.test");
  assert.equal(parseEndpoint("http://127.0.0.1:3000/api/usage").port, "3000");
  assert.throws(() => parseEndpoint("http://cribble.test/api/usage"), /must use HTTPS/);
  assert.throws(
    () => parseEndpoint("https://user:password@cribble.test/api/usage"),
    /must not contain/,
  );
  assert.throws(
    () => parseEndpoint("https://cribble.test/api/usage?token=value"),
    /query parameters/,
  );
  assert.throws(() => parseEndpoint("file:///tmp/usage.json"), /http or https/);
  assert.throws(() => parseEndpoint(), /No sync endpoint/);
});

test("postSnapshot sends JSON and optional bearer authentication", async () => {
  let request;
  const snapshot = { schemaVersion: 1, clientId: CLIENT_ID, daily: [] };
  const fetchFn = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 201,
      text: async () =>
        `{"success":true,"inserted":0,"replaced":0,"stale":0,"clientId":"${CLIENT_ID}"}`,
    };
  };

  const result = await postSnapshot(snapshot, {
    endpoint: "https://cribble.test/api/usage",
    apiKey: API_KEY,
    fetchFn,
  });

  assert.equal(request.url.href, "https://cribble.test/api/usage");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(JSON.parse(request.options.body), snapshot);
  assert.deepEqual(result, {
    status: 201,
    endpoint: "https://cribble.test/api/usage",
    body: {
      success: true,
      inserted: 0,
      replaced: 0,
      stale: 0,
      clientId: CLIENT_ID,
    },
  });
});

test("postSnapshot reports useful HTTP failures", async () => {
  await assert.rejects(
    postSnapshot(
      {},
      {
        endpoint: "https://cribble.test/api/usage",
        apiKey: API_KEY,
        fetchFn: async () => ({
          ok: false,
          status: 422,
          text: async () => "invalid payload",
        }),
      },
    ),
    /HTTP 422: invalid payload/,
  );
});

test("postSnapshot redacts secrets and controls from server errors", async () => {
  let received;
  try {
    await postSnapshot(
      { schemaVersion: 1, clientId: CLIENT_ID, daily: [] },
      {
        endpoint: "https://cribble.test/api/usage",
        apiKey: API_KEY,
        fetchFn: async () => ({
          ok: false,
          status: 422,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({ error: `bad\u001b[31m token ${API_KEY}` }),
        }),
      },
    );
  } catch (error) {
    received = error;
  }

  assert.match(received.message, /\[REDACTED\]/);
  assert.doesNotMatch(received.message, new RegExp(API_KEY));
  assert.doesNotMatch(received.message, /\u001b/);
});

test("sync uses the Cribble endpoint by default and sends bearer auth", async () => {
  let request;

  await main(["sync"], { CRIBBLE_API_KEY: API_KEY }, {
    loadUsageFn: () => ({ daily: [{ date: "2026-08-22", outputTokens: 20 }] }),
    getClientIdFn: () => CLIENT_ID,
    timezoneFn: () => "Asia/Manila",
    mergeSyncStateFn: () => {},
    withSyncLockFn: (task) => task(),
    postSnapshotWithRetryFn: (payload, options) =>
      postSnapshot(payload, {
        ...options,
        fetchFn: async (url, requestOptions) => {
          request = { url, options: requestOptions };
          return {
            ok: true,
            status: 200,
            text: async () =>
              `{"success":true,"inserted":1,"replaced":0,"stale":0,"clientId":"${CLIENT_ID}"}`,
          };
        },
      }),
    log: () => {},
  });

  assert.equal(DEFAULT_SYNC_ENDPOINT, "https://cribble.dev/api/agent/usage");
  assert.equal(request.url.href, DEFAULT_SYNC_ENDPOINT);
  assert.equal(request.options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(JSON.parse(request.options.body).clientId, CLIENT_ID);
});
