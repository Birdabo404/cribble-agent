"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stripVTControlCharacters } = require("node:util");

const {
  ANSI,
  animationEnabled,
  colorEnabled,
  createActivity,
  renderCliError,
  renderSyncReceipt,
} = require("../lib/terminal");

const CLIENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const RECEIPT = {
  payload: {
    clientId: CLIENT_ID,
    daily: [
      { date: "2026-08-22", totalTokens: 1_500, costUsd: 1.25 },
      { date: "2026-08-23", totalTokens: 2_500, costUsd: 2.5 },
    ],
  },
  result: { endpoint: "https://cribble.dev/api/agent/usage", status: 200 },
  counts: { inserted: 1, replaced: 1, stale: 0 },
};

test("sync receipt has stable plain and styled forms", () => {
  const plain = renderSyncReceipt(RECEIPT, { color: false });
  const styled = renderSyncReceipt(RECEIPT, { color: true });

  assert.equal(
    plain,
    [
      "Cribble · Sync complete",
      "✓ Synced 2 usage days · 2026-08-22 → 2026-08-23",
      "  4,000 tokens · $3.75 estimated",
      "  1 new · 1 updated · 0 unchanged",
      "  https://cribble.dev/api/agent/usage · HTTP 200",
    ].join("\n"),
  );
  assert.match(styled, /\u001b\[38;2;208;254;29m/);
  assert.equal(stripVTControlCharacters(styled), plain);
});

test("color and animation respect terminal, CI, background, and NO_COLOR state", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  assert.equal(colorEnabled({ stream: tty, env: {} }), true);
  assert.equal(colorEnabled({ stream: tty, env: { NO_COLOR: "" } }), false);
  assert.equal(colorEnabled({ color: false, stream: tty, env: {} }), false);
  assert.equal(colorEnabled({ stream: pipe, env: {} }), false);

  assert.equal(animationEnabled({ stream: tty, env: {} }), true);
  assert.equal(animationEnabled({ stream: tty, env: { CI: "true" } }), false);
  assert.equal(animationEnabled({ stream: tty, env: { TERM: "dumb" } }), false);
  assert.equal(animationEnabled({ stream: tty, env: {}, background: true }), false);
  assert.equal(animationEnabled({ stream: pipe, env: {} }), false);
});

test("activity animation updates in place and always clears its terminal line", () => {
  const writes = [];
  let tick;
  let cleared = false;
  const activity = createActivity({
    output: { isTTY: true, write: (value) => writes.push(value) },
    enabled: true,
    color: false,
    setIntervalFn: (callback) => {
      tick = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
  });

  activity.start("Collecting local token usage");
  tick();
  activity.update("Sending usage to Cribble");
  activity.stop();

  assert.match(writes.join(""), /Collecting local token usage/);
  assert.match(writes.join(""), /Sending usage to Cribble/);
  assert.equal(writes.at(-1), ANSI.clearLine);
  assert.equal(cleared, true);
});

test("CLI errors redact credentials and terminal controls before styling", () => {
  const secret = `crib_ag_${"f".repeat(64)}`;
  const rendered = renderCliError(`bad\u001b[31m ${secret}`, { color: true });

  assert.match(rendered, /\[REDACTED\]/);
  assert.doesNotMatch(rendered, new RegExp(secret));
  assert.doesNotMatch(stripVTControlCharacters(rendered), /\u001b/);
});
