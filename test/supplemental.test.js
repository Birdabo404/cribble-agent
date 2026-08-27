"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { buildSnapshot } = require("../lib/usage");
const {
  loadSupplementalUsage,
  mergeUsageReports,
  parsePrimeSession,
} = require("../lib/supplemental");

const FIXTURE = join(__dirname, "fixtures", "prime-session.jsonl");

test("Prime Agent fixture retains usage metadata but not conversation content", () => {
  const rows = parsePrimeSession(FIXTURE);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].modelsUsed, ["claude-sonnet-4-6"]);
  assert.equal(rows[0].inputTokens, 120);
  assert.equal(rows[0].outputTokens, 35);
  assert.equal(rows[0].cacheReadTokens, 50);
  assert.equal(rows[0].cacheCreationTokens, 10);
  assert.equal(JSON.stringify(rows).includes("prompt"), false);
  assert.equal(JSON.stringify(rows).includes("response"), false);
});

test("Prime Agent reconciles total-only and included-reasoning records", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-prime-totals-"));
  const filePath = join(root, "session.jsonl");
  try {
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session", id: "totals-session" }),
        JSON.stringify({
          type: "message",
          id: "total-only",
          timestamp: "2026-08-25T12:00:00.000Z",
          message: {
            role: "assistant",
            model: "model-a",
            usage: {
              totalTokens: 42,
              cost: { total: 0.0042 },
            },
          },
        }),
        JSON.stringify({
          type: "message",
          id: "reasoning-included",
          timestamp: "2026-08-25T12:01:00.000Z",
          message: {
            role: "assistant",
            model: "model-b",
            usage: {
              input: 10,
              output: 20,
              reasoningTokens: 5,
              totalTokens: 30,
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const rows = parsePrimeSession(filePath, new Set(), { timezone: "UTC" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outputTokens, 42);
    assert.equal(rows[0].totalCost, 0.0042);
    assert.equal(rows[1].inputTokens, 10);
    assert.equal(rows[1].outputTokens, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prime Agent uses the same explicit timezone as ccusage", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-prime-timezone-"));
  const filePath = join(root, "session.jsonl");
  try {
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session", id: "timezone-session" }),
        JSON.stringify({
          type: "message",
          id: "midnight",
          timestamp: "2026-08-25T00:30:00.000Z",
          message: {
            role: "assistant",
            model: "model-a",
            usage: { totalTokens: 1 },
          },
        }),
        "",
      ].join("\n"),
    );

    assert.equal(
      parsePrimeSession(filePath, new Set(), { timezone: "UTC" })[0].date,
      "2026-08-25",
    );
    assert.equal(
      parsePrimeSession(filePath, new Set(), {
        timezone: "America/Los_Angeles",
      })[0].date,
      "2026-08-24",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prime Agent session headers deduplicate renamed native and WSL mirrors", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-prime-mirror-"));
  const renamed = join(root, "renamed-copy.jsonl");
  const seen = new Set();
  try {
    copyFileSync(FIXTURE, renamed);
    assert.equal(parsePrimeSession(FIXTURE, seen).length, 1);
    assert.equal(parsePrimeSession(renamed, seen).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux discovery adds Prime Agent on top of ccusage", () => {
  const home = mkdtempSync(join(tmpdir(), "cribble-prime-linux-"));
  const destination = join(
    home,
    ".prime",
    "agent",
    "sessions",
    "prime-session.jsonl",
  );
  try {
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    copyFileSync(FIXTURE, destination);

    const supplemental = loadSupplementalUsage(
      { HOME: home },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        loadCursorUsageFn: () => ({ daily: [] }),
      },
    );
    assert.equal(supplemental.daily.length, 1);
    const snapshot = buildSnapshot(supplemental, { days: 365 });
    assert.equal(snapshot.totals.totalTokens, 215);
    assert.deepEqual(snapshot.agents, ["prime-agent"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Prime Agent ledger preserves usage after session rotation", () => {
  const home = mkdtempSync(join(tmpdir(), "cribble-prime-ledger-"));
  const sessions = join(home, ".prime", "agent", "sessions");
  const sessionPath = join(sessions, "prime-session.jsonl");
  const options = {
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
    loadCursorUsageFn: () => ({ daily: [] }),
  };
  try {
    mkdirSync(sessions, { recursive: true });
    copyFileSync(FIXTURE, sessionPath);
    assert.equal(loadSupplementalUsage({ HOME: home }, options).daily.length, 1);

    rmSync(sessionPath);
    const afterRotation = loadSupplementalUsage({ HOME: home }, options);
    assert.equal(afterRotation.daily.length, 1);
    assert.equal(afterRotation.daily[0].inputTokens, 120);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ccusage wins for true overlaps while pi does not suppress Prime Agent", () => {
  const primary = [{
    daily: [{
      date: "2026-08-25",
      metadata: {
        agents: ["Claude Code", "Codex CLI", "Cursor Agent", "pi-agent"],
      },
      inputTokens: 10,
    }],
  }];
  const supplemental = {
    daily: [
      { date: "2026-08-25", provider: "claude", agent: "claude", inputTokens: 100 },
      { date: "2026-08-25", provider: "codex", agent: "codex", inputTokens: 100 },
      { date: "2026-08-25", provider: "cursor", agent: "cursor", inputTokens: 100 },
      {
        date: "2026-08-25",
        provider: "prime-agent",
        overlapProviders: ["prime-agent"],
        agent: "prime-agent",
        inputTokens: 100,
      },
      { date: "2026-08-25", provider: "qoder", agent: "qoder", inputTokens: 5 },
    ],
  };

  const merged = mergeUsageReports(primary, supplemental);
  assert.equal(merged.daily.length, 3);
  assert.equal(merged.daily[1].agent, "prime-agent");
  assert.equal(merged.daily[2].agent, "qoder");
  assert.deepEqual(merged.sources, ["ccusage", "prime-agent", "qoder"]);
});

test("Prime Agent byte limits fail instead of returning a partial total", () => {
  const home = mkdtempSync(join(tmpdir(), "cribble-prime-budget-"));
  const sessions = join(home, ".prime", "agent", "sessions");
  const oldPath = join(sessions, "a-old.jsonl");
  const recentPath = join(sessions, "z-recent.jsonl");
  const fixture = readFileSync(FIXTURE, "utf8");
  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(oldPath, fixture.replaceAll("prime-session-1", "old-session"));
    writeFileSync(
      recentPath,
      fixture
        .replaceAll("prime-session-1", "recent-session")
        .replaceAll("claude-sonnet-4-6", "recent-model"),
    );
    const statSyncFn = (filePath) => {
      if (filePath === oldPath) {
        return {
          isFile: () => true,
          size: 60 * 1024 * 1024,
          mtimeMs: 1,
        };
      }
      if (filePath === recentPath) {
        return {
          isFile: () => true,
          size: 60 * 1024 * 1024,
          mtimeMs: 2,
        };
      }
      return statSync(filePath);
    };

    assert.throws(
      () =>
        loadSupplementalUsage(
          { HOME: home },
          {
            platform: "linux",
            homes: [{ scope: "native", home }],
            statSyncFn,
            loadCursorUsageFn: () => ({ daily: [] }),
          },
        ),
      /refusing a partial usage report/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
