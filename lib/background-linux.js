"use strict";

const { spawnSync } = require("node:child_process");
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
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { collectorCliArguments } = require("./collector-options");
const { safeText } = require("./safety");

const SYSTEMCTL = "systemctl";
const BACKGROUND_LABEL = "dev.cribble.agent.sync";

function systemdUserDirectory(homeDirectory = homedir(), env = process.env) {
  const configured =
    typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome = isAbsolute(configured)
    ? configured
    : join(homeDirectory, ".config");
  return join(configHome, "systemd", "user");
}

function linuxBackgroundPaths(homeDirectory = homedir(), env = process.env) {
  const directory = systemdUserDirectory(homeDirectory, env);
  return {
    servicePath: join(directory, `${BACKGROUND_LABEL}.service`),
    timerPath: join(directory, `${BACKGROUND_LABEL}.timer`),
  };
}

function systemdQuote(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error("Background service paths contain invalid characters.");
  return `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

// systemd applies shell-style unquoting only to Exec* lines. Path settings
// like WorkingDirectory= take the value literally, so a quoted path is
// rejected as non-absolute and ignored. Escape only % specifiers.
function systemdPath(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error("Background service paths contain invalid characters.");
  return text.replaceAll("%", "%%");
}

function systemdUnits({
  nodePath,
  entryPath,
  intervalMinutes = 15,
  days = 7,
  endpoint,
  hermesHome,
  ccusageTimeoutMs,
}) {
  const args = [
    nodePath,
    entryPath,
    "sync",
    "--background",
    "--days",
    String(days),
    ...(endpoint ? ["--endpoint", endpoint] : []),
    ...collectorCliArguments({ hermesHome, ccusageTimeoutMs }),
  ];
  const service = `[Unit]
Description=Cribble token usage sync

[Service]
Type=oneshot
ExecStart=${args.map(systemdQuote).join(" ")}
WorkingDirectory=${systemdPath(dirname(entryPath))}
Environment=NO_COLOR=1
Nice=10
IOSchedulingClass=idle
UMask=0077
`;
  const timer = `[Unit]
Description=Run Cribble token usage sync

[Timer]
OnBootSec=1min
OnUnitActiveSec=${intervalMinutes}min
Unit=${BACKGROUND_LABEL}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

function runSystemctl(args, {
  spawnSyncFn = spawnSync,
  systemctlPath = SYSTEMCTL,
} = {}) {
  const result = spawnSyncFn(systemctlPath, ["--user", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Linux background sync requires systemd user services.");
  }
  if (result.error) throw result.error;
  return result;
}

function commandError(label, result) {
  const detail = safeText(result.stderr ?? result.stdout, { maxLength: 300 });
  return new Error(`${label} failed${detail ? `: ${detail}` : "."}`);
}

function requireSuccess(label, result) {
  if (result.status !== 0) throw commandError(label, result);
}

function systemctlFlag(label, args, falseStatuses, options) {
  const result = runSystemctl(args, options);
  if (result.status === 0) return true;
  if (
    falseStatuses.includes(result.status) &&
    !String(result.stderr ?? "").trim()
  ) {
    return false;
  }
  throw commandError(label, result);
}

function writeUnitAtomic(
  filePath,
  contents,
  {
    writeFileSyncFn = writeFileSync,
    renameSyncFn = renameSync,
    rmSyncFn = rmSync,
  } = {},
) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSyncFn(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSyncFn(temporaryPath, filePath);
  } finally {
    rmSyncFn(temporaryPath, { force: true });
  }
}

function installLinuxBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  hermesHome,
  ccusageTimeoutMs,
  homeDirectory = homedir(),
  env = process.env,
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath = process.execPath,
  existsSyncFn = existsSync,
  mkdirSyncFn = mkdirSync,
  readFileSyncFn = readFileSync,
  renameSyncFn = renameSync,
  rmSyncFn = rmSync,
  writeFileSyncFn = writeFileSync,
  spawnSyncFn = spawnSync,
  systemctlPath = SYSTEMCTL,
} = {}) {
  if (!existsSyncFn(nodePath)) throw new Error(`Node executable not found at ${nodePath}.`);
  if (!existsSyncFn(entryPath)) throw new Error(`Cribble CLI not found at ${entryPath}.`);
  const paths = linuxBackgroundPaths(homeDirectory, env);
  const previousService = existsSyncFn(paths.servicePath)
    ? readFileSyncFn(paths.servicePath, "utf8")
    : null;
  const previousTimer = existsSyncFn(paths.timerPath)
    ? readFileSyncFn(paths.timerPath, "utf8")
    : null;
  const units = systemdUnits({
    nodePath,
    entryPath,
    intervalMinutes,
    days,
    endpoint,
    hermesHome,
    ccusageTimeoutMs,
  });
  mkdirSyncFn(dirname(paths.servicePath), { recursive: true, mode: 0o700 });

  const options = { spawnSyncFn, systemctlPath };
  const hadCompleteInstall = previousService !== null && previousTimer !== null;
  const previousEnabled = hadCompleteInstall
    ? systemctlFlag(
        "Inspecting previous Linux background enablement",
        ["is-enabled", "--quiet", `${BACKGROUND_LABEL}.timer`],
        [1],
        options,
      )
    : false;
  const previousActive = hadCompleteInstall
    ? systemctlFlag(
        "Inspecting previous Linux background activity",
        ["is-active", "--quiet", `${BACKGROUND_LABEL}.timer`],
        [3],
        options,
      )
    : false;
  try {
    writeUnitAtomic(paths.servicePath, units.service, {
      writeFileSyncFn,
      renameSyncFn,
      rmSyncFn,
    });
    writeUnitAtomic(paths.timerPath, units.timer, {
      writeFileSyncFn,
      renameSyncFn,
      rmSyncFn,
    });
    requireSuccess("Reloading Linux background services", runSystemctl(["daemon-reload"], options));
    requireSuccess(
      "Installing Linux background sync",
      runSystemctl(["enable", "--now", `${BACKGROUND_LABEL}.timer`], options),
    );
    requireSuccess(
      "Starting Linux background sync",
      runSystemctl(["start", "--no-block", `${BACKGROUND_LABEL}.service`], options),
    );
  } catch (error) {
    const rollbackFailures = [];
    const recordRollbackFailure = (rollbackError) => {
      rollbackFailures.push(
        safeText(rollbackError?.message ?? rollbackError, { maxLength: 200 }),
      );
    };
    const rollback = (label, args) => {
      try {
        const result = runSystemctl(args, options);
        if (result.status !== 0) {
          rollbackFailures.push(commandError(label, result).message);
        }
      } catch (rollbackError) {
        recordRollbackFailure(rollbackError);
      }
    };
    const restoreFile = (filePath, previous) => {
      try {
        if (previous === null) rmSyncFn(filePath, { force: true });
        else writeUnitAtomic(filePath, previous, {
          writeFileSyncFn,
          renameSyncFn,
          rmSyncFn,
        });
      } catch (rollbackError) {
        recordRollbackFailure(rollbackError);
      }
    };
    // A failed update must not leave a newly enabled timer or a oneshot sync
    // running against files that are about to be restored.
    rollback("Disabling the failed Linux background timer", [
      "disable",
      "--now",
      `${BACKGROUND_LABEL}.timer`,
    ]);
    rollback("Stopping the failed Linux background sync", [
      "stop",
      `${BACKGROUND_LABEL}.service`,
    ]);
    restoreFile(paths.servicePath, previousService);
    restoreFile(paths.timerPath, previousTimer);
    rollback("Reloading restored Linux background services", ["daemon-reload"]);
    if (hadCompleteInstall) {
      rollback(
        "Restoring Linux background enablement",
        [
          previousEnabled ? "enable" : "disable",
          "--now",
          `${BACKGROUND_LABEL}.timer`,
        ],
      );
      rollback(
        "Restoring Linux background activity",
        [
          previousActive ? "start" : "stop",
          ...(previousActive ? ["--no-block"] : []),
          `${BACKGROUND_LABEL}.service`,
        ],
      );
    }
    if (rollbackFailures.length) {
      error.message = `${error.message} Rollback also failed: ${rollbackFailures.join("; ")}`;
    }
    throw error;
  }

  return {
    filePath: paths.timerPath,
    nodePath,
    intervalMinutes,
    days,
    endpoint: endpoint ?? null,
  };
}

function pauseLinuxBackground(options = {}) {
  const paths = linuxBackgroundPaths(options.homeDirectory, options.env);
  if (!(options.existsSyncFn ?? existsSync)(paths.timerPath)) {
    throw new Error("Background sync is not installed. Run `cribble start` first.");
  }
  requireSuccess(
    "Pausing Linux background sync",
    runSystemctl(["disable", "--now", `${BACKGROUND_LABEL}.timer`], options),
  );
  requireSuccess(
    "Stopping the active Linux background sync",
    runSystemctl(["stop", `${BACKGROUND_LABEL}.service`], options),
  );
}

function resumeLinuxBackground(options = {}) {
  const paths = linuxBackgroundPaths(options.homeDirectory, options.env);
  if (!(options.existsSyncFn ?? existsSync)(paths.timerPath)) {
    throw new Error("Background sync is not installed. Run `cribble start` first.");
  }
  requireSuccess(
    "Resuming Linux background sync",
    runSystemctl(["enable", "--now", `${BACKGROUND_LABEL}.timer`], options),
  );
  requireSuccess(
    "Starting Linux background sync",
    runSystemctl(["start", "--no-block", `${BACKGROUND_LABEL}.service`], options),
  );
}

function uninstallLinuxBackground(options = {}) {
  const paths = linuxBackgroundPaths(options.homeDirectory, options.env);
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  const rmSyncFn = options.rmSyncFn ?? rmSync;
  const removed = existsSyncFn(paths.servicePath) || existsSyncFn(paths.timerPath);
  if (removed) {
    requireSuccess(
      "Disabling Linux background sync",
      runSystemctl(["disable", "--now", `${BACKGROUND_LABEL}.timer`], options),
    );
    requireSuccess(
      "Stopping the active Linux background sync",
      runSystemctl(["stop", `${BACKGROUND_LABEL}.service`], options),
    );
    rmSyncFn(paths.servicePath, { force: true });
    rmSyncFn(paths.timerPath, { force: true });
    requireSuccess(
      "Reloading Linux background services",
      runSystemctl(["daemon-reload"], options),
    );
  }
  return { removed, filePath: paths.timerPath };
}

function linuxBackgroundStatus(options = {}) {
  const paths = linuxBackgroundPaths(options.homeDirectory, options.env);
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  const installed = existsSyncFn(paths.servicePath) && existsSyncFn(paths.timerPath);
  if (!installed) return { installed: false, loaded: false, disabled: false, filePath: paths.timerPath };
  const loaded =
    runSystemctl(["is-active", "--quiet", `${BACKGROUND_LABEL}.timer`], options);
  const enabled =
    runSystemctl(["is-enabled", "--quiet", `${BACKGROUND_LABEL}.timer`], options);
  if (loaded.status !== 0 && String(loaded.stderr ?? "").trim()) {
    throw commandError("Inspecting Linux background activity", loaded);
  }
  if (enabled.status !== 0 && String(enabled.stderr ?? "").trim()) {
    throw commandError("Inspecting Linux background enablement", enabled);
  }
  return {
    installed,
    loaded: loaded.status === 0,
    disabled: enabled.status !== 0,
    filePath: paths.timerPath,
  };
}

module.exports = {
  installLinuxBackground,
  linuxBackgroundPaths,
  linuxBackgroundStatus,
  pauseLinuxBackground,
  resumeLinuxBackground,
  systemdUnits,
  uninstallLinuxBackground,
};
