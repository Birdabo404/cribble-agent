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
const {
  ANSI,
  animationEnabled,
  colorEnabled,
  createActivity,
  paint,
  renderCliError,
  renderNotice,
  renderSyncReceipt,
} = require("./lib/terminal");

const DEFAULT_DAYS = 7;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_SYNC_ENDPOINT = "https://cribble.dev/api/agent/usage";
const FRIENDLY_COMMANDS = Object.freeze({
  connect: { command: "auth", action: "set" },
  disconnect: { command: "auth", action: "remove" },
  start: { command: "background", action: "install" },
  pause: { command: "background", action: "pause" },
  resume: { command: "background", action: "resume" },
});

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
  let action;

  if (args[0] && !args[0].startsWith("-")) {
    const requestedCommand = args.shift();
    const friendlyCommand = FRIENDLY_COMMANDS[requestedCommand];
    if (friendlyCommand) {
      command = friendlyCommand.command;
      action = friendlyCommand.action;
    } else {
      command = requestedCommand;
    }
  }
  if (!["show", "sync", "status", "auth", "background", "help", "version"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (["auth", "background"].includes(command) && !action) {
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
    else if (arg === "--version" || arg === "-v") options.command = "version";
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
  return `Cribble · Token tracker

Quick commands:
  cribble [--days 7] [--json]
  cribble connect
  cribble sync [--endpoint URL] [--days 7] [--dry-run]
  cribble status
  cribble start [--interval 15] [--days 7]
  cribble pause
  cribble resume

First-time setup:
  1. cribble connect   Save the Agent key from Cribble Settings
  2. cribble sync      Verify the key and send the first snapshot
  3. cribble start     Turn on automatic background sync

Advanced management:
  cribble disconnect
  cribble background <install|status|pause|resume|uninstall> [options]
  cribble auth <set|status|remove>

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
  -v, --version  Show the installed Cribble Agent version
  -h, --help     Show this help

Environment:
  CRIBBLE_SYNC_URL   Backend endpoint used by manual sync
  CRIBBLE_API_KEY    Development/CI override for the Agent key
  CCUSAGE_BIN        Optional path to a ccusage executable

Automatic sync is opt-in and macOS-only. Run \`cribble connect\` before
\`cribble start\`. The Agent key is never written to the LaunchAgent.`;
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

function renderStatus({ state, credential, service, color = false }) {
  const statusValue = (value, fallback = "—") =>
    safeText(value, { fallback, maxLength: 300 });
  const credentialValue = statusValue(credential);
  const credentialColor =
    credentialValue.includes("invalid") ||
    credentialValue.includes("unreadable") ||
    credentialValue === "not configured"
      ? ANSI.warning
      : ANSI.success;
  const serviceValue = statusValue(service);
  const serviceColor = serviceValue === "running on schedule"
    ? ANSI.success
    : serviceValue === "paused"
      ? ANSI.warning
      : ANSI.dim;
  const lines = [
    paint(ANSI.brand, "Cribble · Sync status", color),
    "",
    `Agent key       ${paint(credentialColor, credentialValue, color)}`,
    `Background      ${paint(serviceColor, serviceValue, color)}`,
  ];

  if (!state) {
    lines.push("Last sync       never");
  } else {
    lines.push(`Last attempt    ${statusValue(state.lastAttemptAt)}`);
    lines.push(`Last success    ${statusValue(state.lastSuccessAt, "never")}`);
    if (state.lastResult) {
      lines.push(
        `Last result     ${statusValue(state.lastResult.inserted, "0")} inserted, ${statusValue(state.lastResult.replaced, "0")} replaced, ${statusValue(state.lastResult.stale, "0")} unchanged`,
      );
    }
    if (state.lastError) {
      lines.push(`Last error      ${paint(ANSI.error, statusValue(state.lastError), color)}`);
    }
  }

  const credentialNeedsHelp =
    credential === "not configured" || credential.includes("invalid") || credential.includes("unreadable");
  const nextStep = credentialNeedsHelp
    ? "run `cribble connect`"
    : state?.lastError
      ? "run `cribble sync` to retry in the foreground"
      : service === "paused"
        ? "run `cribble resume`"
        : service === "not installed"
          ? "run `cribble start` for automatic syncing"
          : "none — automatic syncing is active";
  lines.push(`Next step       ${paint(ANSI.brand, nextStep, color)}`);
  return lines.join("\n");
}

function isProductionEndpoint(endpoint) {
  return safeEndpointLabel(endpoint) === safeEndpointLabel(parseEndpoint(DEFAULT_SYNC_ENDPOINT));
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
    createActivityFn: createActivity,
    log: console.log,
    output: process.stdout,
    ...dependencies,
  };
  const options = parseArgs(argv);
  const outputColor = colorEnabled({ color: options.color, stream: deps.output, env });

  if (options.command === "help") {
    deps.log(usage());
    return;
  }

  if (options.command === "version") {
    deps.log(`Cribble Agent ${packageVersion}`);
    return;
  }

  if (options.command === "auth") {
    if (options.action === "set") {
      await deps.promptAndStoreApiKeyFn();
      try {
        const stored = deps.readKeychainApiKeyFn();
        if (!stored) throw new Error("No Agent key was saved.");
      } catch (error) {
        try {
          deps.removeKeychainApiKeyFn();
        } catch {
          throw new Error(
            `${safeText(error?.message, { fallback: "The stored Agent key is invalid." })} Remove it with \`cribble disconnect\` before trying again.`,
          );
        }
        throw error;
      }
      deps.log(
        `${renderNotice("Cribble Agent key saved securely in macOS Keychain.", { color: outputColor })}\nNext: run \`cribble sync\` to verify it and send your first snapshot.`,
      );
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
          "Pause or uninstall background sync before removing its Agent key.",
        );
      }
      const removed = deps.removeKeychainApiKeyFn();
      deps.log(
        removed
          ? renderNotice("Cribble Agent key removed from Keychain.", { color: outputColor })
          : renderNotice("No Agent key was stored.", { color: outputColor, kind: "warning" }),
      );
      return;
    }
    if (!deps.keychainHasApiKeyFn()) {
      deps.log("No Cribble Agent key is configured. Run `cribble connect`.");
      return;
    }
    if (!deps.readKeychainApiKeyFn()) {
      throw new Error("The stored Agent key is unreadable. Run `cribble connect` again.");
    }
    deps.log("Cribble Agent key is configured in macOS Keychain.");
    return;
  }

  if (options.command === "background") {
    if (options.action === "install") {
      if (!deps.keychainHasApiKeyFn()) {
        throw new Error("No Agent key configured. Run `cribble connect` first.");
      }
      const storedApiKey = deps.readKeychainApiKeyFn();
      if (!storedApiKey) {
        throw new Error("No valid Agent key configured. Run `cribble connect` first.");
      }
      if (options.endpoint && !isProductionEndpoint(parseEndpoint(options.endpoint))) {
        throw new Error(
          "Custom endpoints cannot be saved in background sync. Use a manual sync with an explicit CRIBBLE_API_KEY for local development.",
        );
      }
      const installed = deps.installBackgroundFn({
        intervalMinutes: options.intervalMinutes,
        days: options.days,
        endpoint: options.endpoint,
      });
      deps.log(`${renderNotice(
        `Background sync is on: every ${installed.intervalMinutes} minutes, latest ${installed.days} day${installed.days === 1 ? "" : "s"}.`,
        { color: outputColor },
      )}\nAn initial sync was queued. Run \`cribble status\` in a moment to confirm it.`);
      return;
    }
    if (options.action === "pause") {
      deps.pauseBackgroundFn();
      deps.log(renderNotice("Background sync paused.", { color: outputColor, kind: "warning" }));
      return;
    }
    if (options.action === "resume") {
      deps.resumeBackgroundFn();
      deps.log(renderNotice("Background sync resumed and queued to run now.", { color: outputColor }));
      return;
    }
    if (options.action === "uninstall") {
      const result = deps.uninstallBackgroundFn();
      deps.log(
        result.removed
          ? renderNotice("Background sync uninstalled.", { color: outputColor })
          : renderNotice("Background sync was not installed.", { color: outputColor, kind: "warning" }),
      );
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
    deps.log(renderStatus({ state, credential, service, color: outputColor }));
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
        : renderSnapshot(snapshot, { color: outputColor }),
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
  const parsedEndpoint = parseEndpoint(endpoint);
  if (!isProductionEndpoint(parsedEndpoint) && !env.CRIBBLE_API_KEY) {
    throw new Error(
      "Custom sync endpoints never use the Agent key stored in Keychain. Set CRIBBLE_API_KEY explicitly for this development sync.",
    );
  }
  const endpointLabel = safeEndpointLabel(parsedEndpoint);

  const performSync = async () => {
    const activity = deps.createActivityFn({
      output: deps.output,
      enabled: animationEnabled({
        stream: deps.output,
        env,
        background: options.background,
      }),
      color: outputColor,
    });
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
          "No Agent key configured. Run `cribble connect`, or set CRIBBLE_API_KEY for development.",
        );
      }
      activity.start("Collecting local token usage");
      const payload = preparePayload();
      if (!payload.daily.length) {
        throw new Error("No valid daily token usage was found to sync.");
      }
      activity.update("Sending usage to Cribble");
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
      activity.stop();
      if (!options.background) {
        deps.log(renderSyncReceipt(
          { payload, result, counts: lastResult },
          { color: outputColor },
        ));
      }
      return result;
    } catch (error) {
      activity.stop();
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
    const color = colorEnabled({
      color: process.argv.includes("--no-color") ? false : undefined,
      stream: process.stderr,
      env: process.env,
    });
    console.error(renderCliError(error?.message, { color }));
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
  renderCliError,
  renderSyncReceipt,
  renderSnapshot,
  renderStatus,
  usage,
};
