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
const { runPowerShellFile } = require("./windows-shell");

const LAUNCHCTL_PATH = "/bin/launchctl";
const PLUTIL_PATH = "/usr/bin/plutil";
const WINDOWS_TASK_SCRIPT = join(__dirname, "windows-task.ps1");
const BACKGROUND_LABEL = "dev.cribble.agent.sync";
const SUPPORTED_INTERVALS = new Set([5, 10, 15, 20, 30, 60]);
const WINDOWS_TASK_NOT_FOUND = 44;

function requireSupportedPlatform(platform = process.platform) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Cribble background sync currently requires macOS or Windows.");
  }
}

function isWindows(platform = process.platform) {
  return platform === "win32";
}

function launchAgentPath(homeDirectory = homedir()) {
  return join(homeDirectory, "Library", "LaunchAgents", `${BACKGROUND_LABEL}.plist`);
}

function windowsTaskPath() {
  return `\\${BACKGROUND_LABEL}`;
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

function quoteWindowsArgument(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
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

function scheduledTaskXml({
  nodePath,
  entryPath,
  intervalMinutes = 15,
  days = 7,
  endpoint,
}) {
  validateSchedule({ intervalMinutes, days });
  const argumentList = [
    quoteWindowsArgument(entryPath),
    "sync",
    "--background",
    "--days",
    String(days),
    ...(endpoint ? ["--endpoint", quoteWindowsArgument(endpoint)] : []),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\\${escapeXml(BACKGROUND_LABEL)}</URI>
    <Description>Cribble Agent background sync</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${intervalMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(nodePath)}</Command>
      <Arguments>${escapeXml(argumentList.join(" "))}</Arguments>
      <WorkingDirectory>${escapeXml(dirname(entryPath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
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

function runWindowsTask(action, options = {}) {
  return runPowerShellFile(
    WINDOWS_TASK_SCRIPT,
    [action, "-TaskName", BACKGROUND_LABEL],
    { timeout: 30_000, ...options },
  );
}

function parseWindowsTaskStatus(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? "").trim());
    return {
      installed: parsed.installed === true,
      loaded: parsed.loaded === true,
      disabled: parsed.disabled === true,
      filePath: windowsTaskPath(),
    };
  } catch {
    throw new Error("Could not inspect the Cribble Scheduled Task.");
  }
}

function queryWindowsTask(options = {}) {
  const result = runWindowsTask("query", options);
  if (result.status !== 0) throw commandFailure("Inspecting background sync", result);
  return parseWindowsTaskStatus(result.stdout);
}

function exportWindowsTask(options = {}) {
  const result = runWindowsTask("export", options);
  if (result.status === WINDOWS_TASK_NOT_FOUND) return null;
  if (result.status !== 0) throw commandFailure("Exporting the previous background sync", result);
  const xml = String(result.stdout ?? "");
  return xml.trim() ? xml : null;
}

function registerWindowsTask(xml, options = {}) {
  const result = runWindowsTask("register", { ...options, input: xml });
  if (result.status !== 0) throw commandFailure("Installing background sync", result);
}

function unregisterWindowsTask(options = {}) {
  const result = runWindowsTask("unregister", options);
  if (result.status === WINDOWS_TASK_NOT_FOUND) return false;
  if (result.status !== 0) throw commandFailure("Removing background sync", result);
  return true;
}

function setWindowsTaskDisabled(disabled, options = {}) {
  const action = disabled ? "disable" : "enable";
  const result = runWindowsTask(action, options);
  if (result.status !== 0) {
    throw commandFailure(disabled ? "Pausing background sync" : "Enabling background sync", result);
  }
}

function stopWindowsTask(options = {}) {
  const result = runWindowsTask("stop", options);
  if (result.status !== 0) throw commandFailure("Stopping background sync", result);
}

function startWindowsTask(options = {}) {
  const result = runWindowsTask("start", options);
  if (result.status !== 0) throw commandFailure("Starting background sync", result);
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
  {
    existsSyncFn = existsSync,
    realpathSyncFn = realpathSync,
    resolveFn = resolve,
    delimiterValue = delimiter,
  } = {},
) {
  if (!existsSyncFn(executablePath)) return executablePath;
  let executableTarget;
  try {
    executableTarget = realpathSyncFn(executablePath);
  } catch {
    return executablePath;
  }

  for (const directory of String(searchPath ?? "").split(delimiterValue)) {
    if (!directory) continue;
    for (const executableName of ["node", "node.exe"]) {
      const candidate = resolveFn(directory, executableName);
      if (candidate === executablePath || !existsSyncFn(candidate)) continue;
      try {
        if (realpathSyncFn(candidate) === executableTarget) return candidate;
      } catch {
        // Ignore broken or inaccessible PATH entries.
      }
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

function windowsShellOptions(options = {}) {
  const { spawnSyncFn, powershellPath, env, existsSyncFn } = options;
  return { spawnSyncFn, powershellPath, env, existsSyncFn };
}

function installWindowsBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath,
  pathEnv = process.env.PATH,
  spawnSyncFn = spawnSync,
  powershellPath,
  env,
  existsSyncFn,
} = {}) {
  const shell = windowsShellOptions({ spawnSyncFn, powershellPath, env, existsSyncFn });
  const effectiveNodePath = nodePath ?? resolveStableNodePath(process.execPath, pathEnv);
  if (!existsSync(effectiveNodePath)) {
    throw new Error(`Node executable not found at ${effectiveNodePath}.`);
  }
  if (!existsSync(entryPath)) throw new Error(`Cribble CLI not found at ${entryPath}.`);

  const previous = queryWindowsTask(shell);
  const previousXml = previous.installed ? exportWindowsTask(shell) : null;
  const contents = scheduledTaskXml({
    nodePath: effectiveNodePath,
    entryPath,
    intervalMinutes,
    days,
    endpoint,
  });

  let newTaskRegistered = false;
  try {
    registerWindowsTask(contents, shell);
    newTaskRegistered = true;
    setWindowsTaskDisabled(false, shell);
    startWindowsTask(shell);
  } catch (error) {
    let rollbackError = null;
    try {
      if (previousXml === null) {
        if (newTaskRegistered) unregisterWindowsTask(shell);
      } else {
        registerWindowsTask(previousXml, shell);
        setWindowsTaskDisabled(previous.disabled, shell);
        if (previous.loaded && !previous.disabled) {
          startWindowsTask(shell);
        }
      }
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
    filePath: windowsTaskPath(),
    nodePath: effectiveNodePath,
    intervalMinutes,
    days,
    endpoint: endpoint ?? null,
  };
}

function pauseWindowsBackground(options = {}) {
  const shell = windowsShellOptions(options);
  setWindowsTaskDisabled(true, shell);
  try {
    stopWindowsTask(shell);
  } catch (error) {
    try {
      setWindowsTaskDisabled(false, shell);
    } catch (rollbackError) {
      throw new Error(
        `${safeText(error?.message, { fallback: "Pausing background sync failed." })} Rollback also failed: ${safeText(rollbackError?.message, { fallback: "unknown rollback failure" })}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function resumeWindowsBackground(options = {}) {
  const shell = windowsShellOptions(options);
  const previous = queryWindowsTask(shell);
  if (!previous.installed) {
    throw new Error("Background sync is not installed. Run `cribble background install` first.");
  }

  try {
    setWindowsTaskDisabled(false, shell);
    startWindowsTask(shell);
  } catch (error) {
    let rollbackError = null;
    try {
      setWindowsTaskDisabled(previous.disabled, shell);
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

function uninstallWindowsBackground(options = {}) {
  const shell = windowsShellOptions(options);
  const previous = queryWindowsTask(shell);
  if (previous.installed) {
    stopWindowsTask(shell);
    unregisterWindowsTask(shell);
  }
  return { removed: previous.installed, filePath: windowsTaskPath() };
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
  spawnSyncFn = spawnSync,
  powershellPath,
  env,
  existsSyncFn,
} = {}) {
  requireSupportedPlatform(platform);
  if (isWindows(platform)) {
    return installWindowsBackground({
      intervalMinutes,
      days,
      endpoint,
      entryPath,
      nodePath,
      pathEnv,
      spawnSyncFn,
      powershellPath,
      env,
      existsSyncFn,
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

function pauseBackground({
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
  powershellPath,
  env,
  existsSyncFn,
} = {}) {
  requireSupportedPlatform(platform);
  if (isWindows(platform)) {
    pauseWindowsBackground({ spawnSyncFn, powershellPath, env, existsSyncFn });
    return;
  }
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

function resumeBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
  powershellPath,
  env,
  existsSyncFn,
} = {}) {
  requireSupportedPlatform(platform);
  if (isWindows(platform)) {
    resumeWindowsBackground({ spawnSyncFn, powershellPath, env, existsSyncFn });
    return;
  }
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

function uninstallBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
  powershellPath,
  env,
  existsSyncFn,
} = {}) {
  requireSupportedPlatform(platform);
  if (isWindows(platform)) {
    return uninstallWindowsBackground({ spawnSyncFn, powershellPath, env, existsSyncFn });
  }
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

function backgroundStatus({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
  powershellPath,
  env,
  existsSyncFn,
} = {}) {
  requireSupportedPlatform(platform);
  if (isWindows(platform)) {
    return queryWindowsTask({ spawnSyncFn, powershellPath, env, existsSyncFn });
  }
  requireUid(uid);
  const filePath = launchAgentPath(homeDirectory);
  const installed = existsSync(filePath);
  const loaded = serviceIsLoaded(uid, { spawnSyncFn });
  const disabled = serviceIsDisabled(uid, { spawnSyncFn });

  return { installed, loaded, disabled, filePath };
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
  scheduledTaskXml,
  uninstallBackground,
  windowsTaskPath,
};
