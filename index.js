#!/usr/bin/env node

"use strict";

const { version: packageVersion } = require("./package.json");
const {
  backgroundStatus,
  installBackground,
  pauseBackground,
  resumeBackground,
  uninstallBackground,
} = require("./lib/background");
const {
  keychainHasApiKey,
  promptAndStoreApiKey,
  readKeychainApiKey,
  removeKeychainApiKey,
  resolveApiKey,
} = require("./lib/keychain");
const { getOrCreateClientId, clientIdPath } = require("./lib/identity");
const {
  SyncRequestError,
  parseEndpoint,
  postSnapshot,
  postSnapshotWithRetry,
  safeEndpointLabel,
} = require("./lib/http");
const { loadUsage } = require("./lib/source");
const {
  SyncAlreadyRunningError,
  mergeSyncState,
  readSyncState,
  withSyncLock,
} = require("./lib/state");
const {
  buildSnapshot,
  buildWirePayload: buildPayload,
  localTimezone,
  renderSnapshot,
} = require("./lib/usage");
const { safeText } = require("./lib/safety");

const DEFAULT_DAYS = 7;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_SYNC_ENDPOINT = "https://cribble.dev/api/agent/usage";

function buildWirePayload(snapshot, options) {
  return buildPayload(snapshot, { cliVersion: packageVersion, ...options });
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} needs a value.`);
  return value;
}

function parseWholeNumber(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${option} needs a whole-number value.`);
  return number;
}

function parseArgs(argv) {
  const args = [...argv];
  let command = "show";

  if (args[0] && !args[0].startsWith("-")) command = args.shift();
  if (!["show", "sync", "status", "auth", "background", "help"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  let action;
  if (["auth", "background"].includes(command)) {
    action = args[0] && !args[0].startsWith("-") ? args.shift() : "status";
    const allowed =
      command === "auth"
        ? ["set", "status", "remove"]
        : ["install", "status", "pause", "resume", "uninstall"];
    if (!allowed.includes(action)) throw new Error(`Unknown ${command} action: ${action}`);
  }

  const options = {
    command,
    action,
    days: DEFAULT_DAYS,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    endpoint: undefined,
    dryRun: false,
    background: false,
    json: false,
    color: undefined,
  };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--json") {
      options.json = true;
      seen.add("json");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
      seen.add("dry-run");
    } else if (arg === "--background") {
      options.background = true;
      seen.add("background");
    } else if (arg === "--no-color") {
      options.color = false;
      seen.add("color");
    } else if (arg === "--days") {
      seen.add("days");
      options.days = parseWholeNumber(readOptionValue(args, index, "--days"), "--days");
      index += 1;
    } else if (arg.startsWith("--days=")) {
      seen.add("days");
      options.days = parseWholeNumber(arg.slice(7), "--days");
    } else if (arg === "--interval") {
      seen.add("interval");
      options.intervalMinutes = parseWholeNumber(
        readOptionValue(args, index, "--interval"),
        "--interval",
      );
      index += 1;
    } else if (arg.startsWith("--interval=")) {
      seen.add("interval");
      options.intervalMinutes = parseWholeNumber(arg.slice(11), "--interval");
    } else if (arg === "--endpoint") {
      seen.add("endpoint");
      options.endpoint = readOptionValue(args, index, "--endpoint");
      index += 1;
    } else if (arg.startsWith("--endpoint=")) {
      seen.add("endpoint");
      options.endpoint = arg.slice(11);
      if (!options.endpoint) throw new Error("--endpoint needs a value.");
    } else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.days < 1 || options.days > 365) {
    throw new Error("--days must be a whole number between 1 and 365.");
  }
  if (options.dryRun && command !== "sync") {
    throw new Error("--dry-run can only be used with sync.");
  }
  if (options.background && command !== "sync") {
    throw new Error("--background is reserved for scheduled sync runs.");
  }
  if (options.json && command !== "show") {
    throw new Error("--json can only be used with show.");
  }
  if (options.color !== undefined && command !== "show") {
    throw new Error("--no-color can only be used with show.");
  }
  if (seen.has("days") && !["show", "sync"].includes(command)) {
    if (command !== "background" || action !== "install") {
      throw new Error("--days can only be used with show, sync, or background install.");
    }
  }
  if (seen.has("interval") && (command !== "background" || action !== "install")) {
    throw new Error("--interval can only be used with background install.");
  }
  if (
    seen.has("endpoint") &&
    command !== "sync" &&
    (command !== "background" || action !== "install")
  ) {
    throw new Error("--endpoint can only be used with sync or background install.");
  }

  return options;
}

function usage() {
  return `Cribble token tracker

Usage:
  cribble [show] [--days 7] [--json]
  cribble sync [--endpoint URL] [--days 7] [--dry-run]
  cribble status
  cribble auth <set|status|remove>
  cribble background <install|status|pause|resume|uninstall> [options]

Background install options:
  --interval N   Sync every 5, 10, 15, 20, 30, or 60 minutes (default: 15)
  --days N       Sync the latest N usage days each run (default: 7)
  --endpoint URL Override the production endpoint for scheduled sync

General options:
  --days N       Keep the latest N usage days (default: 7)
  --json         Print the local display snapshot as JSON
  --endpoint URL Override CRIBBLE_SYNC_URL for this sync
  --dry-run      Print the wire payload without saving status or sending it
  --no-color     Disable terminal colors
  -h, --help     Show this help

Environment:
  CRIBBLE_SYNC_URL   Backend endpoint used by manual sync
  CRIBBLE_API_KEY    Explicit development/CI override for the Keychain key
  CCUSAGE_BIN        Optional path to a ccusage executable

Background sync is opt-in and macOS-only. Run \`cribble auth set\` before
\`cribble background install\`. The API key is never written to the LaunchAgent.`;
}

function asIso(nowFn) {
  return nowFn().toISOString();
}

function syncCounts(body, { clientId, dayCount } = {}) {
  if (!body || typeof body !== "object") return null;
  const values = [body.inserted, body.replaced, body.stale];
  if (!values.every((value) => Number.isInteger(value) && value >= 0)) return null;
  if (clientId !== undefined && body.clientId !== clientId) return null;
  if (dayCount !== undefined && values.reduce((sum, value) => sum + value, 0) !== dayCount) {
    return null;
  }
  return { inserted: body.inserted, replaced: body.replaced, stale: body.stale };
}

function renderStatus({ state, credential, service }) {
  const statusValue = (value, fallback = "—") =>
    safeText(value, { fallback, maxLength: 300 });
  const lines = [
    "Cribble · Sync status",
    "",
    `Credential      ${statusValue(credential)}`,
    `Background      ${statusValue(service)}`,
  ];

  if (!state) {
    lines.push("Last sync       never");
    return lines.join("\n");
  }

  lines.push(`Last attempt    ${statusValue(state.lastAttemptAt)}`);
  lines.push(`Last success    ${statusValue(state.lastSuccessAt, "never")}`);
  if (state.lastResult) {
    lines.push(
      `Last result     ${statusValue(state.lastResult.inserted, "0")} inserted, ${statusValue(state.lastResult.replaced, "0")} replaced, ${statusValue(state.lastResult.stale, "0")} unchanged`,
    );
  }
  if (state.lastError) lines.push(`Last error      ${statusValue(state.lastError)}`);
  return lines.join("\n");
}

async function main(
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const deps = {
    backgroundStatusFn: backgroundStatus,
    getClientIdFn: getOrCreateClientId,
    installBackgroundFn: installBackground,
    keychainHasApiKeyFn: keychainHasApiKey,
    loadUsageFn: loadUsage,
    mergeSyncStateFn: mergeSyncState,
    nowFn: () => new Date(),
    pauseBackgroundFn: pauseBackground,
    postSnapshotWithRetryFn: postSnapshotWithRetry,
    promptAndStoreApiKeyFn: promptAndStoreApiKey,
    readKeychainApiKeyFn: readKeychainApiKey,
    readSyncStateFn: readSyncState,
    removeKeychainApiKeyFn: removeKeychainApiKey,
    resolveApiKeyFn: resolveApiKey,
    resumeBackgroundFn: resumeBackground,
    timezoneFn: localTimezone,
    uninstallBackgroundFn: uninstallBackground,
    withSyncLockFn: withSyncLock,
    log: console.log,
    ...dependencies,
  };
  const options = parseArgs(argv);

  if (options.command === "help") {
    deps.log(usage());
    return;
  }

  if (options.command === "auth") {
    if (options.action === "set") {
      deps.promptAndStoreApiKeyFn();
      try {
        const stored = deps.readKeychainApiKeyFn();
        if (!stored) throw new Error("No API key was saved.");
      } catch (error) {
        try {
          deps.removeKeychainApiKeyFn();
        } catch {
          throw new Error(
            `${safeText(error?.message, { fallback: "The stored API key is invalid." })} Remove it with \`cribble auth remove\` before trying again.`,
          );
        }
        throw error;
      }
      deps.log("Cribble API key saved securely in macOS Keychain.");
      return;
    }
    if (options.action === "remove") {
      let activeBackground = false;
      try {
        const service = deps.backgroundStatusFn();
        activeBackground = service.installed && !service.disabled;
      } catch {
        // Key removal remains usable on non-macOS test/development systems
        // where background-service inspection is unavailable.
      }
      if (activeBackground) {
        throw new Error(
          "Pause or uninstall background sync before removing its Keychain API key.",
        );
      }
      const removed = deps.removeKeychainApiKeyFn();
      deps.log(removed ? "Cribble API key removed from Keychain." : "No Keychain key was stored.");
      return;
    }
    if (!deps.keychainHasApiKeyFn()) {
      deps.log("No Cribble API key is configured. Run `cribble auth set`.");
      return;
    }
    if (!deps.readKeychainApiKeyFn()) {
      throw new Error("The stored Keychain API key is unreadable. Run `cribble auth set` again.");
    }
    deps.log("Cribble API key is configured in macOS Keychain.");
    return;
  }

  if (options.command === "background") {
    if (options.action === "install") {
      if (!deps.keychainHasApiKeyFn()) {
        throw new Error("No Keychain API key configured. Run `cribble auth set` first.");
      }
      const storedApiKey = deps.readKeychainApiKeyFn();
      if (!storedApiKey) {
        throw new Error("No valid Keychain API key configured. Run `cribble auth set` first.");
      }
      if (options.endpoint) parseEndpoint(options.endpoint);
      const installed = deps.installBackgroundFn({
        intervalMinutes: options.intervalMinutes,
        days: options.days,
        endpoint: options.endpoint,
      });
      deps.log(
        `Background sync installed: every ${installed.intervalMinutes} minutes, latest ${installed.days} day${installed.days === 1 ? "" : "s"}.`,
      );
      return;
    }
    if (options.action === "pause") {
      deps.pauseBackgroundFn();
      deps.log("Background sync paused.");
      return;
    }
    if (options.action === "resume") {
      deps.resumeBackgroundFn();
      deps.log("Background sync resumed and queued to run now.");
      return;
    }
    if (options.action === "uninstall") {
      const result = deps.uninstallBackgroundFn();
      deps.log(result.removed ? "Background sync uninstalled." : "Background sync was not installed.");
      return;
    }
    const service = deps.backgroundStatusFn();
    const label = service.disabled
      ? "paused"
      : service.loaded
        ? "running on schedule"
        : service.installed
          ? "installed but not loaded"
          : "not installed";
    deps.log(label);
    return;
  }

  if (options.command === "status") {
    let state;
    try {
      state = deps.readSyncStateFn();
    } catch (error) {
      state = {
        lastError: `${safeText(error?.message, { fallback: "The local sync status is unreadable." })} The next sync attempt will repair it.`,
      };
    }
    let credential = "not configured";
    if (env.CRIBBLE_API_KEY) {
      try {
        deps.resolveApiKeyFn(env);
        credential = "environment override";
      } catch {
        credential = "invalid environment override";
      }
    } else {
      try {
        if (deps.keychainHasApiKeyFn()) {
          credential = deps.readKeychainApiKeyFn()
            ? "macOS Keychain"
            : "invalid macOS Keychain key";
        }
      } catch {
        credential = "unreadable macOS Keychain key";
      }
    }
    let service = "not installed";
    try {
      const background = deps.backgroundStatusFn();
      service = background.disabled
        ? "paused"
        : background.loaded
          ? "running on schedule"
          : background.installed
            ? "installed but not loaded"
            : "not installed";
    } catch {
      service = "not available on this platform";
    }
    deps.log(renderStatus({ state, credential, service }));
    return;
  }

  if (options.command === "show") {
    const snapshot = buildSnapshot(deps.loadUsageFn(env), {
      days: options.days,
      now: deps.nowFn(),
    });
    deps.log(
      options.json
        ? JSON.stringify(snapshot, null, 2)
        : renderSnapshot(snapshot, { color: options.color }),
    );
    return;
  }

  const preparePayload = () => {
    const snapshot = buildSnapshot(deps.loadUsageFn(env), {
      // Filter malformed dates before applying the requested wire window so
      // an "unknown" source row cannot displace a valid usage day.
      days: Number.MAX_SAFE_INTEGER,
      now: deps.nowFn(),
    });
    return buildWirePayload(snapshot, {
      clientId: deps.getClientIdFn(),
      timezone: deps.timezoneFn(),
      days: options.days,
    });
  };

  if (options.dryRun) {
    const payload = preparePayload();
    deps.log(JSON.stringify(payload, null, 2));
    return;
  }

  const endpoint = options.endpoint ?? env.CRIBBLE_SYNC_URL ?? DEFAULT_SYNC_ENDPOINT;
  const endpointLabel = safeEndpointLabel(parseEndpoint(endpoint));

  const performSync = async () => {
    const lastAttemptAt = asIso(deps.nowFn);
    deps.mergeSyncStateFn({
      status: "running",
      lastAttemptAt,
      endpoint: endpointLabel,
      lastError: null,
    });

    try {
      const apiKey = deps.resolveApiKeyFn(env);
      if (!apiKey) {
        throw new Error(
          "No API key configured. Run `cribble auth set`, or set CRIBBLE_API_KEY for development.",
        );
      }
      const payload = preparePayload();
      if (!payload.daily.length) {
        throw new Error("No valid daily token usage was found to sync.");
      }
      const result = await deps.postSnapshotWithRetryFn(payload, { endpoint, apiKey });
      const lastSuccessAt = asIso(deps.nowFn);
      const lastResult = syncCounts(result.body, {
        clientId: payload.clientId,
        dayCount: payload.daily.length,
      });
      if (!lastResult) throw new Error("Cribble returned an invalid sync receipt.");
      deps.mergeSyncStateFn({
        status: "success",
        lastSuccessAt,
        clientId: payload.clientId,
        endpoint: result.endpoint,
        syncedDays: payload.daily.length,
        httpStatus: result.status,
        lastResult,
        lastError: null,
      });
      if (!options.background) {
        deps.log(
          `Synced ${payload.daily.length} usage day${payload.daily.length === 1 ? "" : "s"} to ${result.endpoint} (HTTP ${result.status}).`,
        );
      }
      return result;
    } catch (error) {
      deps.mergeSyncStateFn({
        status: "error",
        lastFailureAt: asIso(deps.nowFn),
        httpStatus: error instanceof SyncRequestError ? error.status ?? null : null,
        lastError: safeText(error?.message, { fallback: "Unknown sync failure" }),
      });
      throw error;
    }
  };

  try {
    return await deps.withSyncLockFn(performSync);
  } catch (error) {
    if (options.background && error instanceof SyncAlreadyRunningError) return;
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Cribble error: ${safeText(error?.message, { fallback: "Unknown failure" })}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SYNC_ENDPOINT,
  buildSnapshot,
  buildWirePayload,
  clientIdPath,
  getOrCreateClientId,
  main,
  parseArgs,
  parseEndpoint,
  postSnapshot,
  postSnapshotWithRetry,
  renderSnapshot,
  renderStatus,
  usage,
};
