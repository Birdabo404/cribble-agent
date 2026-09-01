"use strict";

const { safeText } = require("./safety");

const DAILY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+/-]+$/;
const MAX_COST_USD = 99_999_999_999_999.999999;
const UNATTRIBUTED_MODELS = new Set([
  "unknown",
  "<unknown>",
  "<synthetic>",
  "ccm-translated",
  "reconstructed-unattributed",
]);
const MODEL_ALIASES = new Map([
  ["~deepseek/deepseek-v4-flash-latest", "deepseek-v4-flash"],
  ["deepseek-v4-flash:0731", "deepseek-v4-flash-0731"],
]);

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
    throw new Error(`Invalid ${field} value in collector data for ${date}.`);
  }
  return value;
}

function wireToken(value, field, date) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${field} value in collector data for ${date}.`);
  }
  return value;
}

function wireDay(row) {
  if (
    !Array.isArray(row.agents) ||
    !Array.isArray(row.models) ||
    !Array.isArray(row.agentBreakdowns) ||
    !Array.isArray(row.modelBreakdowns)
  ) {
    throw new Error(`Invalid agent or model labels in collector data for ${row.date}.`);
  }
  // Labels are display metadata; token totals are validated separately. A day
  // with unusually many models (Cursor auto mode) must not abort the sync, so
  // keep the first 32 labels instead of failing.
  const agents = row.agents.slice(0, 32);
  const models = row.models.slice(0, 32);
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
    throw new Error(`Invalid costUsd value in collector data for ${row.date}.`);
  }

  const wireBreakdown = (breakdown, field) => ({
    name: wireName(breakdown.name, field, row.date),
    inputTokens: wireToken(breakdown.inputTokens, "inputTokens", row.date),
    outputTokens: wireToken(breakdown.outputTokens, "outputTokens", row.date),
    cacheCreationTokens: wireToken(
      breakdown.cacheCreationTokens,
      "cacheCreationTokens",
      row.date,
    ),
    cacheReadTokens: wireToken(
      breakdown.cacheReadTokens,
      "cacheReadTokens",
      row.date,
    ),
  });

  const agentBreakdowns = row.agentBreakdowns
    .map((breakdown) => wireBreakdown(breakdown, "agent"));
  const modelBreakdowns = row.modelBreakdowns
    .map((breakdown) => wireBreakdown(breakdown, "model"));

  const requireCompleteBreakdown = (breakdowns, field) => {
    for (const tokenField of [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
    ]) {
      const attributed = breakdowns.reduce(
        (sum, breakdown) => sum + breakdown[tokenField],
        0,
      );
      if (attributed !== row[tokenField]) {
        throw new Error(
          `Incomplete ${field} token attribution in collector data for ${row.date}.`,
        );
      }
    }
  };
  requireCompleteBreakdown(agentBreakdowns, "agent");
  requireCompleteBreakdown(modelBreakdowns, "model");

  return {
    date: row.date,
    agents: agents.map((value) => wireName(value, "agent", row.date)),
    models: models.map((value) => wireName(value, "model", row.date)),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    costUsd: row.costUsd,
    agentBreakdowns,
    modelBreakdowns,
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

function isAttributedModel(value) {
  return !UNATTRIBUTED_MODELS.has(String(value).trim().toLowerCase());
}

function canonicalModel(value) {
  const model = safeText(value, { maxLength: 256 });
  return MODEL_ALIASES.get(model.toLowerCase()) ?? model;
}

function tokenBreakdown(value, name, date) {
  if (!value || typeof value !== "object" || !name) return null;
  const token = (field) => {
    const count = value[field] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid ${field} value in collector data for ${date}.`);
    }
    return count;
  };
  const result = {
    name,
    inputTokens: token("inputTokens"),
    outputTokens: token("outputTokens"),
    cacheCreationTokens: token("cacheCreationTokens"),
    cacheReadTokens: token("cacheReadTokens"),
  };
  const totalTokens = breakdownTokens(result);
  return totalTokens > 0 ? { ...result, totalTokens } : null;
}

function breakdownTokens(value) {
  return value.inputTokens +
    value.outputTokens +
    value.cacheCreationTokens +
    value.cacheReadTokens;
}

function mergeBreakdowns(...groups) {
  const merged = new Map();
  for (const breakdown of groups.flat()) {
    if (!breakdown) continue;
    const existing = merged.get(breakdown.name);
    if (!existing) {
      merged.set(breakdown.name, { ...breakdown });
      continue;
    }
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
    ]) {
      existing[field] += breakdown[field];
    }
    existing.totalTokens = breakdownTokens(existing);
  }
  return [...merged.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens || left.name.localeCompare(right.name),
  );
}

function orderModels(models, tokensByModel) {
  return models
    .map((model, sourceIndex) => ({
      model,
      sourceIndex,
      tokens: tokensByModel.get(model) ?? 0,
    }))
    .sort((left, right) => right.tokens - left.tokens || left.sourceIndex - right.sourceIndex)
    .map(({ model }) => model);
}

// ccusage's modelsUsed list is alphabetical, not a usage ranking. Keep the
// compact label list ordered by the exact model breakdown used on the wire.
function modelsByUsage(row, date, total) {
  const rawModels = uniqueStrings(
    uniqueStrings(row.modelsUsed ?? row.models).map(canonicalModel),
  )
    .filter(isAttributedModel);
  let breakdowns = (Array.isArray(row.modelBreakdowns) ? row.modelBreakdowns : [])
    .map((breakdown) => {
      const model = canonicalModel(breakdown?.modelName ?? breakdown?.name);
      return isAttributedModel(model)
        ? tokenBreakdown(breakdown, model, date)
        : null;
    })
    .filter(Boolean);
  if (!breakdowns.length && rawModels.length === 1 && total.totalTokens > 0) {
    breakdowns = [tokenBreakdown(total, rawModels[0], date)].filter(Boolean);
  }
  breakdowns = mergeBreakdowns(breakdowns);
  const modelTokenTotals = new Map(
    breakdowns.map((breakdown) => [breakdown.name, breakdown.totalTokens]),
  );
  // ccusage's positive modelBreakdowns are the attribution authority. Its
  // modelsUsed metadata can include zero-token transport or gateway labels.
  const models = breakdowns.length
    ? breakdowns.map((breakdown) => breakdown.name)
    : [];
  return {
    models: orderModels(models, modelTokenTotals),
    modelBreakdowns: breakdowns,
  };
}

function dailyRowsFrom(raw) {
  if (Array.isArray(raw?.daily)) return raw.daily;
  if (Array.isArray(raw?.data) && (!raw.type || raw.type === "daily")) return raw.data;
  if (Array.isArray(raw)) return raw;
  return [];
}

function normalizeDay(row) {
  const date = String(row.date ?? row.period ?? "unknown");
  const sourceToken = (value, field) => {
    if (value == null) return 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${field} value in collector data for ${date}.`);
    }
    return value;
  };
  const inputTokens = sourceToken(row.inputTokens, "inputTokens");
  const outputTokens = sourceToken(row.outputTokens, "outputTokens");
  const cacheCreationTokens = sourceToken(row.cacheCreationTokens, "cacheCreationTokens");
  const cacheReadTokens = sourceToken(row.cacheReadTokens, "cacheReadTokens");
  const calculatedTotal =
    inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isSafeInteger(calculatedTotal)) {
    throw new Error(`Token total exceeds the safe integer range for ${date}.`);
  }

  const agents = uniqueStrings([
    ...(row.metadata?.agents ?? []),
    ...(row.agent && row.agent !== "all" ? [row.agent] : []),
  ]);

  let agentBreakdowns = (Array.isArray(row.agents) ? row.agents : [])
    .filter((breakdown) => breakdown && typeof breakdown === "object")
    .map((breakdown) => {
      const agent = safeText(breakdown?.agent ?? breakdown?.name, { maxLength: 256 });
      return tokenBreakdown(breakdown, agent, date);
    })
    .filter(Boolean);
  if (!agentBreakdowns.length && agents.length === 1 && calculatedTotal > 0) {
    agentBreakdowns = [tokenBreakdown({
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    }, agents[0], date)].filter(Boolean);
  }
  const nestedModelBreakdowns = agentBreakdowns.length && Array.isArray(row.agents)
    ? row.agents.flatMap((agent) =>
        (Array.isArray(agent?.modelBreakdowns) ? agent.modelBreakdowns : []).map(
          (breakdown) => {
            const model = canonicalModel(breakdown?.modelName ?? breakdown?.name);
            return isAttributedModel(model)
              ? tokenBreakdown(breakdown, model, date)
              : null;
          },
        ),
      ).filter(Boolean)
    : [];
  const total = {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: calculatedTotal,
  };
  const modelUsage = modelsByUsage(row, date, total);
  const modelBreakdowns = modelUsage.modelBreakdowns.length
    ? modelUsage.modelBreakdowns
    : mergeBreakdowns(nestedModelBreakdowns);
  const modelOrder = uniqueStrings([
    ...modelBreakdowns.map((breakdown) => breakdown.name),
    ...modelUsage.models,
  ]);
  const models = orderModels(
    modelOrder,
    new Map(
      modelBreakdowns.map((breakdown) => [breakdown.name, breakdown.totalTokens]),
    ),
  );
  const rawCost = row.totalCost ?? row.costUSD ?? row.cost ?? 0;
  if (!Number.isFinite(rawCost) || rawCost < 0 || rawCost > MAX_COST_USD) {
    throw new Error(`Invalid costUsd value in collector data for ${date}.`);
  }

  return {
    date,
    agents: agentBreakdowns.map((breakdown) => breakdown.name),
    models,
    agentBreakdowns,
    modelBreakdowns,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    // The wire API and database derive this field from the four component
    // counts. Doing the same locally prevents a stale source summary from
    // disagreeing with the visible report.
    totalTokens: calculatedTotal,
    costUsd: roundCost(rawCost),
  };
}

function mergeDailyRows(rows) {
  const merged = new Map();

  for (const row of rows) {
    const existing = merged.get(row.date);
    if (!existing) {
      merged.set(row.date, {
        ...row,
        agents: [...row.agents],
        models: [...row.models],
        agentBreakdowns: row.agentBreakdowns.map((breakdown) => ({ ...breakdown })),
        modelBreakdowns: row.modelBreakdowns.map((breakdown) => ({ ...breakdown })),
      });
      continue;
    }

    existing.agents = uniqueStrings([...existing.agents, ...row.agents]);
    existing.agentBreakdowns = mergeBreakdowns(
      existing.agentBreakdowns,
      row.agentBreakdowns,
    );
    existing.modelBreakdowns = mergeBreakdowns(
      existing.modelBreakdowns,
      row.modelBreakdowns,
    );
    const modelOrder = uniqueStrings([
      ...existing.models,
      ...row.models,
      ...existing.modelBreakdowns.map((breakdown) => breakdown.name),
    ]);
    existing.models = orderModels(
      modelOrder,
      new Map(
        existing.modelBreakdowns.map((breakdown) => [
          breakdown.name,
          breakdown.totalTokens,
        ]),
      ),
    );
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheCreationTokens += row.cacheCreationTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.totalTokens =
      existing.inputTokens +
      existing.outputTokens +
      existing.cacheCreationTokens +
      existing.cacheReadTokens;
    if (!Number.isSafeInteger(existing.totalTokens)) {
      throw new Error(`Token total exceeds the safe integer range for ${row.date}.`);
    }
    existing.costUsd = roundCost(existing.costUsd + row.costUsd);
    if (!Number.isFinite(existing.costUsd) || existing.costUsd > MAX_COST_USD) {
      throw new Error(`Invalid costUsd value in collector data for ${row.date}.`);
    }
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
      if (!Number.isSafeInteger(sum.totalTokens)) {
        throw new Error("Token totals exceed the safe integer range for the selected period.");
      }
      if (!Number.isFinite(sum.costUsd) || sum.costUsd > MAX_COST_USD) {
        throw new Error("Estimated cost exceeds the supported range for the selected period.");
      }
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
  const daily = mergeDailyRows(
    dailyRowsFrom(raw)
      .filter((row) => isDailyDate(String(row?.date ?? row?.period ?? "")))
      .map(normalizeDay),
  )
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-days);
  const warnings = uniqueStrings(raw?.warnings).slice(0, 10);
  const source =
    Array.isArray(raw?.sources) && raw.sources.some((value) => value !== "ccusage")
      ? "cribble-agent"
      : "ccusage";

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    source,
    ...(typeof raw?.timezone === "string" ? { timezone: raw.timezone } : {}),
    range: {
      startDate: daily.at(0)?.date ?? null,
      endDate: daily.at(-1)?.date ?? null,
      dayCount: daily.length,
    },
    totals: totalRows(daily),
    agents: uniqueStrings(daily.flatMap((day) => day.agents)),
    models: uniqueStrings(daily.flatMap((day) => day.models)),
    ...(warnings.length ? { warnings } : {}),
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
    timezone,
    cliVersion,
    days,
  },
) {
  if (!UUID_PATTERN.test(String(clientId ?? ""))) {
    throw new Error("The Cribble client ID must be a valid UUID.");
  }
  const resolvedTimezone = timezone ?? snapshot.timezone ?? localTimezone();
  const safeTimezone = safeText(resolvedTimezone, { maxLength: 64 });
  if (
    !safeTimezone ||
    safeTimezone !== resolvedTimezone ||
    !TIMEZONE_PATTERN.test(safeTimezone)
  ) {
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
      // Keep the v1 server contract stable: ccusage remains the authoritative
      // primary collector even when Cribble adds metadata-only supplements.
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
  { color = process.stdout.isTTY && process.env.NO_COLOR === undefined } = {},
) {
  const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const title = paint("1;38;2;208;254;29", "Cribble · Token usage");
  const warningLines = (snapshot.warnings ?? []).map(
    (warning) => paint("33", `Warning: ${warning}`),
  );

  if (!snapshot.daily.length) {
    return [
      title,
      "",
      "No token usage found for the selected period.",
      ...(warningLines.length ? ["", ...warningLines] : []),
    ].join("\n");
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
    ...(warningLines.length ? ["", ...warningLines] : []),
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
