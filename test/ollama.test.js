"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { appendOllamaEvent, readOllamaLedger, loadOllamaUsage, MAX_LEDGER_BYTES } = require("../lib/ollama");

function event(overrides = {}) {
  return { schemaVersion: 1, eventId: "req-1", requestId: "req-1", occurredAt: "2026-08-22T12:34:56.000Z", agent: "hermes", provider: "ollama", runtime: "ollama", model: "qwen2.5:3b", provenance: ["local_runtime_ledger"], inputTokens: 11, outputTokens: 7, billedCostUsd: 0, ...overrides };
}

test("ledger rejects symlinks, oversized and partial records", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-ollama-"));
  try {
    const real = join(root, "real.jsonl"); writeFileSync(real, `${JSON.stringify(event())}\n`, { mode: 0o600 });
    const link = join(root, "link.jsonl"); symlinkSync(real, link);
    assert.throws(() => readOllamaLedger(link), /symbolic link/);
    const huge = join(root, "huge.jsonl"); writeFileSync(huge, Buffer.alloc(MAX_LEDGER_BYTES + 1), { mode: 0o600 });
    assert.throws(() => readOllamaLedger(huge), /safe byte limit/);
    writeFileSync(real, JSON.stringify(event()), { mode: 0o600 });
    assert.throws(() => readOllamaLedger(real), /complete newline-framed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ledger detects source mutation while pinned and fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-ollama-")); const file = join(root, "usage.jsonl");
  try {
    writeFileSync(file, `${JSON.stringify(event())}\n`, { mode: 0o600 });
    assert.throws(() => readOllamaLedger(file, { afterRead: () => writeFileSync(file, `${JSON.stringify(event({ outputTokens: 8 }))}\n`) }), /changed while being read/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("append repairs 0644 on configured ledger and refuses sabotage", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-ollama-")); const file = join(root, "custom.jsonl");
  try {
    writeFileSync(file, "", { mode: 0o644 }); chmodSync(file, 0o644);
    appendOllamaEvent(file, event());
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).eventId, "req-1");
    assert.throws(() => appendOllamaEvent(file, event({eventId:"req-2"}), { chmodSyncFn: () => { throw new Error("denied"); } }), /secure ledger permissions/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Ollama preserves unknown classes, exact identity and sanitized provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-ollama-")); const file = join(root, "usage.jsonl");
  try {
    writeFileSync(file, `${JSON.stringify(event())}\n`, { mode: 0o600 });
    const report = loadOllamaUsage({}, { ledgerFilePath: file, timezone: "UTC" });
    assert.deepEqual(report.sources, ["ollama"]);
    assert.equal(report.events[0].occurredAt, event().occurredAt);
    assert.equal(report.events[0].cacheCreationTokens, undefined);
    assert.equal(report.events[0].cacheReadTokens, undefined);
    assert.equal(report.events[0].reasoningTokens, undefined);
    assert.equal(report.events[0].billedCostUsd, 0);
    assert.equal(JSON.stringify(report).includes("prompt"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("request dedup removes equivalent cross-source replay but never count collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-ollama-")); const file = join(root, "usage.jsonl");
  try {
    writeFileSync(file, [event(), event({eventId:"ollama-copy", provenance:["opencode" ]}), event({eventId:"unrelated",requestId:"req-2"})].map(JSON.stringify).join("\n")+"\n", {mode:0o600});
    const report = loadOllamaUsage({}, {ledgerFilePath:file, timezone:"UTC"});
    assert.equal(report.events.length, 2);
    assert.deepEqual(report.events.find(e=>e.requestId==="req-1").provenance.sort(), ["local_runtime_ledger","opencode"]);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
