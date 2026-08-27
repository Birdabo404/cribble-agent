"use strict";

const { execFileSync } = require("node:child_process");
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
const { dirname, isAbsolute, join, resolve, win32 } = require("node:path");
const { collectionTimeoutMs, hermesHomeValue } = require("./collector-options");
const { configDirectory } = require("./config-path");
const { safeText } = require("./safety");
const { loadSupplementalUsage, mergeUsageReports } = require("./supplemental");
const { usageHomes, wslMode } = require("./wsl");

const COLLECTOR_ENV_KEYS = Object.freeze([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PROGRAMDATA",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

function collectorEnvironment(env) {
  const safeEnv = {};
  for (const key of COLLECTOR_ENV_KEYS) {
    if (key === "HERMES_HOME") {
      const hermesHome = hermesHomeValue(env?.[key]);
      if (hermesHome !== undefined) safeEnv[key] = hermesHome;
    } else if (typeof env?.[key] === "string" && env[key]) {
      safeEnv[key] = env[key];
    }
  }
  // JSON collection must not emit ANSI formatting. More importantly, the
  // child never inherits API keys, cloud credentials, NODE_OPTIONS, or other
  // unrelated secrets from the parent Cribble process.
  safeEnv.NO_COLOR = "1";
  return safeEnv;
}

function collectionTimezone(env = process.env, configured) {
  const candidates = [
    configured,
    env?.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate.trim() }).format();
      return candidate.trim();
    } catch {
      // Try the next canonical timezone candidate.
    }
  }
  return "UTC";
}

function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function collectionSince({ days, now = new Date(), timezone }) {
  if (days === undefined || days === null) return null;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be a whole number between 1 and 365.");
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) {
    throw new Error("Could not determine the ccusage collection date window.");
  }
  const resolvedTimezone = collectionTimezone({}, timezone);
  const [year, month, day] = dateInTimezone(current, resolvedTimezone)
    .split("-")
    .map(Number);
  return new Date(Date.UTC(year, month - 1, day - (days - 1)))
    .toISOString()
    .slice(0, 10);
}

function resolveBundledBinary(
  baseDirectory,
  {
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    requireResolveFn = require.resolve,
  } = {},
) {
  try {
    // npm may hoist the dependency beside cribble-agent instead of nesting it
    // inside the package. Always resolve ccusage's real JavaScript entry point:
    // on Windows the extensionless node_modules/.bin/ccusage file is a POSIX
    // shell shim and cannot be executed by node.exe.
    const packagePath = requireResolveFn("ccusage/package.json", {
      paths: [baseDirectory],
    });
    const packageJson = JSON.parse(readFileSyncFn(packagePath, "utf8"));
    const relativeBinary =
      typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.ccusage;
    const resolvedBinary = relativeBinary
      ? resolve(dirname(packagePath), relativeBinary)
      : null;
    if (resolvedBinary && existsSyncFn(resolvedBinary)) return resolvedBinary;
  } catch {
    // Fall through to the single actionable installation error below.
  }

  throw new Error(
    "The bundled ccusage executable is missing. Run `npm install` in the cribble-agent directory, then try again.",
  );
}

function loadCcusage(
  env = process.env,
  {
    baseDirectory = join(__dirname, ".."),
    execFileSyncFn = execFileSync,
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    requireResolveFn = require.resolve,
    nodePath = process.execPath,
    days,
    hermesHome,
    now = new Date(),
    timezone,
    timeoutMs,
  } = {},
) {
  const resolvedHermesHome = hermesHomeValue(hermesHome ?? env?.HERMES_HOME);
  const collectorEnv = { ...env, HERMES_HOME: resolvedHermesHome };
  const resolvedTimeoutMs = collectionTimeoutMs(collectorEnv, timeoutMs);
  const configuredBinary = env.CCUSAGE_BIN;
  if (configuredBinary && !isAbsolute(configuredBinary)) {
    throw new Error("CCUSAGE_BIN must be an absolute executable path.");
  }
  const bundledBinary = configuredBinary
    ? null
    : resolveBundledBinary(baseDirectory, {
        existsSyncFn,
        readFileSyncFn,
        requireResolveFn,
      });
  const command = configuredBinary || nodePath;
  const timezoneArgs = timezone ? ["--timezone", timezone] : [];
  const since = collectionSince({ days, now, timezone });
  const sinceArgs = since ? ["--since", since] : [];
  const args = configuredBinary
    ? ["daily", "--json", ...sinceArgs, ...timezoneArgs]
    : [bundledBinary, "daily", "--json", ...sinceArgs, ...timezoneArgs];

  try {
    // launchd starts with a minimal PATH. Invoke the bundled JavaScript entry
    // through this process's absolute Node path instead of its /usr/bin/env
    // shebang so scheduled collection works outside an interactive shell.
    const raw = execFileSyncFn(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: resolvedTimeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      env: collectorEnvironment(collectorEnv),
    });
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("ccusage returned output that was not valid JSON.");
    }
    if (error?.code === "ETIMEDOUT") {
      throw new Error(
        `ccusage collection timed out after ${resolvedTimeoutMs} ms. Increase CRIBBLE_CCUSAGE_TIMEOUT_MS and run \`cribble start\` again if background sync uses the same large history.`,
      );
    }
    const detail = safeText(error.stderr ?? error.message, { maxLength: 300 });
    throw new Error(`Could not read ccusage data${detail ? `: ${detail}` : "."}`);
  }
}

function collectorScopeEnvironment(env, { home, scope }, platform = process.platform) {
  if (scope === "native") return env;
  const pathApi = platform === "win32" ? win32 : { join };
  return {
    ...env,
    APPDATA: undefined,
    CLAUDE_CONFIG_DIR: pathApi.join(home, ".claude"),
    CODEX_HOME: pathApi.join(home, ".codex"),
    HOME: home,
    LOCALAPPDATA: undefined,
    USERPROFILE: home,
  };
}

function reportHasDailyUsage(report) {
  if (Array.isArray(report?.daily)) return report.daily.length > 0;
  if (Array.isArray(report?.data) && (!report.type || report.type === "daily")) {
    return report.data.length > 0;
  }
  return Array.isArray(report) && report.length > 0;
}

function isMissingCcusageScope(error) {
  return /No valid Claude data directories found in CLAUDE_CONFIG_DIR/i.test(
    String(error?.message ?? ""),
  );
}

function loadCcusageHomes(homes, env, options, platform) {
  const reports = [];
  const errors = [];
  for (const home of homes) {
    try {
      reports.push(loadCcusage(
        collectorScopeEnvironment(env, home, platform),
        options,
      ));
    } catch (error) {
      errors.push(error);
    }
  }
  return { reports, errors };
}

function windowsScopePath(
  env = process.env,
  homeDirectory = homedir(),
) {
  return win32.join(
    configDirectory({ homeDirectory, env, platform: "win32" }),
    "usage-scope",
  );
}

function readWindowsScope(env, options = {}) {
  if (options.readSelectedScopeFn) return options.readSelectedScopeFn();
  const filePath =
    options.scopeFilePath ?? windowsScopePath(env, options.homeDirectory);
  if (!existsSync(filePath)) return null;
  const scope = readFileSync(filePath, "utf8").trim();
  if (scope === "native" || scope.startsWith("wsl:")) return scope;
  throw new Error(
    `The persisted Windows usage scope at ${filePath} is invalid. Remove it and collect again.`,
  );
}

function writeWindowsScope(scope, env, options = {}) {
  if (options.writeSelectedScopeFn) {
    options.writeSelectedScopeFn(scope);
    return;
  }
  const filePath =
    options.scopeFilePath ?? windowsScopePath(env, options.homeDirectory);
  const directory = win32.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${scope}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function loadUsage(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const timezone = collectionTimezone(env, options.timezone);
  const collectionOptions = { ...options, timezone };
  const homes = (options.usageHomesFn ?? usageHomes)({
    platform,
    env,
    homeDirectory: options.homeDirectory,
    execFileSyncFn: options.wslExecFileSyncFn,
    existsSyncFn: options.existsSyncFn,
  });
  const mode = platform === "win32" ? wslMode(env) : "native-only";
  if (mode === "both") {
    throw new Error(
      "CRIBBLE_WSL_MODE=both is disabled because aggregated ccusage reports cannot be record-deduplicated safely. Use wsl-first or native-first.",
    );
  }

  let reports;
  let selectedScope = null;
  if (platform === "win32" && ["wsl-first", "native-first"].includes(mode)) {
    const preferWsl = mode === "wsl-first";
    const orderedHomes = [...homes].sort((left, right) => {
      const leftPreferred = preferWsl
        ? left.scope.startsWith("wsl:")
        : left.scope === "native";
      const rightPreferred = preferWsl
        ? right.scope.startsWith("wsl:")
        : right.scope === "native";
      return Number(rightPreferred) - Number(leftPreferred);
    });
    const persistSelection = options.usageHomesFn == null ||
      options.readSelectedScopeFn != null ||
      options.writeSelectedScopeFn != null ||
      options.scopeFilePath != null;
    const persistedScope = persistSelection
      ? readWindowsScope(env, options)
      : null;
    if (persistedScope) {
      const selectedHome = orderedHomes.find(
        ({ scope }) => scope === persistedScope,
      );
      if (!selectedHome) {
        throw new Error(
          `The persisted Windows usage scope ${persistedScope} is unavailable. Restore it or set CRIBBLE_WSL_MODE explicitly.`,
        );
      }
      const selected = loadCcusageHomes(
        [selectedHome],
        env,
        collectionOptions,
        platform,
      );
      if (selected.errors.length) throw selected.errors[0];
      reports = selected.reports;
      selectedScope = persistedScope;
    } else {
      reports = [];
      for (const home of orderedHomes) {
        const candidate = loadCcusageHomes(
          [home],
          env,
          collectionOptions,
          platform,
        );
        if (candidate.errors.length) {
          if (candidate.errors.every(isMissingCcusageScope)) continue;
          throw candidate.errors[0];
        }
        reports = candidate.reports;
        if (candidate.reports.some(reportHasDailyUsage)) {
          selectedScope = home.scope;
          if (persistSelection) writeWindowsScope(home.scope, env, options);
          break;
        }
      }
    }
  } else if (platform === "win32") {
    reports = [];
    for (const home of homes) {
      const candidate = loadCcusageHomes(
        [home],
        env,
        collectionOptions,
        platform,
      );
      if (candidate.errors.length) throw candidate.errors[0];
      reports = candidate.reports;
      if (candidate.reports.some(reportHasDailyUsage)) {
        selectedScope = home.scope;
        break;
      }
    }
  } else {
    const collected = loadCcusageHomes(homes, env, collectionOptions, platform);
    if (collected.errors.length) throw collected.errors[0];
    reports = collected.reports;
  }

  let supplemental;
  try {
    supplemental = (options.loadSupplementalUsageFn ?? loadSupplementalUsage)(
      env,
      { ...collectionOptions, platform, homes },
    );
  } catch (error) {
    // Daily ingestion replaces prior values for the same client and date.
    // Uploading only ccusage after a Prime or Cursor scan failure would
    // therefore erase previously complete supplemental totals.
    throw new Error(
      `Could not read complete supplemental usage: ${safeText(error?.message, {
        fallback: "unknown collector error",
        maxLength: 200,
      })}`,
    );
  }
  const merged = mergeUsageReports(reports, supplemental);
  merged.timezone = timezone;
  if (selectedScope) merged.scope = selectedScope;
  return merged;
}

module.exports = {
  collectorEnvironment,
  collectorScopeEnvironment,
  collectionSince,
  collectionTimezone,
  loadCcusage,
  loadUsage,
  resolveBundledBinary,
  windowsScopePath,
};
