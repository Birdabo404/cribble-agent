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

const TEMP_ROOT = join(__dirname, "tmp-cursor-homes");

const { buildSnapshot } = require("../lib/usage");
const { loadUsage } = require("../lib/source");
const { mergeUsageReports: mergeReports } = require("../lib/supplemental");
const {
  aggregateCursorDaily,
  cursorSafeText,
  extractCursorSessionToken,
  findCursorInstall,
  loadCursorUsage,
  parseCursorCsv,
  resolveCursorPaths,
} = require("../lib/cursor");

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

function seedCursorInstall(home, { platform, env, jwt, authId } = {}) {
  const cliConfigPath = join(home, "cursor-cli-config.json");
  const paths = resolveCursorPaths({
    home,
    platform,
    scope: "native",
    env: env ?? {},
    cliConfigPath,
  });
  mkdirSync(join(paths.appDir, "User", "globalStorage"), { recursive: true });
  writeFileSync(paths.stateDbPath, "sqlite-placeholder");
  writeFileSync(
    cliConfigPath,
    JSON.stringify({
      authInfo: { authId: authId ?? "auth0|user_test123" },
    }),
  );
  return {
    ...paths,
    jwt: jwt ?? jwtFor("auth0|user_test123"),
  };
}

test("Cursor paths resolve on macOS, Linux, Windows, and WSL", () => {
  assert.equal(
    resolveCursorPaths({
      home: "/Users/ada",
      platform: "darwin",
      scope: "native",
    }).stateDbPath,
    "/Users/ada/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  );
  assert.equal(
    resolveCursorPaths({
      home: "/home/ada",
      platform: "linux",
      scope: "native",
      env: { XDG_CONFIG_HOME: "/home/ada/.xdg" },
    }).appDir,
    "/home/ada/.xdg/Cursor",
  );
  assert.equal(
    resolveCursorPaths({
      home: "C:\\Users\\ada",
      platform: "win32",
      scope: "native",
      env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    }).appDir,
    "C:\\Users\\ada\\AppData\\Roaming\\Cursor",
  );
  assert.equal(
    resolveCursorPaths({
      home: "\\\\wsl.localhost\\Ubuntu\\home\\ada",
      platform: "win32",
      scope: "wsl:Ubuntu",
    }).appDir,
    "\\\\wsl.localhost\\Ubuntu\\home\\ada\\.config\\Cursor",
  );
});

test("Cursor discovery prefers a native install over a WSL mirror", () => {
  const nativeDb =
    "C:\\Users\\ada\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb";
  const wslDb =
    "\\\\wsl.localhost\\Ubuntu\\home\\ada\\.config\\Cursor\\User\\globalStorage\\state.vscdb";
  const found = findCursorInstall(
    { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    {
      platform: "win32",
      homes: [
        { scope: "wsl:Ubuntu", home: "\\\\wsl.localhost\\Ubuntu\\home\\ada" },
        { scope: "native", home: "C:\\Users\\ada" },
      ],
      existsSyncFn: (filePath) => filePath === nativeDb || filePath === wslDb,
    },
  );
  assert.equal(found.scope, "native");
  assert.equal(found.stateDbPath, nativeDb);
});

test("Cursor CSV parsing is header-based and timezone-aware", () => {
  const records = parseCursorCsv(CSV_FIXTURE);
  assert.equal(records.length, 3);
  assert.equal(records[0].inputTokens, 100);
  assert.equal(records[0].cacheWriteTokens, 50);
  assert.equal(records[0].cacheReadTokens, 50);
  assert.equal(records[0].outputTokens, 35);
  assert.equal(records[0].cost, 0.12);

  const utc = aggregateCursorDaily(records, "UTC");
  assert.equal(utc.length, 3);
  assert.deepEqual(
    [...new Set(utc.map((row) => row.date))].sort(),
    ["2026-08-24", "2026-08-25"],
  );
  const sonnet = utc.find((row) => row.modelsUsed[0] === "claude-4-sonnet");
  assert.equal(sonnet.inputTokens, 100);
  assert.equal(sonnet.cacheCreationTokens, 50);

  const manila = aggregateCursorDaily(records, "Asia/Manila");
  assert.ok(manila.some((row) => row.date === "2026-08-26"));
});

test("Cursor CSV fails closed on missing columns or truncated rows", () => {
  assert.throws(
    () => parseCursorCsv("Date,Model\n2026-08-25,gpt-5\n"),
    /missing required columns/,
  );
  assert.throws(
    () =>
      parseCursorCsv(
        [
          "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost",
          "2026-08-25,gpt-5,1",
          "",
        ].join("\n"),
      ),
    /truncated row/,
  );
});

test("Cursor session extraction never returns prompt content", () => {
  const jwt = jwtFor("auth0|user_test123");
  const session = extractCursorSessionToken({
    stateDbPath: "/tmp/state.vscdb",
    cliConfigPath: "/tmp/missing.json",
    options: {
      readSqliteFirstValueFn: () => jwt,
      readFileSyncFn: () => {
        throw new Error("no cli config");
      },
    },
  });
  assert.equal(session.userId, "user_test123");
  assert.match(session.cookie, /^WorkosCursorSessionToken=user_test123%3A%3A/);
  assert.equal(cursorSafeText(session.cookie), "WorkosCursorSessionToken=[REDACTED]");
  assert.equal(cursorSafeText(`expired ${jwt}`).includes(jwt), false);
});

test("Cursor collection on Linux writes daily rows without leaking the session", () => {
  const home = tempHome("linux-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  try {
    const result = loadCursorUsage(
      { HOME: home, CRIBBLE_CURSOR: "1" },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        timezone: "UTC",
        nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
        cliConfigPath: seeded.cliConfigPath,
        readSqliteFirstValueFn: () => seeded.jwt,
        fetchCursorCsvFn: () => CSV_FIXTURE,
      },
    );
    const serialized = JSON.stringify(result);
    assert.equal(result.daily.length, 3);
    assert.ok(result.daily.every((row) => row.agent === "cursor"));
    assert.equal(serialized.includes(seeded.jwt), false);
    assert.equal(serialized.includes("WorkosCursorSessionToken"), false);
    assert.equal(serialized.includes("prompt"), false);

    const snapshot = buildSnapshot(
      { daily: result.daily, sources: ["ccusage", "cursor"], timezone: "UTC" },
      { days: 365 },
    );
    assert.equal(snapshot.source, "cribble-agent");
    assert.ok(snapshot.agents.includes("cursor"));
    assert.equal(snapshot.totals.inputTokens, 190);
    assert.equal(snapshot.totals.cacheTokens, 100);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor ledger preserves usage after the local state database disappears", () => {
  const home = tempHome("ledger-");
  const seeded = seedCursorInstall(home, { platform: "darwin" });
  const options = {
    platform: "darwin",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
    fetchCursorCsvFn: () => CSV_FIXTURE,
  };
  try {
    assert.equal(loadCursorUsage({ HOME: home }, options).daily.length, 3);
    rmSync(seeded.stateDbPath);
    const afterRemoval = loadCursorUsage({ HOME: home }, options);
    assert.equal(afterRemoval.daily.length, 3);
    assert.equal(
      afterRemoval.daily.find((row) => row.modelsUsed[0] === "gpt-5").outputTokens,
      20,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor refresh problems keep the ledger and warn instead of failing", () => {
  const home = tempHome("fail-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  try {
    // Installed-but-signed-out must not break ccusage and Prime syncing.
    let fetched = false;
    const signedOut = loadCursorUsage(
      { HOME: home },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        cliConfigPath: seeded.cliConfigPath,
        readSqliteFirstValueFn: () => null,
        fetchCursorCsvFn: () => {
          fetched = true;
          return CSV_FIXTURE;
        },
      },
    );
    assert.equal(fetched, false);
    assert.deepEqual(signedOut.daily, []);
    assert.match(signedOut.warnings.join(" "), /no usable sign-in/);

    // An expired session (401) keeps the ledger, warns, and never leaks the
    // token into the warning text.
    const expired = loadCursorUsage(
      { HOME: home },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        cliConfigPath: seeded.cliConfigPath,
        readSqliteFirstValueFn: () => seeded.jwt,
        fetchCursorCsvFn: () => {
          throw new Error(`401 ${seeded.jwt}`);
        },
      },
    );
    assert.deepEqual(expired.daily, []);
    const expiredWarnings = expired.warnings.join(" ");
    assert.match(expiredWarnings, /Cursor usage was not refreshed/);
    assert.equal(expiredWarnings.includes(seeded.jwt), false);
    assert.match(expiredWarnings, /\[REDACTED\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor token counts accept separators and fail closed when unreadable", () => {
  const header =
    "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost";
  const separators = parseCursorCsv(
    `${header}\n2026-08-25,gpt-5,"2,500","1,234",0,20,"$1,000.50"\n`,
  );
  assert.equal(separators[0].inputTokens, 1234);
  assert.equal(separators[0].cacheWriteTokens, 1266);
  assert.equal(separators[0].cost, 1000.5);
  assert.throws(
    () => parseCursorCsv(`${header}\n2026-08-25,gpt-5,80,eighty,0,20,0.40\n`),
    /unreadable token count/,
  );
  assert.throws(
    () => parseCursorCsv(`${header}\n2026-08-25,gpt-5,80,80,0,20,-0.40\n`),
    /unreadable cost/,
  );
});

test("a collection timezone change rebuilds the ledger without double-counting", () => {
  const home = tempHome("tz-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  const options = (timezone) => ({
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone,
    nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
    fetchCursorCsvFn: () => CSV_FIXTURE,
  });
  const totalInput = (report) =>
    report.daily.reduce((sum, row) => sum + row.inputTokens, 0);
  try {
    const utc = loadCursorUsage({ HOME: home }, options("UTC"));
    assert.equal(utc.daily.length, 3);
    assert.equal(totalInput(utc), 190);

    // The 2026-08-25T16:00:00Z event re-buckets to 2026-08-26 in Manila. The
    // stale UTC row for that event must not survive alongside the new one.
    const manila = loadCursorUsage({ HOME: home }, options("Asia/Manila"));
    assert.equal(manila.daily.length, 3);
    assert.equal(totalInput(manila), 190);
    assert.ok(manila.daily.some((row) => row.date === "2026-08-26"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor ledger never replaces a day with a lower total", () => {
  const home = tempHome("monotonic-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  const header =
    "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost";
  const options = (csv) => ({
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
    fetchCursorCsvFn: () => csv,
  });
  try {
    const first = loadCursorUsage(
      { HOME: home },
      options(`${header}\n2026-08-25,gpt-5,1000,1000,0,200,1.00\n`),
    );
    assert.equal(first.daily[0].inputTokens, 1000);
    assert.equal(first.warnings, undefined);

    // A refetch that reports less usage for an already-recorded day keeps
    // the recorded day so the next upload cannot lower the server total.
    const lower = loadCursorUsage(
      { HOME: home },
      options(`${header}\n2026-08-25,gpt-5,10,10,0,2,0.01\n`),
    );
    assert.equal(lower.daily.length, 1);
    assert.equal(lower.daily[0].inputTokens, 1000);
    assert.match(lower.warnings.join(" "), /lower totals for 2026-08-25/);

    // Higher totals still replace the day as usual.
    const higher = loadCursorUsage(
      { HOME: home },
      options(`${header}\n2026-08-25,gpt-5,3000,3000,0,600,3.00\n`),
    );
    assert.equal(higher.daily.length, 1);
    assert.equal(higher.daily[0].inputTokens, 3000);
    assert.equal(higher.warnings, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Disabled Cursor collection keeps the last ledger and does not call the API", () => {
  const home = tempHome("off-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  const options = {
    platform: "linux",
    homes: [{ scope: "native", home }],
    timezone: "UTC",
    nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
    cliConfigPath: seeded.cliConfigPath,
    readSqliteFirstValueFn: () => seeded.jwt,
  };
  try {
    loadCursorUsage({ HOME: home }, {
      ...options,
      fetchCursorCsvFn: () => CSV_FIXTURE,
    });
    let fetched = false;
    const paused = loadCursorUsage(
      { HOME: home, CRIBBLE_CURSOR: "0" },
      {
        ...options,
        fetchCursorCsvFn: () => {
          fetched = true;
          return CSV_FIXTURE;
        },
      },
    );
    assert.equal(fetched, false);
    assert.equal(paused.daily.length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ccusage Cursor days suppress the supplemental Cursor collector", () => {
  const merged = mergeReports(
    [{
      daily: [{
        date: "2026-08-25",
        metadata: { agents: ["Cursor Agent"] },
        inputTokens: 10,
      }],
    }],
    {
      daily: [{
        date: "2026-08-25",
        provider: "cursor",
        overlapProviders: ["cursor"],
        agent: "cursor",
        inputTokens: 100,
      }],
    },
  );
  assert.equal(merged.daily.length, 1);
  assert.equal(merged.daily[0].inputTokens, 10);
  assert.equal(merged.sources, undefined);
});

test("Cursor fetch worker arguments never include the session cookie", () => {
  const home = tempHome("worker-");
  const seeded = seedCursorInstall(home, { platform: "linux" });
  let invocation;
  try {
    loadCursorUsage(
      { HOME: home },
      {
        platform: "linux",
        homes: [{ scope: "native", home }],
        timezone: "UTC",
        nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
        cliConfigPath: seeded.cliConfigPath,
        readSqliteFirstValueFn: () => seeded.jwt,
        cursorExecFileSyncFn: (command, args, options) => {
          invocation = { command, args, options };
          return CSV_FIXTURE;
        },
      },
    );
    assert.equal(invocation.args.join(" ").includes(seeded.jwt), false);
    assert.equal(JSON.stringify(invocation.options.env).includes(seeded.jwt), false);
    assert.match(invocation.options.input, /WorkosCursorSessionToken=/);
    assert.equal(invocation.options.stdio[0], "pipe");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadUsage merges Cursor with ccusage on macOS and Linux", () => {
  for (const platform of ["darwin", "linux"]) {
    const home = tempHome(`${platform}-`);
    const seeded = seedCursorInstall(home, { platform, env: { HOME: home } });
    try {
      const result = loadUsage(
        { HOME: home, CCUSAGE_BIN: "/opt/ccusage", TZ: "UTC" },
        {
          platform,
          timezone: "UTC",
          usageHomesFn: () => [{ scope: "native", home }],
          execFileSyncFn: () => JSON.stringify({
            daily: [{ date: "2026-08-25", agent: "claude", inputTokens: 5 }],
          }),
          cliConfigPath: seeded.cliConfigPath,
          readSqliteFirstValueFn: () => seeded.jwt,
          fetchCursorCsvFn: () => CSV_FIXTURE,
          nowFn: () => new Date("2026-08-26T00:00:00.000Z"),
        },
      );
      assert.ok(
        result.daily.some((row) => row.agent === "cursor"),
        `expected Cursor rows on ${platform}`,
      );
      assert.ok(result.sources.includes("cursor"));
      assert.ok(result.sources.includes("ccusage"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
