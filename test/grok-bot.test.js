"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const TEMP_ROOT = join(__dirname, "tmp-grok-bot-homes");

const { resolveCursorPaths } = require("../lib/cursor");
const {
  isGrokBotCollectionDisabled,
  loadGrokBotUsage,
} = require("../lib/grok-bot");
const { loadCursorUsage } = require("../lib/cursor");

const CSV_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "cursor-usage.csv"),
  "utf8",
);

function tempHome(prefix) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  return mkdtempSync(join(TEMP_ROOT, prefix));
}

function jwtFor(sub) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function seedCursorInstall(home, { platform } = {}) {
  const cliConfigPath = join(home, "cursor-cli-config.json");
  const paths = resolveCursorPaths({
    home,
    platform,
    scope: "native",
    env: {},
    cliConfigPath,
  });
  mkdirSync(join(paths.appDir, "User", "globalStorage"), { recursive: true });
  writeFileSync(paths.stateDbPath, "sqlite-placeholder");
  writeFileSync(
    cliConfigPath,
    JSON.stringify({
      authInfo: { authId: "auth0|user_test123" },
    }),
  );
  return {
    ...paths,
    jwt: jwtFor("auth0|user_test123"),
  };
}

test("CRIBBLE_GROK_BOT disable flag mirrors Cursor", () => {
  assert.equal(isGrokBotCollectionDisabled({ CRIBBLE_GROK_BOT: "0" }), true);
  assert.equal(isGrokBotCollectionDisabled({ CRIBBLE_GROK_BOT: "false" }), true);
  assert.equal(isGrokBotCollectionDisabled({ CRIBBLE_GROK_BOT: "off" }), true);
  assert.equal(isGrokBotCollectionDisabled({}), false);
});

test("Grok Bot load attributes grok-bot-* models with Free cost as zero", () => {
  const home = tempHome("bot-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  try {
    const result = loadGrokBotUsage(
      { HOME: home },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        timezone: "UTC",
        nowFn: () => new Date("2026-08-27T00:00:00.000Z"),
        cliConfigPath: seeded.cliConfigPath,
        readSqliteFirstValueFn: () => seeded.jwt,
        fetchCursorCsvFn: () => CSV_FIXTURE,
      },
    );
    assert.equal(result.daily.length, 3);
    assert.ok(result.daily.every((row) => row.provider === "grok-bot"));
    assert.ok(result.daily.every((row) => row.agent === "grok-bot"));
    assert.ok(
      result.daily.every((row) =>
        Array.isArray(row.overlapProviders) &&
        row.overlapProviders.length === 1 &&
        row.overlapProviders[0] === "grok-bot",
      ),
    );
    assert.ok(result.daily.every((row) => row.totalCost === 0));
    const models = result.daily.map((row) => row.modelsUsed[0]).sort();
    assert.deepEqual(models, [
      "grok-bot-automation",
      "grok-bot-cua",
      "grok-bot-default",
    ]);
    assert.equal(
      result.daily.reduce((sum, row) => sum + row.inputTokens, 0),
      90,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor and Grok Bot share one CSV fetch when loaded together", () => {
  const home = tempHome("shared-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  let fetches = 0;
  const options = {
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-27T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
    fetchCursorCsvFn: () => {
      fetches += 1;
      return CSV_FIXTURE;
    },
  };
  try {
    const cursor = loadCursorUsage({ HOME: home }, options);
    const bot = loadGrokBotUsage({ HOME: home }, options);
    assert.equal(fetches, 1);
    assert.equal(cursor.daily.length, 3);
    assert.equal(bot.daily.length, 3);
    assert.ok(cursor.daily.every((row) => row.agent === "cursor"));
    assert.ok(bot.daily.every((row) => row.agent === "grok-bot"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Grok Bot ledger never-lower and disable keep prior totals", () => {
  const home = tempHome("ledger-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  const header =
    "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost";
  const options = (csv) => ({
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-27T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
    fetchCursorCsvFn: () => csv,
  });
  try {
    const first = loadGrokBotUsage(
      { HOME: home },
      options(`${header}\n2026-08-25,grok-bot-default,1000,1000,0,200,Free\n`),
    );
    assert.equal(first.daily[0].inputTokens, 1000);

    const lower = loadGrokBotUsage(
      { HOME: home },
      options(`${header}\n2026-08-25,grok-bot-default,10,10,0,2,Free\n`),
    );
    assert.equal(lower.daily[0].inputTokens, 1000);
    assert.match(lower.warnings.join(" "), /lower totals for 2026-08-25/);

    let fetched = false;
    const paused = loadGrokBotUsage(
      { HOME: home, CRIBBLE_GROK_BOT: "0" },
      {
        ...options(CSV_FIXTURE),
        fetchCursorCsvFn: () => {
          fetched = true;
          return CSV_FIXTURE;
        },
      },
    );
    assert.equal(fetched, false);
    assert.equal(paused.daily[0].inputTokens, 1000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CSV fetch failure falls back to Grok Bot ledger with a warning", () => {
  const home = tempHome("fail-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  const options = {
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-27T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
  };
  try {
    loadGrokBotUsage(
      { HOME: home },
      { ...options, fetchCursorCsvFn: () => CSV_FIXTURE },
    );
    const failed = loadGrokBotUsage(
      { HOME: home },
      {
        ...options,
        fetchCursorCsvFn: () => {
          throw new Error("network down");
        },
      },
    );
    assert.equal(failed.daily.length, 3);
    assert.match(failed.warnings.join(" "), /Grok Bot usage was not refreshed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fixture without Bot models yields empty Grok Bot daily", () => {
  const home = tempHome("empty-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  const header =
    "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost";
  try {
    const result = loadGrokBotUsage(
      { HOME: home },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        timezone: "UTC",
        nowFn: () => new Date("2026-08-27T00:00:00.000Z"),
        cliConfigPath: seeded.cliConfigPath,
        readSqliteFirstValueFn: () => seeded.jwt,
        fetchCursorCsvFn: () =>
          `${header}\n2026-08-25,gpt-5,80,80,0,20,0.40\n`,
      },
    );
    assert.deepEqual(result.daily, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
