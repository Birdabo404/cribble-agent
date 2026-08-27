"use strict";

const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { delimiter, dirname, join, resolve } = require("node:path");
const { collectorCliArguments } = require("./collector-options");
const { requireMacOS: requireMac } = require("./platform");
const { safeText } = require("./safety");
const {
  installLinuxBackground,
  linuxBackgroundStatus,
  pauseLinuxBackground,
  resumeLinuxBackground,
  uninstallLinuxBackground,
} = require("./background-linux");
const {
  installWindowsBackground,
  pauseWindowsBackground,
  resumeWindowsBackground,
  uninstallWindowsBackground,
  windowsBackgroundStatus,
} = require("./background-windows");

const LAUNCHCTL_PATH = "/bin/launchctl";
const PLUTIL_PATH = "/usr/bin/plutil";
const BACKGROUND_LABEL = "dev.cribble.agent.sync";
const SUPPORTED_INTERVALS = new Set([5, 10, 15, 20, 30, 60]);

function launchAgentPath(homeDirectory = homedir()) {
  return join(homeDirectory, "Library", "LaunchAgents", `${BACKGROUND_LABEL}.plist`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringElement(value, indent = "    ") {
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function validateSchedule({ intervalMinutes, days }) {
  if (!SUPPORTED_INTERVALS.has(intervalMinutes)) {
    throw new Error("--interval must be one of 5, 10, 15, 20, 30, or 60 minutes.");
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be a whole number between 1 and 365.");
  }
}

function launchAgentPlist({
  nodePath,
  entryPath,
  intervalMinutes = 15,
  days = 7,
  endpoint,
  hermesHome,
  ccusageTimeoutMs,
}) {
  validateSchedule({ intervalMinutes, days });
  const programArguments = [
    nodePath,
    entryPath,
    "sync",
    "--background",
    "--days",
    String(days),
    ...(endpoint ? ["--endpoint", endpoint] : []),
    ...collectorCliArguments({ hermesHome, ccusageTimeoutMs }),
  ];
  const minutes = Array.from(
    { length: 60 / intervalMinutes },
    (_, index) => index * intervalMinutes,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BACKGROUND_LABEL}</string>
  <key>Program</key>
  <string>${escapeXml(nodePath)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => stringElement(argument)).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dirname(entryPath))}</string>
  <key>StartCalendarInterval</key>
  <array>
${minutes
  .map(
    (minute) => `    <dict>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>`,
  )
  .join("\n")}
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

function runCommand(command, args, { spawnSyncFn = spawnSync } = {}) {
  const result = spawnSyncFn(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return result;
}

function commandFailure(label, result) {
  const detail = safeText(result.stderr ?? result.stdout, { maxLength: 300 });
  return new Error(`${label} failed${detail ? `: ${detail}` : "."}`);
}

function bootoutIfLoaded(uid, { spawnSyncFn = spawnSync } = {}) {
  const result = runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget(uid)], {
    spawnSyncFn,
  });
  if (result.status === 0) return true;

  const detail = safeText(result.stderr ?? result.stdout, { maxLength: 300 }).toLowerCase();
  if (detail.includes("no such process") || detail.includes("could not find specified service")) {
    return false;
  }
  throw commandFailure("Stopping background sync", result);
}

function writeLaunchAgent(
  contents,
  filePath,
  { spawnSyncFn = spawnSync } = {},
) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const lint = runCommand(PLUTIL_PATH, ["-lint", temporaryPath], { spawnSyncFn });
    if (lint.status !== 0) throw commandFailure("LaunchAgent validation", lint);
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function serviceTarget(uid) {
  return `gui/${uid}/${BACKGROUND_LABEL}`;
}

function domainTarget(uid) {
  return `gui/${uid}`;
}

function requireUid(uid) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("Could not determine the current macOS user.");
  }
  return uid;
}

function resolveStableNodePath(
  executablePath = process.execPath,
  searchPath = process.env.PATH,
  { existsSyncFn = existsSync, realpathSyncFn = realpathSync } = {},
) {
  if (!existsSyncFn(executablePath)) return executablePath;
  let executableTarget;
  try {
    executableTarget = realpathSyncFn(executablePath);
  } catch {
    return executablePath;
  }

  for (const directory of String(searchPath ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, "node");
    if (candidate === executablePath || !existsSyncFn(candidate)) continue;
    try {
      if (realpathSyncFn(candidate) === executableTarget) return candidate;
    } catch {
      // Ignore broken or inaccessible PATH entries.
    }
  }
  return executablePath;
}

function serviceIsLoaded(uid, { spawnSyncFn = spawnSync } = {}) {
  return runCommand(LAUNCHCTL_PATH, ["print", serviceTarget(uid)], {
    spawnSyncFn,
  }).status === 0;
}

function serviceIsDisabled(uid, { spawnSyncFn = spawnSync } = {}) {
  const result = runCommand(LAUNCHCTL_PATH, ["print-disabled", domainTarget(uid)], {
    spawnSyncFn,
  });
  if (result.status !== 0) throw commandFailure("Inspecting background sync", result);
  // Older macOS prints `"label" => true`; modern macOS prints
  // `"label" => disabled`. Accept both so pause detection keeps working.
  return new RegExp(
    `"?${BACKGROUND_LABEL.replaceAll(".", "\\.")}"?\\s*=>\\s*(?:true|disabled)\\b`,
  ).test(String(result.stdout ?? ""));
}

function setServiceDisabled(uid, disabled, { spawnSyncFn = spawnSync } = {}) {
  const action = disabled ? "disable" : "enable";
  const result = runCommand(LAUNCHCTL_PATH, [action, serviceTarget(uid)], {
    spawnSyncFn,
  });
  if (result.status !== 0) {
    throw commandFailure(disabled ? "Pausing background sync" : "Enabling background sync", result);
  }
}

function installMacBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  hermesHome,
  ccusageTimeoutMs,
  homeDirectory = homedir(),
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath,
  pathEnv = process.env.PATH,
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  const effectiveNodePath = nodePath ?? resolveStableNodePath(process.execPath, pathEnv);
  if (!existsSync(effectiveNodePath)) {
    throw new Error(`Node executable not found at ${effectiveNodePath}.`);
  }
  if (!existsSync(entryPath)) throw new Error(`Cribble CLI not found at ${entryPath}.`);

  const filePath = launchAgentPath(homeDirectory);
  const previousContents = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  const contents = launchAgentPlist({
    nodePath: effectiveNodePath,
    entryPath,
    intervalMinutes,
    days,
    endpoint,
    hermesHome,
    ccusageTimeoutMs,
  });
  writeLaunchAgent(contents, filePath, { spawnSyncFn });

  let previousWasLoaded = false;
  let previousWasDisabled = null;
  let newServiceLoaded = false;
  try {
    // Clear a persistent disabled flag from an earlier pause/uninstall, then
    // replace any loaded copy with this validated definition.
    previousWasDisabled = serviceIsDisabled(uid, { spawnSyncFn });
    setServiceDisabled(uid, false, { spawnSyncFn });
    previousWasLoaded = bootoutIfLoaded(uid, { spawnSyncFn });
    const bootstrap = runCommand(
      LAUNCHCTL_PATH,
      ["bootstrap", domainTarget(uid), filePath],
      { spawnSyncFn },
    );
    if (bootstrap.status !== 0) throw commandFailure("Installing background sync", bootstrap);
    newServiceLoaded = true;

    const kickstart = runCommand(LAUNCHCTL_PATH, ["kickstart", serviceTarget(uid)], {
      spawnSyncFn,
    });
    if (kickstart.status !== 0) throw commandFailure("Starting background sync", kickstart);
  } catch (error) {
    // Do not strand a previously working schedule. Put its exact definition
    // back and make a best-effort attempt to reload it.
    let rollbackError = null;
    let newServiceStopped = !newServiceLoaded;
    if (newServiceLoaded) {
      try {
        bootoutIfLoaded(uid, { spawnSyncFn });
        newServiceStopped = true;
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }
    }
    try {
      if (previousContents === null) {
        rmSync(filePath, { force: true });
      } else {
        writeLaunchAgent(previousContents, filePath, { spawnSyncFn });
        if (previousWasLoaded && newServiceStopped) {
          const restore = runCommand(
            LAUNCHCTL_PATH,
            ["bootstrap", domainTarget(uid), filePath],
            { spawnSyncFn },
          );
          if (restore.status !== 0) {
            throw commandFailure("Restoring the previous background sync", restore);
          }
        }
      }
      if (previousWasDisabled !== null) {
        setServiceDisabled(uid, previousWasDisabled, { spawnSyncFn });
      }
    } catch (cleanupError) {
      rollbackError ??= cleanupError;
    }
    if (rollbackError) {
      throw new Error(
        `${safeText(error?.message, { fallback: "Background installation failed." })} Rollback also failed: ${safeText(rollbackError.message, { fallback: "unknown cleanup failure" })}`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    filePath,
    nodePath: effectiveNodePath,
    intervalMinutes,
    days,
    endpoint: endpoint ?? null,
  };
}

function pauseMacBackground({
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  setServiceDisabled(uid, true, { spawnSyncFn });
  try {
    bootoutIfLoaded(uid, { spawnSyncFn });
  } catch (error) {
    try {
      setServiceDisabled(uid, false, { spawnSyncFn });
    } catch (rollbackError) {
      throw new Error(
        `${safeText(error?.message, { fallback: "Pausing background sync failed." })} Rollback also failed: ${safeText(rollbackError?.message, { fallback: "unknown rollback failure" })}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function resumeMacBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  const filePath = launchAgentPath(homeDirectory);
  if (!existsSync(filePath)) {
    throw new Error("Background sync is not installed. Run `cribble background install` first.");
  }

  const previousWasDisabled = serviceIsDisabled(uid, { spawnSyncFn });
  const previousWasLoaded = serviceIsLoaded(uid, { spawnSyncFn });
  let newServiceLoaded = false;
  try {
    setServiceDisabled(uid, false, { spawnSyncFn });
    bootoutIfLoaded(uid, { spawnSyncFn });
    const bootstrap = runCommand(
      LAUNCHCTL_PATH,
      ["bootstrap", domainTarget(uid), filePath],
      { spawnSyncFn },
    );
    if (bootstrap.status !== 0) throw commandFailure("Loading background sync", bootstrap);
    newServiceLoaded = true;
    const kickstart = runCommand(LAUNCHCTL_PATH, ["kickstart", serviceTarget(uid)], {
      spawnSyncFn,
    });
    if (kickstart.status !== 0) throw commandFailure("Starting background sync", kickstart);
  } catch (error) {
    let rollbackError = null;
    if (newServiceLoaded) {
      try {
        bootoutIfLoaded(uid, { spawnSyncFn });
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }
    }
    try {
      if (previousWasLoaded) {
        const restore = runCommand(
          LAUNCHCTL_PATH,
          ["bootstrap", domainTarget(uid), filePath],
          { spawnSyncFn },
        );
        if (restore.status !== 0) throw commandFailure("Restoring background sync", restore);
      }
      setServiceDisabled(uid, previousWasDisabled, { spawnSyncFn });
    } catch (cleanupError) {
      rollbackError ??= cleanupError;
    }
    if (rollbackError) {
      throw new Error(
        `${safeText(error?.message, { fallback: "Resuming background sync failed." })} Rollback also failed: ${safeText(rollbackError?.message, { fallback: "unknown rollback failure" })}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function uninstallMacBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  bootoutIfLoaded(uid, { spawnSyncFn });
  // Clear the persistent disabled bit so a future install starts from a
  // predictable state.
  setServiceDisabled(uid, false, { spawnSyncFn });
  const filePath = launchAgentPath(homeDirectory);
  const removed = existsSync(filePath);
  if (removed) rmSync(filePath, { force: true });
  return { removed, filePath };
}

function macBackgroundStatus({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  const filePath = launchAgentPath(homeDirectory);
  const installed = existsSync(filePath);
  const loaded = serviceIsLoaded(uid, { spawnSyncFn });
  const disabled = serviceIsDisabled(uid, { spawnSyncFn });

  return { installed, loaded, disabled, filePath };
}

function backgroundPlatform(options = {}) {
  return options.platform ?? process.platform;
}

function installBackground(options = {}) {
  validateSchedule({
    intervalMinutes: options.intervalMinutes ?? 15,
    days: options.days ?? 7,
  });
  const platform = backgroundPlatform(options);
  if (platform === "linux") return installLinuxBackground(options);
  if (platform === "win32") return installWindowsBackground(options);
  if (platform === "darwin") return installMacBackground(options);
  throw new Error("Cribble background sync is not supported on this platform.");
}

function pauseBackground(options = {}) {
  const platform = backgroundPlatform(options);
  if (platform === "linux") return pauseLinuxBackground(options);
  if (platform === "win32") return pauseWindowsBackground(options);
  if (platform === "darwin") return pauseMacBackground(options);
  throw new Error("Cribble background sync is not supported on this platform.");
}

function resumeBackground(options = {}) {
  const platform = backgroundPlatform(options);
  if (platform === "linux") return resumeLinuxBackground(options);
  if (platform === "win32") return resumeWindowsBackground(options);
  if (platform === "darwin") return resumeMacBackground(options);
  throw new Error("Cribble background sync is not supported on this platform.");
}

function uninstallBackground(options = {}) {
  const platform = backgroundPlatform(options);
  if (platform === "linux") return uninstallLinuxBackground(options);
  if (platform === "win32") return uninstallWindowsBackground(options);
  if (platform === "darwin") return uninstallMacBackground(options);
  throw new Error("Cribble background sync is not supported on this platform.");
}

function backgroundStatus(options = {}) {
  const platform = backgroundPlatform(options);
  if (platform === "linux") return linuxBackgroundStatus(options);
  if (platform === "win32") return windowsBackgroundStatus(options);
  if (platform === "darwin") return macBackgroundStatus(options);
  throw new Error("Cribble background sync is not supported on this platform.");
}

module.exports = {
  BACKGROUND_LABEL,
  backgroundStatus,
  installBackground,
  launchAgentPath,
  launchAgentPlist,
  pauseBackground,
  resolveStableNodePath,
  resumeBackground,
  uninstallBackground,
};
