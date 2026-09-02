"use strict";

const { join } = require("node:path");
const { hermesHomeValue } = require("./collector-options");
const { safeText } = require("./safety");
const { readSqliteJsonRows } = require("./sqlite-reader");

const PROVIDER_ROUTE_SQL = `
  SELECT
    model,
    billing_provider AS provider,
    billing_base_url AS baseUrl,
    SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS totalTokens
  FROM session_model_usage
  GROUP BY model, billing_provider, billing_base_url
`;

function providerFromRow(row) {
  const explicit = safeText(row?.provider, { maxLength: 128 })?.toLowerCase();
  if (explicit) return explicit;
  let hostname;
  try {
    hostname = new URL(String(row?.baseUrl ?? "")).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")) return "openrouter";
  if (hostname === "nousresearch.com" || hostname.endsWith(".nousresearch.com")) return "nous";
  return null;
}

function hermesRoots(env = process.env, homeDirectory = env?.HOME) {
  const configured = hermesHomeValue(env?.HERMES_HOME);
  const roots = configured
    ? configured.split(",").map((value) => value.trim()).filter(Boolean)
    : typeof homeDirectory === "string" && homeDirectory
      ? [join(homeDirectory, ".hermes")]
      : [];
  return [...new Set(roots)];
}

function loadHermesProviderRoutes(env = process.env, options = {}) {
  const readRowsFn = options.readSqliteJsonRowsFn ?? readSqliteJsonRows;
  const totals = new Map();
  for (const root of hermesRoots(env, options.homeDirectory)) {
    const rows = readRowsFn(join(root, "state.db"), PROVIDER_ROUTE_SQL, {
      label: "Hermes usage",
      throwOnReadFailure: false,
    });
    for (const row of rows) {
      const model = safeText(row?.model, { maxLength: 256 });
      const provider = providerFromRow(row);
      const totalTokens = Number(row?.totalTokens ?? 0);
      if (!model || !provider || !Number.isFinite(totalTokens) || totalTokens <= 0) continue;
      const key = `${provider}\0${model}`;
      totals.set(key, (totals.get(key) ?? 0) + totalTokens);
    }
  }
  return [...totals.entries()]
    .map(([key, totalTokens]) => {
      const [provider, model] = key.split("\0");
      return { provider, model, totalTokens };
    })
    .sort((left, right) => left.model.localeCompare(right.model) || left.provider.localeCompare(right.provider));
}

module.exports = { PROVIDER_ROUTE_SQL, hermesRoots, loadHermesProviderRoutes, providerFromRow };
