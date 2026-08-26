"use strict";

const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { collectorCliArguments } = require("./collector-options");
const { safeText } = require("./safety");

const SCHTASKS = "schtasks.exe";
const WINDOWS_TASK_NAME = "Cribble Token Usage Sync";
const SCHED_E_TASK_NOT_RUNNING = new Set([0x8004130B, -2147216629]);
const ERROR_FILE_NOT_FOUND = new Set([0x80070002, -2147024894]);

function quoteWindowsArgument(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error("Background task paths contain invalid characters.");
  if (text && !/[\s"]/u.test(text)) return text;
  let quoted = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function windowsTaskCommand({
  nodePath,
  entryPath,
  days = 7,
  endpoint,
  hermesHome,
  ccusageTimeoutMs,
}) {
  return [
    nodePath,
    entryPath,
    "sync",
    "--background",
    "--days",
    String(days),
    ...(endpoint ? ["--endpoint", endpoint] : []),
    ...collectorCliArguments({ hermesHome, ccusageTimeoutMs }),
  ].map(quoteWindowsArgument).join(" ");
}

function runSchtasks(args, {
  spawnSyncFn = spawnSync,
  schtasksPath = SCHTASKS,
} = {}) {
  const result = spawnSyncFn(schtasksPath, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Windows background sync requires Task Scheduler.");
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

function taskNotFound(result) {
  const detail = String(result.stderr ?? result.stdout ?? "").toLowerCase();
  return ERROR_FILE_NOT_FOUND.has(result.status) ||
    detail.includes("cannot find") ||
    detail.includes("does not exist");
}

function endWindowsTask(options = {}) {
  const result = runSchtasks(
    ["/End", "/TN", WINDOWS_TASK_NAME, "/HRESULT"],
    options,
  );
  const detail = String(result.stderr ?? result.stdout ?? "").toLowerCase();
  if (
    result.status === 0 ||
    SCHED_E_TASK_NOT_RUNNING.has(result.status) ||
    detail.includes("not currently running")
  ) {
    return;
  }
  throw commandError("Stopping the active Windows background sync", result);
}

function restoreWindowsTask(xml, options = {}) {
  const temporaryPath = join(
    options.temporaryDirectory ?? tmpdir(),
    `cribble-task-${process.pid}-${randomUUID()}.xml`,
  );
  const writeFileSyncFn = options.writeFileSyncFn ?? writeFileSync;
  const rmSyncFn = options.rmSyncFn ?? rmSync;
  try {
    writeFileSyncFn(temporaryPath, xml, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    requireSuccess(
      "Restoring the previous Windows background sync",
      runSchtasks(
        [
          "/Create",
          "/TN",
          WINDOWS_TASK_NAME,
          "/XML",
          temporaryPath,
          "/F",
        ],
        options,
      ),
    );
  } finally {
    rmSyncFn(temporaryPath, { force: true });
  }
}

function installWindowsBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  hermesHome,
  ccusageTimeoutMs,
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath = process.execPath,
  existsSyncFn = existsSync,
  rmSyncFn = rmSync,
  spawnSyncFn = spawnSync,
  schtasksPath = SCHTASKS,
  temporaryDirectory = tmpdir(),
  writeFileSyncFn = writeFileSync,
} = {}) {
  if (!existsSyncFn(nodePath)) throw new Error(`Node executable not found at ${nodePath}.`);
  if (!existsSyncFn(entryPath)) throw new Error(`Cribble CLI not found at ${entryPath}.`);
  const taskCommand = windowsTaskCommand({
    nodePath,
    entryPath,
    days,
    endpoint,
    hermesHome,
    ccusageTimeoutMs,
  });
  const options = {
    rmSyncFn,
    spawnSyncFn,
    schtasksPath,
    temporaryDirectory,
    writeFileSyncFn,
  };
  const previous = runSchtasks(
    ["/Query", "/TN", WINDOWS_TASK_NAME, "/XML", "/HRESULT"],
    options,
  );
  if (previous.status !== 0 && !taskNotFound(previous)) {
    throw commandError("Inspecting the previous Windows background sync", previous);
  }
  const previousXml = previous.status === 0 ? String(previous.stdout ?? "") : null;
  requireSuccess(
    "Installing Windows background sync",
    runSchtasks(
      [
        "/Create",
        "/SC",
        "MINUTE",
        "/MO",
        String(intervalMinutes),
        "/TN",
        WINDOWS_TASK_NAME,
        "/TR",
        taskCommand,
        "/RL",
        "LIMITED",
        "/F",
      ],
      options,
    ),
  );
  try {
    requireSuccess(
      "Starting Windows background sync",
      runSchtasks(["/Run", "/TN", WINDOWS_TASK_NAME], options),
    );
  } catch (error) {
    try {
      if (previousXml === null) {
        requireSuccess(
          "Removing the failed Windows background sync",
          runSchtasks(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], options),
        );
      } else {
        restoreWindowsTask(previousXml, options);
      }
    } catch (rollbackError) {
      error.message = `${error.message} Rollback also failed: ${safeText(
        rollbackError.message,
        { maxLength: 200 },
      )}`;
    }
    throw error;
  }
  return {
    filePath: WINDOWS_TASK_NAME,
    nodePath,
    intervalMinutes,
    days,
    endpoint: endpoint ?? null,
  };
}

function pauseWindowsBackground(options = {}) {
  requireSuccess(
    "Pausing Windows background sync",
    runSchtasks(["/Change", "/TN", WINDOWS_TASK_NAME, "/Disable"], options),
  );
  endWindowsTask(options);
}

function resumeWindowsBackground(options = {}) {
  requireSuccess(
    "Resuming Windows background sync",
    runSchtasks(["/Change", "/TN", WINDOWS_TASK_NAME, "/Enable"], options),
  );
  try {
    requireSuccess(
      "Starting Windows background sync",
      runSchtasks(["/Run", "/TN", WINDOWS_TASK_NAME], options),
    );
  } catch (error) {
    const rollback = runSchtasks(
      ["/Change", "/TN", WINDOWS_TASK_NAME, "/Disable"],
      options,
    );
    if (rollback.status !== 0) {
      error.message = `${error.message} Rollback also failed: ${
        commandError("Re-pausing Windows background sync", rollback).message
      }`;
    }
    throw error;
  }
}

function uninstallWindowsBackground(options = {}) {
  const status = windowsBackgroundStatus(options);
  if (!status.installed) return { removed: false, filePath: WINDOWS_TASK_NAME };
  requireSuccess(
    "Disabling Windows background sync",
    runSchtasks(["/Change", "/TN", WINDOWS_TASK_NAME, "/Disable"], options),
  );
  endWindowsTask(options);
  requireSuccess(
    "Uninstalling Windows background sync",
    runSchtasks(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], options),
  );
  return { removed: true, filePath: WINDOWS_TASK_NAME };
}

function windowsBackgroundStatus(options = {}) {
  const result = runSchtasks(
    ["/Query", "/TN", WINDOWS_TASK_NAME, "/XML", "/HRESULT"],
    options,
  );
  if (result.status !== 0) {
    if (taskNotFound(result)) {
      return {
        installed: false,
        loaded: false,
        disabled: false,
        filePath: WINDOWS_TASK_NAME,
      };
    }
    throw commandError("Inspecting Windows background sync", result);
  }
  const disabled = /<Enabled>\s*false\s*<\/Enabled>/i.test(String(result.stdout ?? ""));
  return {
    installed: true,
    loaded: !disabled,
    disabled,
    filePath: WINDOWS_TASK_NAME,
  };
}

module.exports = {
  installWindowsBackground,
  pauseWindowsBackground,
  quoteWindowsArgument,
  resumeWindowsBackground,
  uninstallWindowsBackground,
  windowsBackgroundStatus,
  WINDOWS_TASK_NAME,
  windowsTaskCommand,
};
