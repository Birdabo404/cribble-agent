"use strict";

const DEFAULT_CCUSAGE_TIMEOUT_MS = 120_000;
const MIN_CCUSAGE_TIMEOUT_MS = 1_000;
const MAX_CCUSAGE_TIMEOUT_MS = 15 * 60_000;

function collectionTimeoutMs(env = process.env, configured) {
  const value = configured ?? env?.CRIBBLE_CCUSAGE_TIMEOUT_MS;
  if (value === undefined || value === null || value === "") {
    return DEFAULT_CCUSAGE_TIMEOUT_MS;
  }
  const timeout = Number(value);
  if (
    !Number.isInteger(timeout) ||
    timeout < MIN_CCUSAGE_TIMEOUT_MS ||
    timeout > MAX_CCUSAGE_TIMEOUT_MS
  ) {
    throw new Error(
      `CRIBBLE_CCUSAGE_TIMEOUT_MS must be a whole number between ${MIN_CCUSAGE_TIMEOUT_MS} and ${MAX_CCUSAGE_TIMEOUT_MS}.`,
    );
  }
  return timeout;
}

function hermesHomeValue(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (/\0|\r|\n/.test(value) || value.length > 8_192) {
    throw new Error("HERMES_HOME contains invalid characters or is unexpectedly long.");
  }
  return value;
}

function capturedCollectorOptions(env = process.env) {
  const hermesHome = hermesHomeValue(env?.HERMES_HOME);
  const timeoutValue = env?.CRIBBLE_CCUSAGE_TIMEOUT_MS;
  const ccusageTimeoutMs =
    timeoutValue === undefined || timeoutValue === null || timeoutValue === ""
      ? undefined
      : collectionTimeoutMs(env);
  return {
    ...(typeof env?.CRIBBLE_CLAUDE_CONFIG_DIRS === "string" && env.CRIBBLE_CLAUDE_CONFIG_DIRS.trim()
      ? { claudeConfigDirs: env.CRIBBLE_CLAUDE_CONFIG_DIRS.trim() }
      : {}),
    ...(hermesHome === undefined ? {} : { hermesHome }),
    ...(ccusageTimeoutMs === undefined ? {} : { ccusageTimeoutMs }),
  };
}

function collectorCliArguments({ hermesHome, ccusageTimeoutMs } = {}) {
  const resolvedHermesHome = hermesHomeValue(hermesHome);
  const resolvedTimeout =
    ccusageTimeoutMs === undefined || ccusageTimeoutMs === null
      ? undefined
      : collectionTimeoutMs({}, ccusageTimeoutMs);
  return [
    ...(resolvedHermesHome === undefined
      ? []
      : ["--hermes-home", resolvedHermesHome]),
    ...(resolvedTimeout === undefined
      ? []
      : ["--ccusage-timeout-ms", String(resolvedTimeout)]),
  ];
}

module.exports = {
  DEFAULT_CCUSAGE_TIMEOUT_MS,
  MAX_CCUSAGE_TIMEOUT_MS,
  MIN_CCUSAGE_TIMEOUT_MS,
  capturedCollectorOptions,
  collectionTimeoutMs,
  collectorCliArguments,
  hermesHomeValue,
};
