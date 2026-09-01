"use strict";

// Cursor support is adapted from TokenTracker's MIT-licensed session + usage
// reader. Cribble keeps only token counts, timestamps, model, and cost. The
// Cursor session cookie is used only to call Cursor's own usage API and is
// never returned, logged, or uploaded.

const { execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
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
const { safeText } = require("./safety");
const { readSqliteFirstValue } = require("./sqlite-reader");

const CURSOR_ACCESS_TOKEN_SQL =
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';";
const WORKOS_OAUTH_SUBJECT_RE = /^(google-oauth2|github|oidc|auth0)\|[^|]+$/;
const MAX_LEDGER_RECORDS = 1_000_000;
const DEFAULT_CURSOR_TIMEOUT_MS = 30_000;
const MAX_CURSOR_TIMEOUT_MS = 120_000;

function cursorSafeText(value, fallback = "Cursor collector error") {
  return safeText(value, { fallback, maxLength: 200 });
}

function isCursorCollectionDisabled(env = {}) {
  const value = String(env.CRIBBLE_CURSOR ?? "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

function pathApiForHome(platform) {
  return platform === "win32" ? win32 : posix;
}

function resolveCursorPaths({
  home,
  platform = process.platform,
  scope = "native",
  env = {},
  cliConfigPath,
} = {}) {
  const pathApi = pathApiForHome(platform);
  let appDir;
  if (platform === "win32" && scope === "native") {
    const appData =
      (typeof env.APPDATA === "string" && env.APPDATA.trim()) ||
      pathApi.join(home, "AppData", "Roaming");
    appDir = pathApi.join(appData, "Cursor");
  } else if (platform === "darwin" && scope === "native") {
    appDir = pathApi.join(home, "Library", "Application Support", "Cursor");
  } else {
    const xdg =
      (scope === "native" &&
        typeof env.XDG_CONFIG_HOME === "string" &&
        env.XDG_CONFIG_HOME.trim()) ||
      pathApi.join(home, ".config");
    appDir = pathApi.join(xdg, "Cursor");
  }
  return {
    appDir,
    stateDbPath: pathApi.join(appDir, "User", "globalStorage", "state.vscdb"),
    cliConfigPath:
      cliConfigPath ?? pathApi.join(home, ".cursor", "cli-config.json"),
  };
}

function cursorCandidateHomes(options = {}) {
  const nativeHome = options.homeDirectory ?? homedir();
  const homes = Array.isArray(options.homes) && options.homes.length
    ? options.homes
    : [{ scope: "native", home: nativeHome }];
  return [...homes].sort((left, right) => {
    if (left.scope === "native" && right.scope !== "native") return -1;
    if (right.scope === "native" && left.scope !== "native") return 1;
    return 0;
  });
}

function findCursorInstall(env = {}, options = {}) {
  const platform = options.platform ?? process.platform;
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  for (const home of cursorCandidateHomes(options)) {
    const paths = resolveCursorPaths({
      home: home.home,
      platform,
      scope: home.scope,
      env,
      cliConfigPath: options.cliConfigPath,
    });
    if (existsSyncFn(paths.stateDbPath)) {
      return { ...home, ...paths };
    }
  }
  return null;
}

function normalizeCursorSubject(subject) {
  if (!subject) return null;
  const native = String(subject).match(/\|(user_[A-Za-z0-9_]+)$/);
  if (native) return native[1];
  if (WORKOS_OAUTH_SUBJECT_RE.test(subject)) return subject;
  return null;
}

function extractUserIdFromJwt(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return normalizeCursorSubject(payload.sub || "");
  } catch {
    return null;
  }
}

function extractUserIdFromCliConfig(configPath, readFileSyncFn) {
  try {
    const config = JSON.parse(readFileSyncFn(configPath, "utf8"));
    return normalizeCursorSubject(config?.authInfo?.authId || "");
  } catch {
    return null;
  }
}

function asAccessToken(value) {
  let text = String(value ?? "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {
      text = text.slice(1, -1);
    }
  }
  return typeof text === "string" && text.length >= 10 ? text : null;
}

function extractCursorSessionToken({
  stateDbPath,
  cliConfigPath,
  options = {},
} = {}) {
  const readFileSyncFn = options.readFileSyncFn ?? readFileSync;
  const jwt = asAccessToken(
    (options.readSqliteFirstValueFn ?? readSqliteFirstValue)(
      stateDbPath,
      CURSOR_ACCESS_TOKEN_SQL,
      "value",
      {
        execFileSyncFn: options.execFileSyncFn,
        existsSyncFn: options.existsSyncFn,
        requireFn: options.requireFn,
        throwOnReadFailure: true,
        label: "Cursor",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    ),
  );
  if (!jwt) return null;
  const userId =
    extractUserIdFromCliConfig(cliConfigPath, readFileSyncFn) ||
    extractUserIdFromJwt(jwt);
  if (!userId) return null;
  return {
    cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`,
    userId,
  };
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

function isDailyDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const parsed = new Date(utc);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function cursorEventDate(value, timezone) {
  const text = String(value ?? "").trim();
  if (isDailyDate(text)) return text;
  const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+.*)?$/);
  if (mdy) {
    const date = `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
    return isDailyDate(date) ? date : null;
  }
  return localDate(text, timezone);
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (const character of line) {
    if (character === '"') {
      inQuotes = !inQuotes;
      current += character;
    } else if (character === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current.trim());
  return fields;
}

function stripQuotes(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function toTokenCount(value) {
  // Empty cells mean zero, but a non-empty cell that does not parse (or a
  // negative value) must fail closed instead of silently recording 0 and
  // replacing a day with a lower total.
  const text = stripQuotes(value).replace(/,/g, "");
  if (text === "") return 0;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(
      "Cursor usage export contains an unreadable token count; refusing a partial usage report.",
    );
  }
  return Math.floor(number);
}

function toCost(value) {
  const text = stripQuotes(value).replace(/[$,]/g, "");
  if (text === "") return 0;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(
      "Cursor usage export contains an unreadable cost; refusing a partial usage report.",
    );
  }
  return number;
}

function parseCursorCsv(csvText) {
  const lines = String(csvText ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headerFields = parseCsvLine(lines[0]).map((field) => stripQuotes(field));
  const columnIndex = new Map(headerFields.map((name, index) => [name, index]));
  const dateIdx = columnIndex.get("Date");
  const modelIdx = columnIndex.get("Model");
  const inputWithIdx = columnIndex.get("Input (w/ Cache Write)");
  const inputWithoutIdx = columnIndex.get("Input (w/o Cache Write)");
  const cacheReadIdx = columnIndex.get("Cache Read");
  const outputIdx = columnIndex.get("Output Tokens");
  const costIdx = columnIndex.get("Cost");
  const required = [
    dateIdx,
    modelIdx,
    inputWithIdx,
    inputWithoutIdx,
    cacheReadIdx,
    outputIdx,
    costIdx,
  ];
  if (required.some((index) => index === undefined)) {
    throw new Error(
      "Cursor usage export is missing required columns; refusing a partial usage report.",
    );
  }

  const minFields = Math.max(...required) + 1;
  const records = [];
  for (let index = 1; index < lines.length; index += 1) {
    const fields = parseCsvLine(lines[index]);
    if (!fields || fields.length < minFields) {
      throw new Error(
        "Cursor usage export contains a truncated row; refusing a partial usage report.",
      );
    }
    const inputWithCache = toTokenCount(fields[inputWithIdx]);
    const inputWithoutCache = toTokenCount(fields[inputWithoutIdx]);
    records.push({
      date: stripQuotes(fields[dateIdx]),
      model: stripQuotes(fields[modelIdx]),
      inputTokens: inputWithoutCache,
      cacheWriteTokens: Math.max(0, inputWithCache - inputWithoutCache),
      cacheReadTokens: toTokenCount(fields[cacheReadIdx]),
      outputTokens: toTokenCount(fields[outputIdx]),
      cost: toCost(fields[costIdx]),
    });
  }
  return records;
}

function aggregateCursorDaily(records, timezone) {
  const grouped = new Map();
  for (const record of records) {
    const date = cursorEventDate(record.date, timezone);
    if (!date) {
      throw new Error(
        "Cursor usage export contains an unreadable date; refusing a partial usage report.",
      );
    }
    const model = safeText(record.model, {
      fallback: "cursor-unknown",
      maxLength: 128,
    });
    const key = `${date}\0${model}`;
    const current = grouped.get(key) ?? {
      date,
      provider: "cursor",
      overlapProviders: ["cursor"],
      agent: "cursor",
      modelsUsed: [model],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCost: 0,
    };
    current.inputTokens += record.inputTokens;
    current.outputTokens += record.outputTokens;
    current.cacheReadTokens += record.cacheReadTokens;
    current.cacheCreationTokens += record.cacheWriteTokens;
    current.totalCost += record.cost;
    if (
      !Number.isSafeInteger(current.inputTokens) ||
      !Number.isSafeInteger(current.outputTokens) ||
      !Number.isSafeInteger(current.cacheReadTokens) ||
      !Number.isSafeInteger(current.cacheCreationTokens)
    ) {
      throw new Error(
        "Cursor usage exceeds the safe token range; refusing a partial usage report.",
      );
    }
    if (!Number.isFinite(current.totalCost) || current.totalCost < 0) {
      throw new Error(
        "Cursor usage contains invalid cost metadata; refusing a partial usage report.",
      );
    }
    grouped.set(key, current);
  }

  return [...grouped.values()].filter((row) => {
    const total =
      row.inputTokens +
      row.outputTokens +
      row.cacheReadTokens +
      row.cacheCreationTokens;
    return total > 0;
  }).map((row) => {
    const recordId = `cursor:${row.date}:${row.modelsUsed[0]}`;
    return {
      recordKey: createHash("sha256").update(recordId).digest("hex"),
      ...row,
    };
  });
}

function cursorLedgerPath(env = process.env, options = {}) {
  if (options.cursorLedgerFilePath) return options.cursorLedgerFilePath;
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiForHome(platform);
  const nativeHome =
    options.homeDirectory ??
    options.homes?.find(({ scope }) => scope === "native")?.home ??
    homedir();
  return pathApi.join(
    configDirectory({ homeDirectory: nativeHome, env, platform }),
    "cursor-usage-ledger.json",
  );
}

function readCursorLedger(filePath, options = {}) {
  const existsSyncFn = options.ledgerExistsSyncFn ?? existsSync;
  const readFileSyncFn = options.ledgerReadFileSyncFn ?? readFileSync;
  if (!existsSyncFn(filePath)) return { records: new Map(), timezone: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSyncFn(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the Cursor usage ledger at ${filePath}: ${cursorSafeText(error?.message, "invalid JSON")}. Delete that file to reset local Cursor history.`,
    );
  }
  if (
    parsed?.schemaVersion !== 1 ||
    !parsed.records ||
    typeof parsed.records !== "object" ||
    Array.isArray(parsed.records)
  ) {
    throw new Error(
      `The Cursor usage ledger at ${filePath} has an unsupported format. Delete that file to reset local Cursor history.`,
    );
  }
  const entries = Object.entries(parsed.records);
  if (entries.length > MAX_LEDGER_RECORDS) {
    throw new Error("The Cursor usage ledger exceeds its safe record limit.");
  }
  const records = new Map();
  for (const [recordKey, row] of entries) {
    if (
      !/^[0-9a-f]{64}$/.test(recordKey) ||
      !row ||
      typeof row !== "object" ||
      typeof row.date !== "string"
    ) {
      throw new Error("The Cursor usage ledger contains an invalid record.");
    }
    records.set(recordKey, row);
  }
  return {
    records,
    timezone: typeof parsed.timezone === "string" ? parsed.timezone : null,
  };
}

function writeCursorLedger(filePath, records, timezone, options = {}) {
  if (records.size > MAX_LEDGER_RECORDS) {
    throw new Error("The Cursor usage ledger exceeds its safe record limit.");
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

function persistCursorRows(currentRows, env, options) {
  const ledgerPath = cursorLedgerPath(env, options);
  const ledgerExists = (options.ledgerExistsSyncFn ?? existsSync)(ledgerPath);
  const ledger = readCursorLedger(ledgerPath, options);
  const records = ledger.records;
  const timezone =
    options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Ledger dates are bucketed in one timezone. When the collection timezone
  // changes, the same event can land on a different local date, so
  // replace-by-date would orphan the old row and double-count the event.
  // Rebuild from the current export instead; days absent from the export are
  // simply not re-uploaded, which the server treats as unchanged.
  if (records.size > 0 && ledger.timezone !== timezone) records.clear();
  // Replacing a day with a lower total would make the next upload erase
  // usage the server already recorded. Keep the higher ledger day instead
  // and say so locally.
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
    writeCursorLedger(ledgerPath, records, timezone, options);
  }
  return {
    daily: [...records.values()],
    ...(keptDates.length
      ? {
          warnings: [
            `Cursor reported lower totals for ${keptDates.join(", ")}; keeping the previously recorded Cursor usage for ${keptDates.length === 1 ? "that day" : "those days"}.`,
          ],
        }
      : {}),
  };
}

function cursorFetchTimeoutMs(options = {}) {
  const configured = options.cursorTimeoutMs ?? options.timeoutMs;
  if (!Number.isInteger(configured) || configured < 1_000) {
    return DEFAULT_CURSOR_TIMEOUT_MS;
  }
  return Math.min(configured, MAX_CURSOR_TIMEOUT_MS);
}

function fetchCursorUsageCsv(session, options = {}) {
  if (typeof options.fetchCursorCsvFn === "function") {
    try {
      return options.fetchCursorCsvFn({ userId: session.userId });
    } catch (error) {
      throw new Error(
        `Could not read Cursor usage: ${cursorSafeText(error?.message)}`,
      );
    }
  }

  const nodePath = options.nodePath ?? process.execPath;
  const workerPath = options.cursorFetchWorkerPath ?? require.resolve("./cursor-fetch-worker");
  const execFileSyncFn = options.cursorExecFileSyncFn ?? execFileSync;
  const timeoutMs = cursorFetchTimeoutMs(options);
  // Node.js on Windows cannot initialize networking (WSAStartup/DNS) in a
  // child process whose environment lacks SystemRoot, and corporate TLS
  // interception needs NODE_EXTRA_CA_CERTS. Mirror the ccusage collector's
  // environment allowlist; never pass secrets through.
  const workerEnv = {
    NO_COLOR: "1",
    PATH: typeof process.env.PATH === "string" ? process.env.PATH : "",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "NODE_EXTRA_CA_CERTS"]) {
    const value = process.env[key];
    if (typeof value === "string" && value) workerEnv[key] = value;
  }
  try {
    return execFileSyncFn(nodePath, [workerPath], {
      encoding: "utf8",
      input: JSON.stringify({ cookie: session.cookie, timeoutMs }),
      // The worker may perform two sequential fetches (one manual redirect),
      // each with its own timeoutMs budget, so give it room for both.
      timeout: timeoutMs * 2 + 2_000,
      maxBuffer: 8 * 1024 * 1024 + 1024,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnv,
    });
  } catch (error) {
    throw new Error(
      `Could not read Cursor usage: ${cursorSafeText(error?.stderr || error?.message)}`,
    );
  }
}

function loadExistingCursorLedger(env, options) {
  const ledgerPath = cursorLedgerPath(env, options);
  // A timezone mismatch is ignored here on purpose: without a fresh export
  // there is nothing to rebuild from, and the recorded days were complete
  // under their own bucketing, so re-serving them never lowers a total.
  const { records } = readCursorLedger(ledgerPath, options);
  if (!records.size) return { daily: [] };
  return { daily: [...records.values()] };
}

// A Cursor refresh problem must not block ccusage and Prime collection: the
// ledger preserves the last complete Cursor totals, so uploading them again
// never lowers a server-side day. Fall back to the ledger and say why.
function cursorLedgerFallback(env, options, reason) {
  const existing = loadExistingCursorLedger(env, options);
  return {
    daily: existing.daily,
    warnings: [`Cursor usage was not refreshed: ${reason}`],
  };
}

function loadCursorUsage(env = process.env, options = {}) {
  if (isCursorCollectionDisabled(env)) {
    return loadExistingCursorLedger(env, options);
  }
  const install = findCursorInstall(env, options);
  if (!install) return loadExistingCursorLedger(env, options);

  let session;
  try {
    session = extractCursorSessionToken({
      stateDbPath: install.stateDbPath,
      cliConfigPath: install.cliConfigPath,
      options,
    });
  } catch (error) {
    return cursorLedgerFallback(
      env,
      options,
      `could not read the Cursor session (${cursorSafeText(error?.message)}).`,
    );
  }
  if (!session) {
    // A readable state database without a usable sign-in means Cursor is
    // installed but signed out (or never signed in).
    return cursorLedgerFallback(
      env,
      options,
      "Cursor is installed but has no usable sign-in.",
    );
  }

  const timezone =
    options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let currentRows;
  try {
    const csv = fetchCursorUsageCsv(session, options);
    currentRows = aggregateCursorDaily(parseCursorCsv(csv), timezone);
  } catch (error) {
    return cursorLedgerFallback(env, options, cursorSafeText(error?.message));
  }
  return persistCursorRows(currentRows, env, options);
}

module.exports = {
  aggregateCursorDaily,
  cursorSafeText,
  extractCursorSessionToken,
  findCursorInstall,
  isCursorCollectionDisabled,
  loadCursorUsage,
  parseCursorCsv,
  resolveCursorPaths,
};
