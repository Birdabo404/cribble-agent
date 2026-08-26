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
const { safeText } = require("./safety");

const LAUNCHCTL_PATH = "/bin/launchctl";
const PLUTIL_PATH = "/usr/bin/plutil";
const SYSTEMCTL_CANDIDATES = Object.freeze(["/usr/bin/systemctl", "/bin/systemctl"]);
const BACKGROUND_LABEL = "dev.cribble.agent.sync";
const SUPPORTED_INTERVALS = new Set([5, 10, 15, 20, 30, 60]);

function requireSupportedPlatform(platform = process.platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Cribble background sync currently requires macOS or Linux.");
  }
}

function isLinux(platform = process.platform) {
  return platform === "linux";
}

function launchAgentPath(homeDirectory = homedir()) {
  return join(homeDirectory, "Library", "LaunchAgents", `${BACKGROUND_LABEL}.plist`);
}

function systemdUnitDirectory(homeDirectory = homedir(), env = process.env) {
  // systemd reads user units from $XDG_CONFIG_HOME/systemd/user.
  const configHome =
    typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME
      ? env.XDG_CONFIG_HOME
      : join(homeDirectory, ".config");
  return join(configHome, "systemd", "user");
}

function systemdServicePath(homeDirectory = homedir(), env = process.env) {
  return join(systemdUnitDirectory(homeDirectory, env), `${BACKGROUND_LABEL}.service`);
}

function systemdTimerPath(homeDirectory = homedir(), env = process.env) {
  return join(systemdUnitDirectory(homeDirectory, env), `${BACKGROUND_LABEL}.timer`);
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

function escapeSystemdValue(value) {
  const text = String(value);
  if (/[\n\r]/.test(text)) {
    throw new Error("systemd unit values cannot contain line breaks.");
  }
  // "%" starts a systemd specifier and must be doubled everywhere.
  return text.replaceAll("%", "%%");
}

function escapeSystemdExecArgument(value) {
  const text = escapeSystemdValue(value);
  if (!/[\s"'\\]/.test(text)) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdServiceUnit({
  nodePath,
  entryPath,
  intervalMinutes = 15,
  days = 7,
  endpoint,
}) {
  validateSchedule({ intervalMinutes, days });
  const execStart = [
    nodePath,
    entryPath,
    "sync",
    "--background",
    "--days",
    String(days),
    ...(endpoint ? ["--endpoint", endpoint] : []),
  ]
    .map((argument) => escapeSystemdExecArgument(argument))
    .join(" ");

  return `[Unit]
Description=Cribble Agent background sync

[Service]
Type=oneshot
ExecStart=${execStart}
WorkingDirectory=${escapeSystemdValue(dirname(entryPath))}
UMask=0077
Nice=10
IOSchedulingClass=idle
StandardOutput=null
StandardError=null
`;
}

function systemdTimerUnit({ intervalMinutes = 15, days = 7 } = {}) {
  validateSchedule({ intervalMinutes, days });
  return `[Unit]
Description=Cribble Agent background sync schedule

[Timer]
OnCalendar=*-*-* *:0/${intervalMinutes}:00
Persistent=false

[Install]
WantedBy=timers.target
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

function resolveSystemctlPath({ systemctlPath, existsSyncFn = existsSync } = {}) {
  if (systemctlPath) return systemctlPath;
  const found = SYSTEMCTL_CANDIDATES.find((candidate) => existsSyncFn(candidate));
  if (!found) {
    throw new Error(
      "Cribble background sync on Linux requires systemd, and systemctl was not found.",
    );
  }
  return found;
}

function runSystemctl(args, options = {}) {
  return runCommand(resolveSystemctlPath(options), ["--user", ...args], options);
}

function timerUnitName() {
  return `${BACKGROUND_LABEL}.timer`;
}

function serviceUnitName() {
  return `${BACKGROUND_LABEL}.service`;
}

function writeSystemdUnitFile(contents, filePath) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function timerIsEnabled(options = {}) {
  return runSystemctl(["is-enabled", timerUnitName()], options).status === 0;
}

function timerIsActive(options = {}) {
  return runSystemctl(["is-active", "--quiet", timerUnitName()], options).status === 0;
}

function reloadSystemdUnits(options = {}) {
  const result = runSystemctl(["daemon-reload"], options);
  if (result.status !== 0) throw commandFailure("Reloading systemd user units", result);
}

function enableAndStartTimer(options = {}) {
  const enable = runSystemctl(["enable", timerUnitName()], options);
  if (enable.status !== 0) throw commandFailure("Enabling background sync", enable);
  const start = runSystemctl(["start", timerUnitName()], options);
  if (start.status !== 0) throw commandFailure("Scheduling background sync", start);
}

function kickstartSyncService(options = {}) {
  // --no-block queues the oneshot sync like launchctl kickstart instead of
  // waiting for a full network round-trip inside the CLI command.
  const result = runSystemctl(["start", "--no-block", serviceUnitName()], options);
  if (result.status !== 0) throw commandFailure("Starting background sync", result);
}

function disableAndStopTimer(options = {}) {
  const result = runSystemctl(["disable", "--now", timerUnitName()], options);
  if (result.status !== 0) throw commandFailure("Pausing background sync", result);
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
  return new RegExp(`"?${BACKGROUND_LABEL.replaceAll(".", "\\.")}"?\\s*=>\\s*true`).test(
    String(result.stdout ?? ""),
  );
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

function unitMissingFailure(result) {
  return /does not exist|not loaded|not found|no such/i.test(String(result.stderr ?? ""));
}

function installLinuxBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  homeDirectory = homedir(),
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath,
  pathEnv = process.env.PATH,
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  const systemctl = { spawnSyncFn, systemctlPath };
  const effectiveNodePath = nodePath ?? resolveStableNodePath(process.execPath, pathEnv);
  if (!existsSync(effectiveNodePath)) {
    throw new Error(`Node executable not found at ${effectiveNodePath}.`);
  }
  if (!existsSync(entryPath)) throw new Error(`Cribble CLI not found at ${entryPath}.`);

  const servicePath = systemdServicePath(homeDirectory, env);
  const timerPath = systemdTimerPath(homeDirectory, env);
  const previousService = existsSync(servicePath) ? readFileSync(servicePath, "utf8") : null;
  const previousTimer = existsSync(timerPath) ? readFileSync(timerPath, "utf8") : null;
  const previousWasEnabled = previousTimer !== null && timerIsEnabled(systemctl);

  try {
    writeSystemdUnitFile(
      systemdServiceUnit({
        nodePath: effectiveNodePath,
        entryPath,
        intervalMinutes,
        days,
        endpoint,
      }),
      servicePath,
    );
    writeSystemdUnitFile(systemdTimerUnit({ intervalMinutes, days }), timerPath);
    reloadSystemdUnits(systemctl);
    enableAndStartTimer(systemctl);
    kickstartSyncService(systemctl);
  } catch (error) {
    // Do not strand a previously working schedule. Put its exact unit files
    // back and make a best-effort attempt to re-arm them.
    let rollbackError = null;
    try {
      if (previousService === null) rmSync(servicePath, { force: true });
      else writeSystemdUnitFile(previousService, servicePath);
      if (previousTimer === null) rmSync(timerPath, { force: true });
      else writeSystemdUnitFile(previousTimer, timerPath);
      reloadSystemdUnits(systemctl);
      if (previousWasEnabled) enableAndStartTimer(systemctl);
    } catch (cleanupError) {
      rollbackError = cleanupError;
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
    filePath: timerPath,
    nodePath: effectiveNodePath,
    intervalMinutes,
    days,
    endpoint: endpoint ?? null,
  };
}

function pauseLinuxBackground({
  homeDirectory = homedir(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  const systemctl = { spawnSyncFn, systemctlPath };
  if (!existsSync(systemdTimerPath(homeDirectory, env))) {
    throw new Error("Background sync is not installed. Run `cribble start` first.");
  }
  disableAndStopTimer(systemctl);
  try {
    const stop = runSystemctl(["stop", serviceUnitName()], systemctl);
    if (stop.status !== 0 && !unitMissingFailure(stop)) {
      throw commandFailure("Stopping background sync", stop);
    }
  } catch (error) {
    try {
      enableAndStartTimer(systemctl);
    } catch (rollbackError) {
      throw new Error(
        `${safeText(error?.message, { fallback: "Pausing background sync failed." })} Rollback also failed: ${safeText(rollbackError?.message, { fallback: "unknown rollback failure" })}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function resumeLinuxBackground({
  homeDirectory = homedir(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  const systemctl = { spawnSyncFn, systemctlPath };
  if (!existsSync(systemdTimerPath(homeDirectory, env))) {
    throw new Error("Background sync is not installed. Run `cribble background install` first.");
  }
  const previousWasEnabled = timerIsEnabled(systemctl);
  try {
    reloadSystemdUnits(systemctl);
    enableAndStartTimer(systemctl);
    kickstartSyncService(systemctl);
  } catch (error) {
    let rollbackError = null;
    try {
      if (!previousWasEnabled) disableAndStopTimer(systemctl);
    } catch (cleanupError) {
      rollbackError = cleanupError;
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

function uninstallLinuxBackground({
  homeDirectory = homedir(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  const systemctl = { spawnSyncFn, systemctlPath };
  const servicePath = systemdServicePath(homeDirectory, env);
  const timerPath = systemdTimerPath(homeDirectory, env);
  const removed = existsSync(timerPath) || existsSync(servicePath);
  if (removed) {
    const disable = runSystemctl(["disable", "--now", timerUnitName()], systemctl);
    if (disable.status !== 0 && !unitMissingFailure(disable)) {
      throw commandFailure("Stopping background sync", disable);
    }
    const stop = runSystemctl(["stop", serviceUnitName()], systemctl);
    if (stop.status !== 0 && !unitMissingFailure(stop)) {
      throw commandFailure("Stopping background sync", stop);
    }
    rmSync(timerPath, { force: true });
    rmSync(servicePath, { force: true });
    reloadSystemdUnits(systemctl);
  }
  return { removed, filePath: timerPath };
}

function linuxBackgroundStatus({
  homeDirectory = homedir(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  const systemctl = { spawnSyncFn, systemctlPath };
  const filePath = systemdTimerPath(homeDirectory, env);
  const installed = existsSync(filePath);
  const loaded = installed && timerIsActive(systemctl);
  const disabled = installed && !timerIsEnabled(systemctl);
  return { installed, loaded, disabled, filePath };
}

function installMacBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  homeDirectory = homedir(),
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath,
  pathEnv = process.env.PATH,
  uid,
  spawnSyncFn = spawnSync,
} = {}) {
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

function installBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  homeDirectory = homedir(),
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath,
  pathEnv = process.env.PATH,
  platform = process.platform,
  uid = process.getuid?.(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  requireSupportedPlatform(platform);
  if (isLinux(platform)) {
    return installLinuxBackground({
      intervalMinutes,
      days,
      endpoint,
      homeDirectory,
      entryPath,
      nodePath,
      pathEnv,
      env,
      spawnSyncFn,
      systemctlPath,
    });
  }
  return installMacBackground({
    intervalMinutes,
    days,
    endpoint,
    homeDirectory,
    entryPath,
    nodePath,
    pathEnv,
    uid,
    spawnSyncFn,
  });
}

function pauseMacBackground({ uid, spawnSyncFn = spawnSync } = {}) {
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

function pauseBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  requireSupportedPlatform(platform);
  if (isLinux(platform)) {
    return pauseLinuxBackground({ homeDirectory, env, spawnSyncFn, systemctlPath });
  }
  return pauseMacBackground({ uid, spawnSyncFn });
}

function resumeMacBackground({
  homeDirectory = homedir(),
  uid,
  spawnSyncFn = spawnSync,
} = {}) {
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

function resumeBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  requireSupportedPlatform(platform);
  if (isLinux(platform)) {
    return resumeLinuxBackground({ homeDirectory, env, spawnSyncFn, systemctlPath });
  }
  return resumeMacBackground({ homeDirectory, uid, spawnSyncFn });
}

function uninstallMacBackground({
  homeDirectory = homedir(),
  uid,
  spawnSyncFn = spawnSync,
} = {}) {
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

function uninstallBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  requireSupportedPlatform(platform);
  if (isLinux(platform)) {
    return uninstallLinuxBackground({ homeDirectory, env, spawnSyncFn, systemctlPath });
  }
  return uninstallMacBackground({ homeDirectory, uid, spawnSyncFn });
}

function macBackgroundStatus({
  homeDirectory = homedir(),
  uid,
  spawnSyncFn = spawnSync,
} = {}) {
  requireUid(uid);
  const filePath = launchAgentPath(homeDirectory);
  const installed = existsSync(filePath);
  const loaded = serviceIsLoaded(uid, { spawnSyncFn });
  const disabled = serviceIsDisabled(uid, { spawnSyncFn });

  return { installed, loaded, disabled, filePath };
}

function backgroundStatus({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  env = process.env,
  spawnSyncFn = spawnSync,
  systemctlPath,
} = {}) {
  requireSupportedPlatform(platform);
  if (isLinux(platform)) {
    return linuxBackgroundStatus({ homeDirectory, env, spawnSyncFn, systemctlPath });
  }
  return macBackgroundStatus({ homeDirectory, uid, spawnSyncFn });
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
  systemdServicePath,
  systemdServiceUnit,
  systemdTimerPath,
  systemdTimerUnit,
  uninstallBackground,
};
