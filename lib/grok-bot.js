"use strict";

// Grok Bot desktop usage is attributed from Cursor's official usage CSV.
// Models matching grok-bot-* / legacy sand-* are partitioned out of the
// Cursor collector so they do not inflate Cursor IDE totals. Auth reuses the
// local Cursor session cookie path; the cookie is never returned, logged, or
// uploaded. This is not Grok Build CLI (~/.grok / ccusage grok).

const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { posix, win32 } = require("node:path");
const { configDirectory } = require("./config-path");
const {
  aggregateGrokBotDaily,
  cursorSafeText,
  getSharedParsedCursorCsv,
  partitionCursorCsvRecords,
  resolveCursorSessionForUsage,
} = require("./cursor");

const LEDGER_RETENTION_DAYS = 400;
const MAX_LEDGER_RECORDS = 1_000_000;

function pathApiForHome(platform) {
  return platform === "win32" ? win32 : posix;
}

function isGrokBotCollectionDisabled(env = {}) {
  const value = String(env.CRIBBLE_GROK_BOT ?? "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

function localDate(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function grokBotLedgerPath(env = process.env, options = {}) {
  if (options.grokBotLedgerFilePath) return options.grokBotLedgerFilePath;
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiForHome(platform);
  const nativeHome =
    options.homeDirectory ??
    options.homes?.find(({ scope }) => scope === "native")?.home ??
    homedir();
  return pathApi.join(
    configDirectory({ homeDirectory: nativeHome, env, platform }),
    "grok-bot-usage-ledger.json",
  );
}

function readGrokBotLedger(filePath, options = {}) {
  const existsSyncFn = options.ledgerExistsSyncFn ?? existsSync;
  const readFileSyncFn = options.ledgerReadFileSyncFn ?? readFileSync;
  if (!existsSyncFn(filePath)) return { records: new Map(), timezone: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSyncFn(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the Grok Bot usage ledger at ${filePath}: ${cursorSafeText(error?.message, "invalid JSON")}. Delete that file to reset local Grok Bot history.`,
    );
  }
  if (
    parsed?.schemaVersion !== 1 ||
    !parsed.records ||
    typeof parsed.records !== "object" ||
    Array.isArray(parsed.records)
  ) {
    throw new Error(
      `The Grok Bot usage ledger at ${filePath} has an unsupported format. Delete that file to reset local Grok Bot history.`,
    );
  }
  const entries = Object.entries(parsed.records);
  if (entries.length > MAX_LEDGER_RECORDS) {
    throw new Error("The Grok Bot usage ledger exceeds its safe record limit.");
  }
  const records = new Map();
  for (const [recordKey, row] of entries) {
    if (
      !/^[0-9a-f]{64}$/.test(recordKey) ||
      !row ||
      typeof row !== "object" ||
      typeof row.date !== "string"
    ) {
      throw new Error("The Grok Bot usage ledger contains an invalid record.");
    }
    records.set(recordKey, row);
  }
  return {
    records,
    timezone: typeof parsed.timezone === "string" ? parsed.timezone : null,
  };
}

function writeGrokBotLedger(filePath, records, timezone, options = {}) {
  if (records.size > MAX_LEDGER_RECORDS) {
    throw new Error("The Grok Bot usage ledger exceeds its safe record limit.");
  }
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiForHome(platform);
  const mkdirSyncFn = options.ledgerMkdirSyncFn ?? mkdirSync;
  const renameSyncFn = options.ledgerRenameSyncFn ?? renameSync;
  const rmSyncFn = options.ledgerRmSyncFn ?? rmSync;
  const writeFileSyncFn = options.ledgerWriteFileSyncFn ?? writeFileSync;
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSyncFn(pathApi.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    writeFileSyncFn(
      temporaryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        timezone,
        records: Object.fromEntries(records),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSyncFn(temporaryPath, filePath);
  } finally {
    rmSyncFn(temporaryPath, { force: true });
  }
}

function pruneLedger(records, timezone, now) {
  const cutoff = localDate(
    new Date(now.getTime() - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    timezone,
  );
  for (const [recordKey, row] of records) {
    if (row.date < cutoff) records.delete(recordKey);
  }
}

function rowTokenTotal(row) {
  return (
    (row.inputTokens ?? 0) +
    (row.outputTokens ?? 0) +
    (row.cacheReadTokens ?? 0) +
    (row.cacheCreationTokens ?? 0)
  );
}

function dateTokenTotals(rows) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.date, (totals.get(row.date) ?? 0) + rowTokenTotal(row));
  }
  return totals;
}

function persistGrokBotRows(currentRows, env, options) {
  const ledgerPath = grokBotLedgerPath(env, options);
  const ledgerExists = (options.ledgerExistsSyncFn ?? existsSync)(ledgerPath);
  const ledger = readGrokBotLedger(ledgerPath, options);
  const records = ledger.records;
  const timezone =
    options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = options.nowFn?.() ?? new Date();
  if (records.size > 0 && ledger.timezone !== timezone) records.clear();
  pruneLedger(records, timezone, now);
  const currentTotals = dateTokenTotals(currentRows);
  const existingTotals = dateTokenTotals([...records.values()]);
  const keptDates = [...currentTotals]
    .filter(([date, total]) => (existingTotals.get(date) ?? 0) > total)
    .map(([date]) => date)
    .sort();
  const keptDateSet = new Set(keptDates);
  const replacedDates = new Set(
    currentRows.map((row) => row.date).filter((date) => !keptDateSet.has(date)),
  );
  if (replacedDates.size) {
    for (const [recordKey, row] of records) {
      if (replacedDates.has(row.date)) records.delete(recordKey);
    }
  }
  for (const row of currentRows) {
    if (keptDateSet.has(row.date)) continue;
    const { recordKey, ...persistedRow } = row;
    records.set(recordKey, persistedRow);
  }
  if (ledgerExists || records.size > 0) {
    writeGrokBotLedger(ledgerPath, records, timezone, options);
  }
  return {
    daily: [...records.values()],
    ...(keptDates.length
      ? {
          warnings: [
            `Grok Bot reported lower totals for ${keptDates.join(", ")}; keeping the previously recorded Grok Bot usage for ${keptDates.length === 1 ? "that day" : "those days"}.`,
          ],
        }
      : {}),
  };
}

function loadExistingGrokBotLedger(env, options) {
  const ledgerPath = grokBotLedgerPath(env, options);
  const { records } = readGrokBotLedger(ledgerPath, options);
  if (!records.size) return { daily: [] };
  const timezone =
    options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  pruneLedger(records, timezone, options.nowFn?.() ?? new Date());
  return { daily: [...records.values()] };
}

function grokBotLedgerFallback(env, options, reason) {
  const existing = loadExistingGrokBotLedger(env, options);
  return {
    daily: existing.daily,
    warnings: [`Grok Bot usage was not refreshed: ${reason}`],
  };
}

function loadGrokBotUsage(env = process.env, options = {}) {
  if (isGrokBotCollectionDisabled(env)) {
    return loadExistingGrokBotLedger(env, options);
  }
  const resolved = resolveCursorSessionForUsage(env, options);
  if (resolved.missingInstall) return loadExistingGrokBotLedger(env, options);
  if (!resolved.ok) {
    return grokBotLedgerFallback(env, options, resolved.reason);
  }

  const timezone =
    options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Shares the Cursor CSV fetch/parse cache when loadCursorUsage already ran
  // (or will run) with the same options object in loadSupplementalUsage.
  const parsed = getSharedParsedCursorCsv(resolved.session, options);
  if (!parsed.ok) {
    return grokBotLedgerFallback(
      env,
      options,
      cursorSafeText(parsed.error?.message),
    );
  }
  const { grokBotRecords } = partitionCursorCsvRecords(parsed.records);
  const currentRows = aggregateGrokBotDaily(grokBotRecords, timezone);
  return persistGrokBotRows(currentRows, env, options);
}

module.exports = {
  grokBotLedgerPath,
  isGrokBotCollectionDisabled,
  loadGrokBotUsage,
};
