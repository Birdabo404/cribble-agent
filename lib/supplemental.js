"use strict";

// Prime Agent support is adapted from TokenTracker's MIT-licensed passive
// parser. Cribble retains only token counts, timestamps, provider, and model;
// prompt, response, and tool content is never returned or uploaded.

const { createHash, randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { basename, join, posix, win32 } = require("node:path");
const { configDirectory } = require("./config-path");
const { loadCursorUsage } = require("./cursor");
const { safeText } = require("./safety");
const { usageHomes } = require("./wsl");

const MAX_DISCOVERED_FILES = 10_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_TOTAL_BYTES;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_LEDGER_RECORDS = 1_000_000;
const LEDGER_RETENTION_DAYS = 400;

function listPrimeSessionFiles(root, options = {}) {
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  const readdirSyncFn = options.readdirSyncFn ?? readdirSync;
  if (!existsSyncFn(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSyncFn(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Could not enumerate Prime Agent sessions: ${safeText(error?.message, {
          fallback: "filesystem error",
          maxLength: 160,
        })}`,
      );
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (files.length >= MAX_DISCOVERED_FILES) {
          throw new Error(
            `Prime Agent has more than ${MAX_DISCOVERED_FILES} session files; refusing a partial usage report.`,
          );
        }
        files.push(filePath);
      }
    }
  }
  return files.sort();
}

function optionalNonNegativeInteger(value) {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function localDate(value, timezone) {
  const date = new Date(value);
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

function primeTimestamp(entry, message) {
  const numeric = Number(message?.timestamp);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(entry?.timestamp);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePrimeSession(filePath, seenRecords = new Set(), options = {}) {
  const statSyncFn = options.statSyncFn ?? statSync;
  const readFileSyncFn = options.readFileSyncFn ?? readFileSync;
  let stat;
  let raw;
  try {
    stat = statSyncFn(filePath);
    if (!stat.isFile()) return [];
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `Prime Agent session ${basename(filePath)} exceeds the safe read limit; refusing a partial usage report.`,
      );
    }
    raw = readFileSyncFn(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read Prime Agent session ${basename(filePath)}: ${safeText(
        error?.message,
        { fallback: "filesystem error", maxLength: 160 },
      )}`,
    );
  }
  const rows = [];
  const lines = String(raw).split(/\r?\n/);
  let headerSessionId = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new Error(
        `Prime Agent session ${basename(filePath)} contains an oversized record; refusing a partial usage report.`,
      );
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      const isTrailingPartialRecord =
        index === lines.length - 1 && !String(raw).endsWith("\n");
      if (isTrailingPartialRecord) break;
      throw new Error(
        `Prime Agent session ${basename(filePath)} contains invalid JSON; refusing a partial usage report.`,
      );
    }
    if (["session", "session_header"].includes(entry?.type)) {
      const headerId = entry.id ?? entry.sessionId ?? entry.session_id;
      if (
        typeof headerId === "string" &&
        headerId.length > 0 &&
        headerId.length <= 256
      ) {
        headerSessionId = headerId;
      }
      continue;
    }
    const message = entry?.message;
    const usage = message?.usage;
    if (
      entry?.type !== "message" ||
      message?.role !== "assistant" ||
      !usage ||
      typeof usage !== "object"
    ) {
      continue;
    }
    const entryId =
      typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 256
        ? entry.id
        : null;
    const inlineSessionId =
      typeof (entry.sessionId ?? entry.session_id) === "string" &&
      String(entry.sessionId ?? entry.session_id).length <= 256
        ? String(entry.sessionId ?? entry.session_id)
        : null;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({
        id: entryId,
        timestamp: entry.timestamp ?? message.timestamp,
        provider: message.provider,
        model: message.model,
        usage,
      }))
      .digest("hex");
    const sessionId = inlineSessionId || headerSessionId;
    const recordId = sessionId
      ? `${sessionId}:${entryId ?? fingerprint}`
      : `event:${fingerprint}`;
    if (seenRecords.has(recordId)) continue;

    const parsedInputTokens = optionalNonNegativeInteger(usage.input);
    const parsedOutputTokens = optionalNonNegativeInteger(usage.output);
    const parsedCacheReadTokens = optionalNonNegativeInteger(usage.cacheRead);
    const parsedCacheCreationTokens = optionalNonNegativeInteger(usage.cacheWrite);
    const reasoningTokens = optionalNonNegativeInteger(usage.reasoningTokens);
    const reportedTotalTokens = optionalNonNegativeInteger(
      usage.totalTokens ?? usage.total_tokens,
    );
    if (
      [
        parsedInputTokens,
        parsedOutputTokens,
        parsedCacheReadTokens,
        parsedCacheCreationTokens,
        reasoningTokens,
        reportedTotalTokens,
      ].includes(null)
    ) {
      throw new Error(
        `Prime Agent session ${basename(filePath)} contains invalid token metadata; refusing a partial usage report.`,
      );
    }
    const timestamp = primeTimestamp(entry, message);
    const date = timestamp && localDate(
      timestamp,
      options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (!date) continue;

    let inputTokens = parsedInputTokens ?? 0;
    let outputTokens = parsedOutputTokens ?? 0;
    let cacheReadTokens = parsedCacheReadTokens ?? 0;
    let cacheCreationTokens = parsedCacheCreationTokens ?? 0;
    const fixedTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    const componentTotal = fixedTokens + outputTokens;
    if (
      !Number.isSafeInteger(fixedTokens) ||
      !Number.isSafeInteger(componentTotal)
    ) {
      throw new Error(
        `Prime Agent session ${basename(filePath)} exceeds the safe token range; refusing a partial usage report.`,
      );
    }
    if (reportedTotalTokens > 0) {
      if (reportedTotalTokens >= fixedTokens) {
        // This automatically includes reasoning only when the authoritative
        // total proves that it is not already part of output.
        outputTokens = reportedTotalTokens - fixedTokens;
      } else {
        // Inconsistent component metadata cannot be represented losslessly in
        // Cribble's four-field schema. Keep the authoritative total without
        // inflating it.
        inputTokens = 0;
        cacheReadTokens = 0;
        cacheCreationTokens = 0;
        outputTokens = reportedTotalTokens;
      }
    }
    const totalTokens =
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
    if (!Number.isSafeInteger(totalTokens)) {
      throw new Error(
        `Prime Agent session ${basename(filePath)} exceeds the safe token range; refusing a partial usage report.`,
      );
    }
    if (totalTokens === 0) continue;
    seenRecords.add(recordId);
    const recordKey = createHash("sha256").update(recordId).digest("hex");
    const totalCost = Number(
      usage.cost?.total ?? usage.totalCost ?? usage.total_cost ?? 0,
    );
    if (!Number.isFinite(totalCost) || totalCost < 0) {
      throw new Error(
        `Prime Agent session ${basename(filePath)} contains invalid cost metadata; refusing a partial usage report.`,
      );
    }
    rows.push({
      recordKey,
      date,
      provider: "prime-agent",
      overlapProviders: ["prime-agent"],
      agent: "prime-agent",
      modelsUsed: [
        safeText(message.model, {
          fallback: "prime-agent-unknown",
          maxLength: 128,
        }),
      ],
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalCost,
    });
  }
  return rows;
}

function primeRoots(env, homes) {
  const override =
    (typeof env.PRIME_AGENT_DIR === "string" && env.PRIME_AGENT_DIR) ||
    (typeof env.TOKENTRACKER_PRIME_AGENT_DIR === "string" &&
      env.TOKENTRACKER_PRIME_AGENT_DIR);
  if (override) return [join(override, "sessions")];
  const homeOverride =
    (typeof env.PRIME_AGENT_HOME === "string" && env.PRIME_AGENT_HOME) ||
    (typeof env.TOKENTRACKER_PRIME_AGENT_HOME === "string" &&
      env.TOKENTRACKER_PRIME_AGENT_HOME);
  if (homeOverride) return [join(homeOverride, "agent", "sessions")];
  return homes.map(({ home }) => join(home, ".prime", "agent", "sessions"));
}

function primeLedgerPath(env = process.env, options = {}) {
  if (options.ledgerFilePath) return options.ledgerFilePath;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const nativeHome =
    options.homeDirectory ??
    options.homes?.find(({ scope }) => scope === "native")?.home ??
    homedir();
  return pathApi.join(
    configDirectory({ homeDirectory: nativeHome, env, platform }),
    "prime-usage-ledger.json",
  );
}

function readPrimeLedger(filePath, options = {}) {
  const existsSyncFn = options.ledgerExistsSyncFn ?? existsSync;
  const readFileSyncFn = options.ledgerReadFileSyncFn ?? readFileSync;
  if (!existsSyncFn(filePath)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSyncFn(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the Prime Agent usage ledger: ${safeText(error?.message, {
        fallback: "invalid JSON",
        maxLength: 160,
      })}`,
    );
  }
  if (
    parsed?.schemaVersion !== 1 ||
    !parsed.records ||
    typeof parsed.records !== "object" ||
    Array.isArray(parsed.records)
  ) {
    throw new Error("The Prime Agent usage ledger has an unsupported format.");
  }
  const entries = Object.entries(parsed.records);
  if (entries.length > MAX_LEDGER_RECORDS) {
    throw new Error("The Prime Agent usage ledger exceeds its safe record limit.");
  }
  const records = new Map();
  for (const [recordKey, row] of entries) {
    if (
      !/^[0-9a-f]{64}$/.test(recordKey) ||
      !row ||
      typeof row !== "object" ||
      typeof row.date !== "string"
    ) {
      throw new Error("The Prime Agent usage ledger contains an invalid record.");
    }
    records.set(recordKey, row);
  }
  return records;
}

function writePrimeLedger(filePath, records, options = {}) {
  if (records.size > MAX_LEDGER_RECORDS) {
    throw new Error("The Prime Agent usage ledger exceeds its safe record limit.");
  }
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
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
        records: Object.fromEntries(records),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSyncFn(temporaryPath, filePath);
  } finally {
    rmSyncFn(temporaryPath, { force: true });
  }
}

function loadPrimeUsage(env = process.env, options = {}) {
  const homes = options.homes ?? usageHomes({ ...options, env });
  const files = [...new Set(
    primeRoots(env, homes).flatMap((root) => listPrimeSessionFiles(root, options)),
  )];
  const candidates = [];
  for (const filePath of files) {
    try {
      const stat = (options.statSyncFn ?? statSync)(filePath);
      if (!stat.isFile()) continue;
      if (!Number.isFinite(stat.size) || stat.size < 0) {
        throw new Error("invalid file size");
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `Prime Agent session ${basename(filePath)} exceeds the safe read limit; refusing a partial usage report.`,
        );
      }
      candidates.push({
        filePath,
        size: stat.size,
        modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
      });
    } catch (error) {
      throw new Error(
        `Could not inspect Prime Agent session ${basename(filePath)}: ${safeText(
          error?.message,
          { fallback: "filesystem error", maxLength: 160 },
        )}`,
      );
    }
  }
  // The byte budget is a safety boundary, not a reason to discard the newest
  // usage. Prime session paths are not guaranteed to sort chronologically.
  candidates.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt ||
      right.filePath.localeCompare(left.filePath),
  );
  const seenRecords = new Set();
  const currentRows = [];
  let bytesRead = 0;
  for (const { filePath, size } of candidates) {
    if (bytesRead + size > MAX_TOTAL_BYTES) {
      throw new Error(
        "Prime Agent sessions exceed the safe total read limit; refusing a partial usage report.",
      );
    }
    bytesRead += size;
    currentRows.push(...parsePrimeSession(filePath, seenRecords, options));
  }
  const ledgerPath = primeLedgerPath(env, { ...options, homes });
  const ledgerExists = (options.ledgerExistsSyncFn ?? existsSync)(ledgerPath);
  const records = readPrimeLedger(ledgerPath, options);
  const timezone =
    options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cutoff = localDate(
    new Date(
      (options.nowFn?.() ?? new Date()).getTime() -
        LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ),
    timezone,
  );
  for (const [recordKey, row] of records) {
    if (row.date < cutoff) records.delete(recordKey);
  }
  for (const row of currentRows) {
    const { recordKey, ...persistedRow } = row;
    records.set(recordKey, persistedRow);
  }
  if (ledgerExists || records.size > 0) {
    writePrimeLedger(ledgerPath, records, options);
  }
  return { daily: [...records.values()] };
}

function mergeSupplementalWarnings(...reports) {
  return reports.flatMap((report) =>
    Array.isArray(report?.warnings) ? report.warnings : [],
  );
}

function loadSupplementalUsage(env = process.env, options = {}) {
  const homes = options.homes ?? usageHomes({ ...options, env });
  const collectionOptions = { ...options, homes };
  const prime = loadPrimeUsage(env, collectionOptions);
  const cursor = (options.loadCursorUsageFn ?? loadCursorUsage)(
    env,
    collectionOptions,
  );
  const daily = [...prime.daily, ...cursor.daily];
  const warnings = mergeSupplementalWarnings(prime, cursor);
  return {
    daily,
    ...(warnings.length ? { warnings } : {}),
  };
}

function dailyRows(raw) {
  if (Array.isArray(raw?.daily)) return raw.daily;
  if (Array.isArray(raw?.data) && (!raw.type || raw.type === "daily")) return raw.data;
  if (Array.isArray(raw)) return raw;
  return [];
}

function canonicalProvider(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const aliases = {
    claudecode: "claude",
    codexcli: "codex",
    cursoragent: "cursor",
    piagent: "pi",
    primeagent: "prime-agent",
  };
  if (normalized.startsWith("primeagent")) return "prime-agent";
  if (normalized.startsWith("piagent")) return "pi";
  return aliases[normalized] ?? normalized;
}

function rowProviders(row) {
  return new Set(
    [
      row?.provider,
      row?.agent,
      ...(Array.isArray(row?.agents) ? row.agents : []),
      ...(Array.isArray(row?.metadata?.agents) ? row.metadata.agents : []),
    ].map(canonicalProvider).filter(Boolean),
  );
}

function mergeUsageReports(primaryReports, supplemental = { daily: [] }) {
  const primaryRows = primaryReports.flatMap((report) => dailyRows(report));
  const primaryByDate = new Map();
  for (const row of primaryRows) {
    const date = String(row?.date ?? row?.period ?? "");
    const providers = primaryByDate.get(date) ?? new Set();
    for (const provider of rowProviders(row)) providers.add(provider);
    primaryByDate.set(date, providers);
  }
  const supplementalRows = dailyRows(supplemental).filter((row) => {
    const date = String(row?.date ?? row?.period ?? "");
    const overlaps = [
      row?.provider,
      ...(Array.isArray(row?.overlapProviders) ? row.overlapProviders : []),
    ].map(canonicalProvider).filter(Boolean);
    return overlaps.length > 0 &&
      !overlaps.some((provider) => primaryByDate.get(date)?.has(provider));
  });
  const result = { daily: [...primaryRows, ...supplementalRows] };
  const warnings = Array.isArray(supplemental.warnings)
    ? supplemental.warnings
    : [];
  if (supplementalRows.length) {
    const extras = [...new Set(
      supplementalRows.flatMap((row) =>
        [row?.provider, ...(Array.isArray(row?.overlapProviders) ? row.overlapProviders : [])]
          .map(canonicalProvider)
          .filter(Boolean),
      ),
    )].sort();
    result.sources = ["ccusage", ...extras];
  }
  if (warnings.length) result.warnings = warnings;
  return result;
}

module.exports = {
  canonicalProvider,
  listPrimeSessionFiles,
  loadSupplementalUsage,
  mergeUsageReports,
  parsePrimeSession,
};
