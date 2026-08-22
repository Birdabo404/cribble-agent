"use strict";

const { safeText } = require("./safety");

const DAILY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isDailyDate(value) {
  if (typeof value !== "string" || !DAILY_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function wireName(value, field, date) {
  const cleaned = safeText(value, { maxLength: 129 });
  if (
    typeof value !== "string" ||
    cleaned !== value ||
    value.length < 1 ||
    value.length > 128
  ) {
    throw new Error(`Invalid ${field} value in ccusage data for ${date}.`);
  }
  return value;
}

function wireToken(value, field, date) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${field} value in ccusage data for ${date}.`);
  }
  return value;
}

function wireDay(row) {
  if (!Array.isArray(row.agents) || !Array.isArray(row.models)) {
    throw new Error(`Invalid agent or model labels in ccusage data for ${row.date}.`);
  }
  if (row.agents.length > 32 || row.models.length > 32) {
    throw new Error(`Too many agent or model labels in ccusage data for ${row.date}.`);
  }
  const inputTokens = wireToken(row.inputTokens, "inputTokens", row.date);
  const outputTokens = wireToken(row.outputTokens, "outputTokens", row.date);
  const cacheCreationTokens = wireToken(
    row.cacheCreationTokens,
    "cacheCreationTokens",
    row.date,
  );
  const cacheReadTokens = wireToken(row.cacheReadTokens, "cacheReadTokens", row.date);
  const totalTokens =
    inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new Error(`Token total exceeds the safe integer range for ${row.date}.`);
  }
  if (
    !Number.isFinite(row.costUsd) ||
    row.costUsd < 0 ||
    row.costUsd > 99_999_999_999_999.999999
  ) {
    throw new Error(`Invalid costUsd value in ccusage data for ${row.date}.`);
  }

  return {
    date: row.date,
    agents: row.agents.map((value) => wireName(value, "agent", row.date)),
    models: row.models.map((value) => wireName(value, "model", row.date)),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    costUsd: row.costUsd,
  };
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundCost(value) {
  return Math.round(asNumber(value) * 1_000_000) / 1_000_000;
}

function uniqueStrings(values) {
  const cleaned = (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string")
    .map((value) => safeText(value, { maxLength: 256 }))
    .filter(Boolean);
  return [...new Set(cleaned)];
}

function dailyRowsFrom(raw) {
  if (Array.isArray(raw?.daily)) return raw.daily;
  if (Array.isArray(raw?.data) && (!raw.type || raw.type === "daily")) return raw.data;
  if (Array.isArray(raw)) return raw;
  return [];
}

function normalizeDay(row) {
  const inputTokens = asNumber(row.inputTokens);
  const outputTokens = asNumber(row.outputTokens);
  const cacheCreationTokens = asNumber(row.cacheCreationTokens);
  const cacheReadTokens = asNumber(row.cacheReadTokens);
  const calculatedTotal =
    inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

  const agents = uniqueStrings([
    ...(row.metadata?.agents ?? []),
    ...(row.agent && row.agent !== "all" ? [row.agent] : []),
  ]);

  return {
    date: String(row.date ?? row.period ?? "unknown"),
    agents,
    models: uniqueStrings(row.modelsUsed ?? row.models),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    // The wire API and database derive this field from the four component
    // counts. Doing the same locally prevents a stale source summary from
    // disagreeing with the visible report.
    totalTokens: calculatedTotal,
    costUsd: roundCost(row.totalCost ?? row.costUSD ?? row.cost),
  };
}

function mergeDailyRows(rows) {
  const merged = new Map();

  for (const row of rows) {
    const existing = merged.get(row.date);
    if (!existing) {
      merged.set(row.date, { ...row, agents: [...row.agents], models: [...row.models] });
      continue;
    }

    existing.agents = uniqueStrings([...existing.agents, ...row.agents]);
    existing.models = uniqueStrings([...existing.models, ...row.models]);
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheCreationTokens += row.cacheCreationTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.totalTokens =
      existing.inputTokens +
      existing.outputTokens +
      existing.cacheCreationTokens +
      existing.cacheReadTokens;
    existing.costUsd = roundCost(existing.costUsd + row.costUsd);
  }

  return [...merged.values()];
}

function totalRows(rows) {
  const totals = rows.reduce(
    (sum, row) => {
      sum.inputTokens += row.inputTokens;
      sum.outputTokens += row.outputTokens;
      sum.cacheCreationTokens += row.cacheCreationTokens;
      sum.cacheReadTokens += row.cacheReadTokens;
      sum.totalTokens += row.totalTokens;
      sum.costUsd += row.costUsd;
      return sum;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );

  return {
    ...totals,
    costUsd: roundCost(totals.costUsd),
    cacheTokens: totals.cacheCreationTokens + totals.cacheReadTokens,
  };
}

// Keep this display snapshot stable. The terminal report intentionally owns
// range and aggregate fields that are not part of the ingest wire contract.
function buildSnapshot(raw, { days = 7, now = new Date() } = {}) {
  const daily = mergeDailyRows(dailyRowsFrom(raw).map(normalizeDay))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-days);

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    source: "ccusage",
    range: {
      startDate: daily.at(0)?.date ?? null,
      endDate: daily.at(-1)?.date ?? null,
      dayCount: daily.length,
    },
    totals: totalRows(daily),
    agents: uniqueStrings(daily.flatMap((day) => day.agents)),
    models: uniqueStrings(daily.flatMap((day) => day.models)),
    daily,
  };
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function buildWirePayload(
  snapshot,
  {
    clientId,
    timezone = localTimezone(),
    cliVersion,
    days,
  },
) {
  if (!UUID_PATTERN.test(String(clientId ?? ""))) {
    throw new Error("The Cribble client ID must be a valid UUID.");
  }
  const safeTimezone = safeText(timezone, { maxLength: 128 });
  if (!safeTimezone || safeTimezone !== timezone) {
    throw new Error("The local timezone is invalid.");
  }
  const safeCliVersion = safeText(cliVersion, { maxLength: 64 });
  if (!safeCliVersion || safeCliVersion !== cliVersion) {
    throw new Error("The Cribble CLI version is invalid.");
  }
  let canonicalGeneratedAt;
  try {
    canonicalGeneratedAt = new Date(snapshot.generatedAt).toISOString();
  } catch {
    canonicalGeneratedAt = null;
  }
  if (canonicalGeneratedAt !== snapshot.generatedAt) {
    throw new Error("The usage snapshot has an invalid generation time.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: safeTimezone }).format();
  } catch {
    throw new Error("The local timezone is invalid.");
  }

  const validDaily = snapshot.daily
    .filter((row) => isDailyDate(row.date))
    .map(wireDay);
  const daily = days === undefined ? validDaily : validDaily.slice(-days);

  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    clientId: String(clientId),
    timezone: safeTimezone,
    provenance: {
      source: "ccusage",
      cliVersion: safeCliVersion,
    },
    daily,
  };
}

function formatInteger(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value) {
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function summarizeNames(names, limit = 3) {
  if (!names.length) return "—";
  const shown = names.slice(0, limit);
  const remaining = names.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} +${remaining} more` : shown.join(", ");
}

function renderTable(rows) {
  const headers = ["Date", "Input", "Output", "Cache", "Total", "Cost"];
  const values = rows.map((row) => [
    row.date,
    formatInteger(row.inputTokens),
    formatInteger(row.outputTokens),
    formatInteger(row.cacheCreationTokens + row.cacheReadTokens),
    formatInteger(row.totalTokens),
    formatUsd(row.costUsd),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index].length)),
  );
  const line = (row) =>
    row
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join("  ");

  return [
    line(headers),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...values.map(line),
  ].join("\n");
}

function renderSnapshot(
  snapshot,
  { color = process.stdout.isTTY && !process.env.NO_COLOR } = {},
) {
  const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const title = paint("1;36", "Cribble · Token usage");

  if (!snapshot.daily.length) {
    return `${title}\n\nNo token usage found for the selected period.`;
  }

  const range =
    snapshot.range.startDate === snapshot.range.endDate
      ? snapshot.range.startDate
      : `${snapshot.range.startDate} → ${snapshot.range.endDate}`;
  const lines = [
    title,
    paint(
      "2",
      `${range} · ${snapshot.range.dayCount} usage day${snapshot.range.dayCount === 1 ? "" : "s"}`,
    ),
    "",
    `${"Total tokens".padEnd(16)}${paint("1", formatInteger(snapshot.totals.totalTokens))}`,
    `${"Input / output".padEnd(16)}${formatInteger(snapshot.totals.inputTokens)} / ${formatInteger(snapshot.totals.outputTokens)}`,
    `${"Cache tokens".padEnd(16)}${formatInteger(snapshot.totals.cacheTokens)}`,
    `${"Estimated cost".padEnd(16)}${paint("1;32", formatUsd(snapshot.totals.costUsd))}`,
    `${"Agents".padEnd(16)}${summarizeNames(snapshot.agents)}`,
    `${"Models".padEnd(16)}${summarizeNames(snapshot.models)}`,
    "",
    renderTable(snapshot.daily),
  ];

  return lines.join("\n");
}

module.exports = {
  buildSnapshot,
  buildWirePayload,
  isDailyDate,
  localTimezone,
  renderSnapshot,
};
